/** 大脑一 · 记录员：会后纪要（需求 F-10 / 8.3） */
import { cards, meetings, minutesRepo, segments, type Segment } from '../db.js';
import { llmJson, prompt } from '../adapters/llm/index.js';
import { MinutesSchema, type MinutesOut } from './schemas.js';
import { toAll } from '../bus.js';

const CHUNK_MS = 15 * 60_000;
const SINGLE_PASS_CHARS = 60_000;

function minutesLanguage(meetingLang: string, segs: Segment[]) {
  if (meetingLang === 'zh' || meetingLang === 'en') return meetingLang;
  const zh = segs.filter((s) => s.lang !== 'en').length;
  return zh >= segs.length / 2 ? 'zh' : 'en';
}

const fmt = (s: Segment) => `${s.speaker_name ?? s.speaker_label ?? '?'}: ${s.text}${s.echo_of_card_id ? ` (围绕卡片 ${s.echo_of_card_id})` : ''}`;

export async function generateMinutes(meetingId: string): Promise<void> {
  const m = meetings.get(meetingId);
  if (!m) return;
  minutesRepo.setStatus(meetingId, 'generating');
  toAll(meetingId, 'minutes.status', { status: 'generating' });
  try {
    const segs = segments.list(meetingId).filter((s) => !s.is_command);
    const shown = cards.published(meetingId).map((c) => ({ id: c.id, type: c.type, title: c.title, body: c.body }));
    const language = minutesLanguage(m.language, segs);
    const system = prompt('minutes', { productName: '插一句 ChimeIn', language: language === 'zh' ? '中文' : 'English' });
    const meta = { userId: m.host_id, meetingId };
    const base = { title: m.title, agenda: m.agenda, counterparties: m.counterparties };
    let out: MinutesOut;
    const total = segs.reduce((n, s) => n + s.text.length, 0);
    const mockInput = { title: m.title, segments: segs.map((s) => ({ speaker: s.speaker_name ?? s.speaker_label ?? '?', text: s.text })), cards: shown };
    if (total <= SINGLE_PASS_CHARS) {
      out = (await llmJson({ role: 'minutes', system, schema: MinutesSchema, input: mockInput,
        user: JSON.stringify({ meeting: base, transcript: segs.map(fmt), cards: shown }) }, meta)).data;
    } else {
      // 超过上下文：按 15 分钟分段做小结，再合并
      const start = segs[0].created_at;
      const chunks: Segment[][] = [];
      for (const s of segs) (chunks[Math.floor((s.created_at - start) / CHUNK_MS)] ??= []).push(s);
      const partials: MinutesOut[] = [];
      for (const [i, c] of chunks.filter(Boolean).entries()) {
        partials.push((await llmJson({ role: 'minutes', system, schema: MinutesSchema, input: mockInput,
          user: JSON.stringify({ meeting: base, part: `第 ${i + 1} 段（约 15 分钟）`, transcript: c.map(fmt) }) }, meta)).data);
      }
      out = (await llmJson({ role: 'minutes', system, schema: MinutesSchema, input: mockInput,
        user: JSON.stringify({ meeting: base, instruction: '以下是按 15 分钟分段的小结，请合并成一份完整纪要，去重并保持待办原样。', partial_minutes: partials, cards: shown }) }, meta)).data;
    }
    const saved = minutesRepo.upsert({ meeting_id: meetingId, language, status: 'ready', ...out });
    toAll(meetingId, 'minutes.status', { status: 'ready', version: saved.version });
  } catch (e) {
    console.error('[minutes] failed', e);
    minutesRepo.setStatus(meetingId, 'failed');
    toAll(meetingId, 'minutes.status', { status: 'failed' });
  }
}

export function minutesToMarkdown(meetingId: string, opts: { includeTranscript?: boolean } = {}) {
  const m = meetings.get(meetingId)!;
  const mi = minutesRepo.get(meetingId);
  const en = mi?.language === 'en';
  const L = en
    ? { sum: 'Summary', topics: 'Topics & Conclusions', dec: 'Decisions', todo: 'Action Items', sp: 'Points by Speaker', cards: 'Brainstorm Cards', tr: 'Transcript', owner: 'Owner', due: 'Due' }
    : { sum: '会议概要', topics: '议题与结论', dec: '决定', todo: '待办', sp: '分人发言要点', cards: '本场脑暴卡回顾', tr: '转写全文', owner: '负责人', due: '时间' };
  const date = new Date(m.started_at ?? m.created_at).toISOString().slice(0, 16).replace('T', ' ');
  const lines: string[] = [`# ${m.title}`, '', `${date}${m.counterparties.length ? ` · ${m.counterparties.join(' / ')}` : ''}`, ''];
  if (mi && mi.status === 'ready') {
    lines.push(`## ${L.sum}`, '', mi.summary_md, '');
    if (mi.topics.length) lines.push(`## ${L.topics}`, '', ...mi.topics.map((t) => `- **${t.title}**：${t.conclusion}`), '');
    if (mi.decisions.length) lines.push(`## ${L.dec}`, '', ...mi.decisions.map((d) => `- ${d}`), '');
    if (mi.action_items.length) lines.push(`## ${L.todo}`, '', ...mi.action_items.map((a) => `- [ ] ${a.task}${a.owner ? `（${L.owner}：${a.owner}）` : ''}${a.due ? `（${L.due}：${a.due}）` : ''}`), '');
    if (mi.speaker_points.length) lines.push(`## ${L.sp}`, '', ...mi.speaker_points.flatMap((s) => [`**${s.speaker}**`, ...s.points.map((p) => `- ${p}`), '']));
  }
  // 对外分享与导出：只包含已上屏卡片
  const shown = cards.published(meetingId);
  if (shown.length) {
    lines.push(`## ${L.cards}`, '');
    for (const c of shown) {
      lines.push(`### ${c.title}`, '', c.body, ...c.bullets.map((b) => `- ${b}`));
      if (c.increment_text) lines.push(`> ${c.increment_text}`);
      if (c.sources.length) lines.push('', ...c.sources.map((s) => `[${s.title}](${s.url})`));
      lines.push('');
    }
  }
  if (opts.includeTranscript) {
    lines.push(`## ${L.tr}`, '', ...segments.list(meetingId).map((s) => `**${s.speaker_name ?? s.speaker_label ?? '?'}**：${s.text}`), '');
  }
  return lines.join('\n');
}
