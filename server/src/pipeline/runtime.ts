/**
 * 会议运行时：一场会议一个实例。负责
 * 收音/转写入库 → 复述过滤与指令识别 → 定时判定 → 出卡 → 预约调度 → 会后纪要。
 */
import fs from 'node:fs';
import path from 'node:path';
import { cards, meetings, requests, segments, usage, type Card, type CardRequest, type Meeting, type Segment } from '../db.js';
import { config, loadTuning, PRESETS, type CardType, type Tuning } from '../config.js';
import { llmJson, prompt } from '../adapters/llm/index.js';
import { createAsrSession, asrMode, type AsrSession, type FinalSegment } from '../adapters/asr/index.js';
import { JudgeSchema, CommandSchema, type JudgeOut, type CommandOut } from './schemas.js';
import { detectEcho } from './echo.js';
import { runCardJob, onPublished, type CardJob } from './cardgen.js';
import { generateMinutes } from './minutes.js';
import { broadcastCard, broadcastRequest, toAll, toHost } from '../bus.js';
import { reactions } from '../db.js';

const runtimes = new Map<string, MeetingRuntime>();

export function getRuntime(mid: string): MeetingRuntime | undefined {
  let rt = runtimes.get(mid);
  if (!rt) {
    const m = meetings.get(mid);
    if (!m || m.status === 'ended') return undefined;
    rt = new MeetingRuntime(mid);
    runtimes.set(mid, rt);
  }
  return rt;
}

export function shutdownAll() { for (const rt of runtimes.values()) rt.dispose(); }

type AiState = 'listening' | 'thinking' | 'paused';

export class MeetingRuntime {
  readonly id: string;
  tuning: Tuning = loadTuning();
  private timer: NodeJS.Timeout;
  private asr: AsrSession | null = null;
  private audioFile: fs.WriteStream | null = null;
  private audioBytes = 0;
  private lastJudgeAt = 0;
  private lastJudgedSegAt = 0;
  private lastAutoCardAt = 0;
  private lastSummaryAt = 0;
  private lastFinalAt = Date.now();
  private judging = false;
  private thinking = new Map<string, string>(); // jobKey → 正在查的主题
  private pausedAt: number | null = null;

  constructor(id: string) {
    this.id = id;
    const m = this.meeting;
    this.lastSummaryAt = m.started_at ?? Date.now();
    this.lastAutoCardAt = 0;
    if (m.status === 'paused') this.pausedAt = Date.now();
    this.timer = setInterval(() => this.tick().catch((e) => console.error('[tick]', e)), 2000);
  }

  get meeting(): Meeting { return meetings.get(this.id)!; }

  // ---------------- 会议生命周期 ----------------
  start() {
    const m = this.meeting;
    if (m.status === 'live') return m;
    const t = Date.now();
    let patch: Partial<Meeting> = { status: 'live' };
    if (!m.started_at) { patch.started_at = t; this.lastSummaryAt = t; }
    if (this.pausedAt) { patch.paused_ms = m.paused_ms + (t - this.pausedAt); this.pausedAt = null; }
    const next = meetings.update(this.id, patch)!;
    this.openAudio();
    this.broadcastState();
    return next;
  }

  pause() {
    const next = meetings.update(this.id, { status: 'paused' })!;
    this.pausedAt = Date.now();
    this.closeAsr();
    this.broadcastState();
    return next;
  }

  async end() {
    const m = this.meeting;
    if (m.status === 'ended') return m;
    const t = Date.now();
    // "会议结束前列一下待办"类预约：结束时执行
    for (const r of requests.list(this.id).filter((r) => r.mode === 'at_time' && r.topic === '__end__' && r.status === 'queued')) {
      await this.fulfillRequest(r).catch(() => {});
    }
    const paused_ms = this.pausedAt ? m.paused_ms + (t - this.pausedAt) : m.paused_ms;
    this.closeAsr();
    const audio = this.closeAudio();
    const next = meetings.update(this.id, {
      status: 'ended', ended_at: t, paused_ms,
      audio_url: audio, audio_expires_at: audio ? t + 14 * 24 * 3600_000 : null, // 原始录音保留 14 天
    })!;
    const durMin = m.started_at ? (t - m.started_at - paused_ms) / 60_000 : 0;
    usage.record(m.host_id, m.id, 'meeting_minutes', +durMin.toFixed(2));
    this.broadcastState();
    this.dispose();
    runtimes.delete(this.id);
    generateMinutes(this.id).catch((e) => console.error('[minutes]', e));
    return next;
  }

  dispose() { clearInterval(this.timer); this.closeAsr(); }

  elapsedMs(m = this.meeting) {
    if (!m.started_at) return 0;
    const end = m.ended_at ?? Date.now();
    const pausedNow = this.pausedAt && m.status === 'paused' ? end - this.pausedAt : 0;
    return Math.max(0, end - m.started_at - m.paused_ms - pausedNow);
  }

  broadcastState() {
    const m = this.meeting;
    toAll(this.id, 'meeting.state', {
      status: m.status, elapsedMs: this.elapsedMs(m), startedAt: m.started_at, aiPaused: m.settings.aiPaused,
      frequency: m.settings.frequency, subtitles: m.settings.subtitles, title: m.title,
    });
    this.emitAiStatus();
  }

  emitAiStatus() {
    const m = this.meeting;
    let state: AiState = 'listening';
    if (m.status !== 'live' || m.settings.aiPaused) state = 'paused';
    else if (this.thinking.size) state = 'thinking';
    toAll(this.id, 'ai.status', { state, topic: [...this.thinking.values()].at(-1) ?? null });
  }

  // ---------------- 收音 ----------------
  private openAudio() {
    if (!this.audioFile) {
      const file = path.join(config.dataDir, 'audio', `${this.id}.pcm`);
      this.audioFile = fs.createWriteStream(file, { flags: 'a' });
      try { this.audioBytes = fs.statSync(file).size; } catch { this.audioBytes = 0; }
    }
  }

  private closeAudio(): string | null {
    const pcm = path.join(config.dataDir, 'audio', `${this.id}.pcm`);
    this.audioFile?.end(); this.audioFile = null;
    if (!fs.existsSync(pcm) || fs.statSync(pcm).size === 0) { try { fs.unlinkSync(pcm); } catch { /* none */ } return null; }
    const data = fs.readFileSync(pcm);
    const wav = path.join(config.dataDir, 'audio', `${this.id}.wav`);
    fs.writeFileSync(wav, Buffer.concat([wavHeader(data.length), data]));
    fs.unlinkSync(pcm);
    return `audio/${this.id}.wav`;
  }

  private ensureAsr() {
    if (this.asr || asrMode() !== 'server') return;
    const m = this.meeting;
    this.asr = createAsrSession({ language: m.language, hints: [...m.counterparties, ...(m.settings.wakeWords ?? this.tuning.wakeWords.zh.concat(this.tuning.wakeWords.en))] }, {
      onPartial: (text, speaker) => toHost(this.id, 'transcript.partial', { text, speaker }),
      onFinal: (seg) => { this.onFinal(seg).catch((e) => console.error('[final]', e)); },
      onError: (e) => { console.warn('[asr]', e.message); toHost(this.id, 'asr.error', { message: e.message }); },
    });
  }

  private closeAsr() { this.asr?.close(); this.asr = null; }

  /** 主持人浏览器发来的 PCM16 16k 单声道音频包（约 100ms 一包） */
  onAudio(chunk: Buffer) {
    if (this.meeting.status !== 'live') return;
    this.audioFile?.write(chunk);
    this.audioBytes += chunk.length;
    this.ensureAsr();
    this.asr?.push(chunk);
    // 每满 1 分钟音频记一次转写用量
    const perMin = 16000 * 2 * 60;
    if (asrMode() === 'server' && Math.floor(this.audioBytes / perMin) > Math.floor((this.audioBytes - chunk.length) / perMin)) {
      usage.record(this.meeting.host_id, this.id, 'asr_minutes', 1, 0.006);
    }
  }

  // ---------------- 转写入库：复述过滤 + 指令识别（6.1 第 3 步）----------------
  async onFinal(f: FinalSegment, opts: { speakerName?: string } = {}) {
    const m = this.meeting;
    if (m.status !== 'live') return null;
    const text = f.text.trim();
    if (!text) return null;
    this.lastFinalAt = Date.now();
    const wake = this.matchWakeWord(text);
    const echo = wake ? null : await detectEcho(this.id, text, this.tuning);
    const seg = segments.insert({
      meeting_id: this.id, speaker_label: f.speaker, speaker_name: opts.speakerName ?? null, text, lang: f.lang ?? guessLang(text),
      start_ms: f.startMs, end_ms: f.endMs, is_final: true, echo_of_card_id: echo?.cardId ?? null, is_command: !!wake,
    });
    toHost(this.id, 'transcript.final', seg);
    if (m.settings.subtitles) toAll(this.id, 'subtitle', { text, speaker: seg.speaker_name ?? seg.speaker_label });

    if (wake && !m.settings.aiPaused) {
      this.handleCommand(wake, { channel: 'voice', requestedBy: seg.speaker_name ?? seg.speaker_label, segmentId: seg.id }).catch((e) => console.error('[command]', e));
      return seg;
    }
    if (!echo) {
      this.checkPreloaded(text);
      this.checkTopicRequests([seg]);
    }
    return seg;
  }

  private matchWakeWord(text: string): string | null {
    const words = this.meeting.settings.wakeWords?.length ? this.meeting.settings.wakeWords : [...this.tuning.wakeWords.zh, ...this.tuning.wakeWords.en];
    const lower = text.toLowerCase();
    for (const w of words) {
      const i = lower.replace(/\s+/g, ' ').indexOf(w.toLowerCase());
      if (i >= 0) {
        const rest = text.slice(i + w.length).replace(/^[\s,，。.:：、!！]+/, '').trim();
        if (rest.length >= 2) return text;
      }
    }
    return null;
  }

  // ---------------- 指令与预约（4.4 / 8.4）----------------
  async handleCommand(text: string, ctx: { channel: 'voice' | 'text'; requestedBy: string | null; segmentId?: string; forceNow?: boolean; isQuestion?: boolean }) {
    const m = this.meeting;
    const window = this.window();
    const res = await llmJson<CommandOut>({
      role: 'command', system: prompt('command', { productName: '插一句 ChimeIn' }),
      user: JSON.stringify({ instruction: text, recent_transcript: window.slice(-8).map((s) => `${s.speaker_name ?? s.speaker_label ?? '?'}: ${s.text}`) }),
      schema: CommandSchema, input: { text },
    }, { userId: m.host_id, meetingId: m.id });
    const c = res.data;
    const mode = ctx.forceNow ? 'now' : c.mode;
    const endOfMeeting = mode === 'at_time' && c.due_in_seconds == null;
    const req = requests.insert({
      meeting_id: this.id, requested_by: ctx.requestedBy, channel: ctx.channel, request_text: text, parsed_intent: c,
      mode, topic: endOfMeeting ? '__end__' : c.topic, due_at: mode === 'at_time' && c.due_in_seconds != null ? Date.now() + c.due_in_seconds * 1000 : null,
      card_type: (ctx.isQuestion ? 'answer' : c.card_type) as CardType | null, status: 'queued', card_id: null,
    });
    // 收到确认：2 秒内在大屏和手机显示"已收到：准备 XX"
    toAll(this.id, 'request.ack', { request: req, summary: c.request_summary, needsClarification: c.needs_clarification });
    broadcastRequest(req);
    if (mode === 'now' || mode === 'later') this.fulfillRequest(req).catch((e) => console.error('[request]', e));
    return req;
  }

  async fulfillRequest(r: CardRequest, opts: { publish?: boolean } = {}) {
    const cur = requests.get(r.id);
    if (!cur || ['cancelled', 'published', 'preparing'].includes(cur.status)) return;
    // 已就绪的稍后卡：直接展示
    if (cur.status === 'ready' && cur.card_id) return this.publishReady(cur);
    broadcastRequest(requests.update(r.id, { status: 'preparing' })!);
    const intent = cur.parsed_intent as CommandOut | null;
    const window = this.window();
    const type = (cur.card_type ?? 'answer') as CardType;
    const job: CardJob = {
      type, origin: cur.channel === 'text' && type === 'answer' ? 'question' : cur.channel === 'voice' ? 'command' : 'request',
      triggerQuote: cur.request_text, searchQueries: intent?.search_queries ?? [], entities: [], parentCardId: null, needsReview: false,
      segmentIds: [], window, question: cur.request_text, askedBy: cur.requested_by, requestId: cur.id,
      forceStatus: cur.mode === 'later' && !opts.publish ? 'ready' : undefined,
    };
    if (type === 'discussion_summary') job.window = segments.since(this.id, this.lastSummaryAt);
    const res = await this.track(intent?.request_summary ?? cur.request_text, () => runCardJob(this.meeting, job, this.tuning));
    if ('dropped' in res) {
      console.info('[request] dropped', cur.id, res.dropped);
      broadcastRequest(requests.update(cur.id, { status: 'failed' })!);
      return;
    }
    if (type === 'discussion_summary') this.lastSummaryAt = Date.now();
    broadcastRequest(requests.update(cur.id, { status: res.card.status === 'ready' ? 'ready' : 'published', card_id: res.card.id })!);
  }

  async publishReady(r: CardRequest) {
    if (!r.card_id) return;
    const card = cards.update(r.card_id, { status: 'published' });
    if (!card) return;
    await onPublished(card);
    broadcastCard(card, 'update');
    broadcastRequest(requests.update(r.id, { status: 'published' })!);
  }

  cancelRequest(rid: string) {
    const r = requests.update(rid, { status: 'cancelled' });
    if (r?.card_id) { const c = cards.update(r.card_id, { status: 'cancelled' }); if (c) broadcastCard(c, 'update'); }
    if (r) broadcastRequest(r);
    return r;
  }

  private checkTopicRequests(newSegs: Segment[], matchedId?: string | null) {
    const text = newSegs.map((s) => s.text).join(' ').toLowerCase();
    for (const r of requests.list(this.id)) {
      if (r.mode !== 'on_topic' || r.status !== 'queued') continue;
      if (r.id === matchedId || (r.topic && text.includes(r.topic.toLowerCase()))) {
        this.fulfillRequest(r, { publish: true }).catch((e) => console.error('[topic]', e));
      }
    }
  }

  /** 预加载的主体速览卡：会中提到该主体时直接上屏（≤3 秒） */
  private checkPreloaded(text: string) {
    const lower = text.toLowerCase();
    for (const c of cards.list(this.id)) {
      if (c.status !== 'standby' || c.origin !== 'preload') continue;
      if (c.entities.some((e) => e && lower.includes(e.toLowerCase()))) {
        const next = cards.update(c.id, { status: this.meeting.is_important ? 'pending_review' : 'published' })!;
        if (next.status === 'published') onPublished(next).catch(() => {});
        broadcastCard(next, next.status === 'pending_review' ? 'new' : 'update');
      }
    }
  }

  // ---------------- 判定（4.3 / 8.1）----------------
  private window(): Segment[] {
    return segments.since(this.id, Date.now() - this.tuning.windowMs);
  }

  minIntervalMs() {
    const m = this.meeting;
    return PRESETS[m.preset].minIntervalMs * this.tuning.frequency[m.settings.frequency].intervalFactor;
  }

  private async tick() {
    const m = this.meeting;
    if (!m || m.status !== 'live') return;
    const t = Date.now();
    if (Math.floor(t / 1000) % 10 === 0) toAll(this.id, 'meeting.state', { status: m.status, elapsedMs: this.elapsedMs(m), startedAt: m.started_at,
      aiPaused: m.settings.aiPaused, frequency: m.settings.frequency, subtitles: m.settings.subtitles, title: m.title });
    if (m.settings.aiPaused) return;

    // 定时预约到点
    for (const r of requests.list(this.id)) {
      if (r.mode === 'at_time' && r.status === 'queued' && r.due_at && r.due_at <= t) this.fulfillRequest(r, { publish: true }).catch(() => {});
    }
    // 稍后卡：话题空档（一段时间没人说话）或距上张卡已过间隔 → 上屏
    const ready = requests.list(this.id).filter((r) => r.mode === 'later' && r.status === 'ready');
    if (ready.length && (t - this.lastFinalAt >= this.tuning.laterAutoShowSilenceMs)) {
      await this.publishReady(ready[0]);
    }
    // 讨论小结：每 15-20 分钟
    if (t - this.lastSummaryAt >= this.tuning.summaryEveryMs && segments.since(this.id, this.lastSummaryAt).length >= 10) {
      this.lastSummaryAt = t;
      this.makeSummary('auto').catch((e) => console.error('[summary]', e));
    }
    // 定时评估：每 30 秒
    if (t - this.lastJudgeAt >= this.tuning.judgeEveryMs) await this.judge();
  }

  async judge(force = false) {
    if (this.judging) return;
    const m = this.meeting;
    const t = Date.now();
    this.lastJudgeAt = t;
    const win = this.window().filter((s) => !s.is_command);
    const fresh = win.filter((s) => s.created_at > this.lastJudgedSegAt && !s.echo_of_card_id);
    if (!fresh.length && !force) return;
    this.judging = true;
    try {
      this.lastJudgedSegAt = win.at(-1)?.created_at ?? this.lastJudgedSegAt;
      const shown = cards.published(this.id);
      const feedback = reactions.byType(this.id);
      const pendingTopic = requests.list(this.id).filter((r) => r.mode === 'on_topic' && r.status === 'queued');
      const preset = PRESETS[m.preset];
      const zh = m.card_language !== 'en';
      const system = prompt('judge', {
        productName: '插一句 ChimeIn', title: m.title, preset: m.preset, persona: preset.persona[zh ? 'zh' : 'en'],
        preferred: preset.preferred.join(', '), agenda: m.agenda ?? '-', counterparties: m.counterparties.join('、') || '-', guidance: preset.guidance ?? '-',
      });
      const transcript = win.map((s) => s.echo_of_card_id
        ? `[卡片 ${s.echo_of_card_id} 已被读出]`
        : `${s.speaker_name ?? s.speaker_label ?? '?'}: ${s.text}`);
      const user = JSON.stringify({
        recent_3min_transcript: transcript,
        shown_cards: shown.map((c) => ({ id: c.id, type: c.type, title: c.title, body: c.body, bullets: c.bullets, increment: c.increment_text })),
        pending_topic_requests: pendingTopic.map((r) => ({ id: r.id, topic: r.topic, request: r.request_text })),
        feedback_by_card_type: feedback,
        seconds_since_last_card: this.lastAutoCardAt ? Math.round((t - this.lastAutoCardAt) / 1000) : null,
      }, null, 1);
      const res = await llmJson<JudgeOut>({ role: 'judge', system, user, schema: JudgeSchema,
        input: { window: win.filter((s) => !s.echo_of_card_id), counterparties: m.counterparties, pendingTopicRequests: pendingTopic } },
        { userId: m.host_id, meetingId: m.id });
      const j = res.data;
      toHost(this.id, 'judge.result', { at: t, ...j });

      if (j.matched_request_id) this.checkTopicRequests([], j.matched_request_id);
      if (j.is_instruction && j.instruction_text) {
        this.handleCommand(j.instruction_text, { channel: 'voice', requestedBy: null }).catch(() => {});
        return;
      }
      if (!j.should_card || !j.card_type) return;

      // 门槛：阈值按频率档位和反馈调整
      const fb = feedback[j.card_type] ?? { useful: 0, irrelevant: 0 };
      const penalty = Math.max(0, fb.irrelevant - fb.useful) * this.tuning.irrelevantPenaltyPerVote;
      const threshold = this.tuning.valueThreshold + this.tuning.frequency[m.settings.frequency].thresholdDelta + penalty;
      if (j.value_score < threshold) return;
      // 间隔：两张自动卡之间不小于预设间隔
      if (!force && this.lastAutoCardAt && t - this.lastAutoCardAt < this.minIntervalMs()) return;

      const type: CardType = j.parent_card_id && cards.get(j.parent_card_id) ? 'iteration' : j.card_type;
      this.lastAutoCardAt = t; // 先占位，避免并发再次出卡
      const job: CardJob = {
        type, origin: 'auto', triggerQuote: j.trigger_quote, searchQueries: j.search_queries, entities: j.entities,
        parentCardId: type === 'iteration' ? j.parent_card_id : null, needsReview: j.needs_review,
        segmentIds: fresh.map((s) => s.id), window: win,
      };
      const out = await this.track(j.search_queries[0] ?? j.trigger_quote, () => runCardJob(m, job, this.tuning));
      if ('dropped' in out) {
        console.info('[judge] card dropped:', out.dropped);
        this.lastAutoCardAt = 0;
      }
    } catch (e) {
      console.error('[judge]', (e as Error).message);
      toAll(this.id, 'ai.status', { state: 'away', topic: null }); // AI 暂时离席，不影响转写保存
      setTimeout(() => this.emitAiStatus(), 5000);
    } finally {
      this.judging = false;
    }
  }

  async makeSummary(origin: 'auto' | 'host') {
    const m = this.meeting;
    const win = segments.since(this.id, origin === 'host' ? Math.min(this.lastSummaryAt, Date.now() - 20 * 60_000) : this.lastSummaryAt - 60_000)
      .filter((s) => !s.is_command);
    this.lastSummaryAt = Date.now();
    if (!win.length) return { dropped: 'no transcript' } as const;
    return this.track(m.card_language === 'en' ? 'summary' : '讨论小结', () => runCardJob(m, {
      type: 'discussion_summary', origin: 'summary', triggerQuote: '', searchQueries: [], entities: [], parentCardId: null,
      needsReview: false, segmentIds: [], window: win,
    }, this.tuning));
  }

  async deepdive(card: Card, askedBy: string | null) {
    return this.track(card.title, () => runCardJob(this.meeting, {
      type: card.type === 'iteration' ? 'knowledge' : card.type, origin: 'deepdive', triggerQuote: card.title,
      searchQueries: [card.title, ...card.entities].slice(0, 2), entities: card.entities, parentCardId: card.id,
      needsReview: false, segmentIds: [], window: this.window(), question: `深挖：${card.title}`, askedBy, detailed: true,
    }, this.tuning));
  }

  private async track<T>(topic: string, fn: () => Promise<T>): Promise<T> {
    const key = Math.random().toString(36).slice(2);
    this.thinking.set(key, topic.slice(0, 40));
    this.emitAiStatus();
    try { return await fn(); } finally { this.thinking.delete(key); this.emitAiStatus(); }
  }
}

function guessLang(text: string) {
  const han = (text.match(/\p{Script=Han}/gu) ?? []).length;
  const latin = (text.match(/[a-zA-Z]+/g) ?? []).length;
  return han === 0 ? 'en' : latin > han / 2 ? 'mixed' : 'zh';
}

function wavHeader(dataLen: number, sampleRate = 16000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataLen, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(dataLen, 40);
  return h;
}
