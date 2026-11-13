/** REST 接口（需求 7.2） */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { z } from 'zod';
import { config, PRESETS, PRESET_IDS, type Preset } from '../config.js';
import {
  cards, materials, meetings, minutesRepo, participants, reactions, requests, segments, token, usage, users, type Meeting, type User,
} from '../db.js';
import { getRuntime } from '../pipeline/runtime.js';
import { generateMinutes, minutesToMarkdown } from '../pipeline/minutes.js';
import { runCardJob, onPublished } from '../pipeline/cardgen.js';
import { broadcastCard, publicCard, toAll, toHost } from '../bus.js';
import { loadTuning } from '../config.js';
import { asrMode } from '../adapters/asr/index.js';
import { clearSearchCache } from '../adapters/search/index.js';
import { extractText } from '../util/extract.js';

// ---------------- 鉴权 ----------------
function hashPassword(pw: string, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
}
function checkPassword(pw: string, stored: string | null) {
  if (!stored) return false;
  const [salt, h] = stored.split(':');
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), crypto.scryptSync(pw, salt, 32));
}
const bearer = (req: FastifyRequest) => (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || null;

export function hostUser(req: FastifyRequest): User | undefined {
  const t = bearer(req);
  return t ? users.bySession(t) : undefined;
}

type Who = { role: 'host'; user: User } | { role: 'guest'; pid: string; nickname: string } | { role: 'screen' };
/** 识别请求方身份：主持人 Bearer token / 参会者 x-participant-token / 大屏 x-screen-key */
function who(req: FastifyRequest, m: Meeting): Who | null {
  const u = hostUser(req);
  if (u && u.id === m.host_id) return { role: 'host', user: u };
  const pt = req.headers['x-participant-token'];
  if (typeof pt === 'string') {
    const p = participants.byToken(pt);
    if (p && p.meeting_id === m.id) return { role: 'guest', pid: p.id, nickname: p.nickname };
  }
  if (req.headers['x-screen-key'] === m.screen_key) return { role: 'screen' };
  return null;
}

function hasFeature(user: User, f: string) {
  return (users.plan(user.plan_id)?.features ?? []).includes(f);
}

const fail = (reply: FastifyReply, code: number, error: string) => reply.code(code).send({ error });

function meetingLinks(m: Meeting) {
  const base = config.publicUrl;
  return {
    join: `${base}/m/${m.id}`,
    screen: `${base}/m/${m.id}/screen?k=${m.screen_key}`,
    host: `${base}/m/${m.id}/host`,
  };
}

function meetingView(m: Meeting, role: Who['role']) {
  const base = {
    id: m.id, title: m.title, preset: m.preset, status: m.status, language: m.language, card_language: m.card_language,
    counterparties: m.counterparties, started_at: m.started_at, ended_at: m.ended_at, join_code: m.join_code,
    settings: { frequency: m.settings.frequency, aiPaused: m.settings.aiPaused, subtitles: m.settings.subtitles },
    audience: PRESETS[m.preset].audience,
    elapsedMs: getRuntime(m.id)?.elapsedMs() ?? (m.started_at && m.ended_at ? m.ended_at - m.started_at - m.paused_ms : 0),
    links: { join: meetingLinks(m).join },
  };
  if (role !== 'host') return base;
  return { ...base, agenda: m.agenda, is_important: m.is_important, settings: m.settings, share_token: m.share_token, links: meetingLinks(m), created_at: m.created_at };
}

const CreateMeeting = z.object({
  title: z.string().min(1).max(200),
  preset: z.enum(PRESET_IDS as [Preset, ...Preset[]]),
  agenda: z.string().max(5000).optional().nullable(),
  counterparties: z.array(z.string().max(100)).max(20).default([]),
  language: z.enum(['zh', 'en', 'auto']).default('auto'),
  card_language: z.enum(['zh', 'en', 'bilingual']).default('zh'),
  is_important: z.boolean().default(false),
  background: z.string().max(50_000).optional().nullable(),
});

export async function apiRoutes(app: FastifyInstance) {
  // ---------- 账号（F-01）----------
  // MVP 先实现邮箱 + 密码；Google / Apple / 手机验证码 / 微信登录作为 auth_provider 扩展接入。
  app.post('/api/auth/register', async (req, reply) => {
    const b = z.object({ email: z.string().email(), password: z.string().min(8), name: z.string().max(100).optional(), locale: z.enum(['zh', 'en']).default('zh') }).parse(req.body);
    if (users.byEmail(b.email.toLowerCase())) return fail(reply, 409, 'email_taken');
    const u = users.create({ email: b.email.toLowerCase(), phone: null, name: b.name ?? null, auth_provider: 'password', password_hash: hashPassword(b.password), region: config.region, locale: b.locale });
    return { token: users.newSession(u.id), user: { id: u.id, email: u.email, name: u.name, region: u.region, locale: u.locale } };
  });
  app.post('/api/auth/login', async (req, reply) => {
    const b = z.object({ email: z.string(), password: z.string() }).parse(req.body);
    const u = users.byEmail(b.email.toLowerCase());
    if (!u || !checkPassword(b.password, u.password_hash)) return fail(reply, 401, 'invalid_credentials');
    return { token: users.newSession(u.id), user: { id: u.id, email: u.email, name: u.name, region: u.region, locale: u.locale } };
  });
  app.post('/api/auth/logout', async (req) => { const t = bearer(req); if (t) users.deleteSession(t); return { ok: true }; });
  app.get('/api/me', async (req, reply) => {
    const u = hostUser(req);
    if (!u) return fail(reply, 401, 'unauthorized');
    return { id: u.id, email: u.email, name: u.name, region: u.region, locale: u.locale, plan: users.plan(u.plan_id) };
  });
  app.get('/api/config', async () => ({ region: config.region, asrMode: asrMode(), presets: Object.fromEntries(PRESET_IDS.map((p) => [p, { audience: PRESETS[p].audience }])),
    wakeWords: loadTuning().wakeWords, providers: { judge: config.llm.judge.provider, generate: config.llm.generate.provider, search: config.search.provider, asr: config.asr.provider } }));

  // ---------- 会议 ----------
  app.post('/api/meetings', async (req, reply) => {
    const u = hostUser(req);
    if (!u) return fail(reply, 401, 'unauthorized');
    const b = CreateMeeting.parse(req.body);
    const m = meetings.create({ host_id: u.id, title: b.title, preset: b.preset as Preset, agenda: b.agenda ?? null,
      counterparties: b.counterparties.map((s) => s.trim()).filter(Boolean), language: b.language, card_language: b.card_language, is_important: b.is_important });
    if (b.background?.trim()) materials.insert(m.id, 'text', b.background.trim(), null, null);
    if (m.counterparties.length && hasFeature(u, 'preload')) preload(m).catch((e) => console.error('[preload]', e));
    return { meeting: meetingView(m, 'host'), qr: await QRCode.toDataURL(meetingLinks(m).join, { margin: 1, width: 360 }) };
  });

  app.get('/api/meetings', async (req, reply) => {
    const u = hostUser(req);
    if (!u) return fail(reply, 401, 'unauthorized');
    const q = (req.query as any).q as string | undefined;
    return meetings.listByHost(u.id, q).map((m) => ({
      id: m.id, title: m.title, preset: m.preset, status: m.status, counterparties: m.counterparties, created_at: m.created_at,
      started_at: m.started_at, ended_at: m.ended_at, duration_ms: m.started_at ? (m.ended_at ?? Date.now()) - m.started_at - m.paused_ms : 0,
      card_count: m.card_count,
    }));
  });

  /** 拉取会议当前完整状态（进入页面、断线重连补齐用），按角色过滤 */
  app.get('/api/meetings/:id', async (req, reply) => {
    const m = meetings.get((req.params as any).id);
    if (!m) return fail(reply, 404, 'not_found');
    const w = who(req, m);
    if (!w) return fail(reply, 403, 'forbidden');
    const allCards = cards.list(m.id).filter((c) => w.role === 'host' || c.status === 'published').map(publicCard);
    const out: any = { meeting: meetingView(m, w.role), cards: allCards, requests: requests.list(m.id).filter((r) => r.status !== 'cancelled' || w.role === 'host'),
      role: w.role, minutesStatus: minutesRepo.get(m.id)?.status ?? null };
    if (w.role === 'guest') {
      out.me = { id: w.pid, nickname: w.nickname };
      out.myReactions = reactions.mine(m.id, w.pid);
    }
    if (w.role === 'host') {
      out.transcript = segments.list(m.id).slice(-500);
      out.qr = await QRCode.toDataURL(meetingLinks(m).join, { margin: 1, width: 360 });
      out.speakers = segments.speakers(m.id);
      out.materials = materials.list(m.id).map((x) => ({ id: x.id, kind: x.kind, file_name: x.file_name, chars: x.content_text.length }));
      out.metrics = meetingMetrics(m.id);
    }
    if (w.role === 'screen') out.qr = await QRCode.toDataURL(meetingLinks(m).join, { margin: 1, width: 360 });
    return out;
  });

  app.patch('/api/meetings/:id', async (req, reply) => {
    const m = meetings.get((req.params as any).id);
    if (!m) return fail(reply, 404, 'not_found');
    if (who(req, m)?.role !== 'host') return fail(reply, 403, 'forbidden');
    const b = z.object({
      status: z.enum(['live', 'paused', 'ended']).optional(),
      title: z.string().min(1).max(200).optional(), agenda: z.string().max(5000).nullable().optional(),
      is_important: z.boolean().optional(), card_language: z.enum(['zh', 'en', 'bilingual']).optional(),
      settings: z.object({
        frequency: z.enum(['quiet', 'standard', 'active']).optional(), aiPaused: z.boolean().optional(), subtitles: z.boolean().optional(),
        wakeWords: z.array(z.string().min(1).max(30)).max(6).optional(), minutesVisibleToGuests: z.boolean().optional(),
      }).optional(),
      consent: z.boolean().optional(),
    }).parse(req.body);
    if (m.status === 'ended' && b.status && b.status !== 'ended') return fail(reply, 409, 'meeting_ended');
    const { status, consent, ...rest } = b;
    let next = meetings.update(m.id, rest as Partial<Meeting>)!;
    const rt = getRuntime(m.id);
    if (status === 'live') {
      if (!m.started_at && !consent) return fail(reply, 400, 'consent_required'); // 开始前强制告知参会方
      next = rt!.start();
    } else if (status === 'paused') next = rt!.pause();
    else if (status === 'ended') next = await rt!.end();
    else rt?.broadcastState();
    return { meeting: meetingView(next, 'host') };
  });

  app.delete('/api/meetings/:id', async (req, reply) => {
    const m = meetings.get((req.params as any).id);
    if (!m) return fail(reply, 404, 'not_found');
    if (who(req, m)?.role !== 'host') return fail(reply, 403, 'forbidden');
    if (m.status !== 'ended') await getRuntime(m.id)?.end().catch(() => {});
    for (const ext of ['pcm', 'wav']) { try { fs.unlinkSync(path.join(config.dataDir, 'audio', `${m.id}.${ext}`)); } catch { /* none */ } }
    fs.rmSync(path.join(config.dataDir, 'uploads', m.id), { recursive: true, force: true });
    clearSearchCache(m.id);
    meetings.delete(m.id);
    toAll(m.id, 'meeting.deleted', {});
    return { ok: true };
  });

  // ---------- 加入（F-03）----------
  app.post('/api/join', async (req, reply) => {
    const b = z.object({ code: z.string().regex(/^\d{6}$/), nickname: z.string().trim().min(1).max(30), meetingId: z.string().optional() }).parse(req.body);
    const m = meetings.byCode(b.code);
    if (!m || (b.meetingId && m.id !== b.meetingId)) return fail(reply, 404, 'invalid_code');
    const host = users.get(m.host_id)!;
    const limit = users.plan(host.plan_id)?.limits?.maxParticipants;
    if (limit && participants.countGuests(m.id) >= limit) return fail(reply, 403, 'meeting_full');
    const p = participants.create(m.id, b.nickname, 'guest');
    toHost(m.id, 'participant.join', { id: p.id, nickname: p.nickname });
    return { meetingId: m.id, participantToken: p.token, participant: { id: p.id, nickname: p.nickname } };
  });

  // ---------- 背景资料 ----------
  app.post('/api/meetings/:id/materials', async (req, reply) => {
    const m = meetings.get((req.params as any).id);
    if (!m) return fail(reply, 404, 'not_found');
    if (who(req, m)?.role !== 'host') return fail(reply, 403, 'forbidden');
    if (req.isMultipart()) {
      const file = await req.file();
      if (!file) return fail(reply, 400, 'no_file');
      const buf = await file.toBuffer();
      const dir = path.join(config.dataDir, 'uploads', m.id);
      fs.mkdirSync(dir, { recursive: true });
      const safe = file.filename.replace(/[^\w.\-一-龥]/g, '_');
      fs.writeFileSync(path.join(dir, safe), buf);
      const text = await extractText(buf, safe);
      if (!text.trim()) return fail(reply, 422, 'unreadable_file');
      return materials.insert(m.id, 'file', text, `uploads/${m.id}/${safe}`, file.filename);
    }
    const b = z.object({ text: z.string().min(1).max(100_000) }).parse(req.body);
    return materials.insert(m.id, 'text', b.text, null, null);
  });

  // ---------- 卡片 ----------
  app.get('/api/meetings/:id/cards', async (req, reply) => {
    const m = meetings.get((req.params as any).id);
    if (!m) return fail(reply, 404, 'not_found');
    const w = who(req, m);
    if (!w) return fail(reply, 403, 'forbidden');
    const since = Number((req.query as any).since ?? 0);
    return cards.list(m.id, since).filter((c) => w.role === 'host' || c.status === 'published').map(publicCard);
  });

  app.patch('/api/cards/:id', async (req, reply) => {
    const c = cards.get((req.params as any).id);
    if (!c) return fail(reply, 404, 'not_found');
    const m = meetings.get(c.meeting_id)!;
    if (who(req, m)?.role !== 'host') return fail(reply, 403, 'forbidden');
    const b = z.object({ status: z.enum(['published', 'hidden']).optional(), pinned: z.boolean().optional(), focused: z.boolean().optional() }).parse(req.body);
    if (b.focused) cards.clearFocus(m.id);
    const next = cards.update(c.id, b)!;
    if (b.status === 'published' && c.status !== 'published') {
      await onPublished(next);
      const r = c.request_id ? requests.get(c.request_id) : undefined;
      if (r) requests.update(r.id, { status: 'published' });
    }
    broadcastCard(next, 'update');
    if (b.focused !== undefined) toAll(m.id, 'card.focus', { id: b.focused ? c.id : null });
    return publicCard(next);
  });

  app.post('/api/cards/:id/reactions', async (req, reply) => {
    const c = cards.get((req.params as any).id);
    if (!c) return fail(reply, 404, 'not_found');
    const m = meetings.get(c.meeting_id)!;
    const w = who(req, m);
    if (!w || w.role === 'screen') return fail(reply, 403, 'forbidden');
    const b = z.object({ kind: z.enum(['useful', 'irrelevant', 'saved']), on: z.boolean().default(true) }).parse(req.body);
    reactions.set(c.id, w.role === 'host' ? `host:${w.user.id}` : w.pid, b.kind, b.on);
    const counts = reactions.counts(c.id);
    toAll(m.id, 'card.reactions', { id: c.id, reactions: counts });
    return counts;
  });

  app.post('/api/cards/:id/deepdive', async (req, reply) => {
    const c = cards.get((req.params as any).id);
    if (!c) return fail(reply, 404, 'not_found');
    const m = meetings.get(c.meeting_id)!;
    const w = who(req, m);
    if (!w || w.role === 'screen') return fail(reply, 403, 'forbidden');
    const rt = getRuntime(m.id);
    if (!rt || m.status !== 'live') return fail(reply, 409, 'meeting_not_live');
    rt.deepdive(c, w.role === 'guest' ? w.nickname : null).catch((e) => console.error('[deepdive]', e));
    return { ok: true };
  });

  // ---------- 提问与预约（F-13 / F-14）----------
  app.post('/api/meetings/:id/questions', async (req, reply) => {
    const m = meetings.get((req.params as any).id);
    if (!m) return fail(reply, 404, 'not_found');
    const w = who(req, m);
    if (!w || w.role === 'screen') return fail(reply, 403, 'forbidden');
    const b = z.object({ text: z.string().trim().min(2).max(500) }).parse(req.body);
    const rt = getRuntime(m.id);
    if (!rt || m.status !== 'live') return fail(reply, 409, 'meeting_not_live');
    return rt.handleCommand(b.text, { channel: 'text', requestedBy: w.role === 'guest' ? w.nickname : '主持人', forceNow: true, isQuestion: true });
  });

  app.post('/api/meetings/:id/requests', async (req, reply) => {
    const m = meetings.get((req.params as any).id);
    if (!m) return fail(reply, 404, 'not_found');
    const w = who(req, m);
    if (!w || w.role === 'screen') return fail(reply, 403, 'forbidden');
    const b = z.object({ text: z.string().trim().min(2).max(500) }).parse(req.body);
    const rt = getRuntime(m.id);
    if (!rt || m.status !== 'live') return fail(reply, 409, 'meeting_not_live');
    return rt.handleCommand(b.text, { channel: 'text', requestedBy: w.role === 'guest' ? w.nickname : '主持人' });
  });

  app.get('/api/meetings/:id/requests', async (req, reply) => {
    const m = meetings.get((req.params as any).id);
    if (!m) return fail(reply, 404, 'not_found');
    if (!who(req, m)) return fail(reply, 403, 'forbidden');
    return requests.list(m.id);
  });

  app.patch('/api/requests/:id', async (req, reply) => {
    const r = requests.get((req.params as any).id);
    if (!r) return fail(reply, 404, 'not_found');
    const m = meetings.get(r.meeting_id)!;
    const w = who(req, m);
    if (!w || w.role === 'screen') return fail(reply, 403, 'forbidden');
    // 参会者只能改自己的预约；主持人可以改全部
    if (w.role === 'guest' && r.requested_by !== w.nickname) return fail(reply, 403, 'forbidden');
    const b = z.object({ action: z.enum(['cancel', 'show_now', 'edit']), text: z.string().min(2).max(500).optional() }).parse(req.body);
    const rt = getRuntime(m.id);
    if (!rt) return fail(reply, 409, 'meeting_not_live');
    if (b.action === 'cancel') return rt.cancelRequest(r.id);
    if (b.action === 'show_now') { await rt.fulfillRequest(r, { publish: true }); return requests.get(r.id); }
    // edit：取消原预约，按新文字重新解析
    rt.cancelRequest(r.id);
    return rt.handleCommand(b.text ?? r.request_text, { channel: 'text', requestedBy: r.requested_by });
  });

  // ---------- 主持人辅助操作 ----------
  app.post('/api/meetings/:id/summary-now', async (req, reply) => {
    const m = meetings.get((req.params as any).id);
    if (!m) return fail(reply, 404, 'not_found');
    if (who(req, m)?.role !== 'host') return fail(reply, 403, 'forbidden');
    const rt = getRuntime(m.id);
    if (!rt || m.status !== 'live') return fail(reply, 409, 'meeting_not_live');
    rt.makeSummary('host').catch((e) => console.error('[summary]', e));
    return { ok: true };
  });

  /** 文字模拟发言：没有麦克风/测试时使用；browser 识别模式下主持人浏览器也通过 socket 发 final */
  app.post('/api/meetings/:id/transcript', async (req, reply) => {
    const m = meetings.get((req.params as any).id);
    if (!m) return fail(reply, 404, 'not_found');
    if (who(req, m)?.role !== 'host') return fail(reply, 403, 'forbidden');
    const b = z.object({ text: z.string().min(1).max(2000), speaker: z.string().max(40).optional() }).parse(req.body);
    const rt = getRuntime(m.id);
    if (!rt || m.status !== 'live') return fail(reply, 409, 'meeting_not_live');
    return rt.onFinal({ text: b.text, speaker: b.speaker ?? 'S1', lang: null, startMs: null, endMs: null });
  });

  app.post('/api/meetings/:id/judge-now', async (req, reply) => {
    const m = meetings.get((req.params as any).id);
    if (!m) return fail(reply, 404, 'not_found');
    if (who(req, m)?.role !== 'host') return fail(reply, 403, 'forbidden');
    const rt = getRuntime(m.id);
    if (!rt || m.status !== 'live') return fail(reply, 409, 'meeting_not_live');
    await rt.judge(true);
    return { ok: true };
  });

  app.post('/api/meetings/:id/speakers', async (req, reply) => {
    const m = meetings.get((req.params as any).id);
    if (!m) return fail(reply, 404, 'not_found');
    if (who(req, m)?.role !== 'host') return fail(reply, 403, 'forbidden');
    const b = z.object({ label: z.string().min(1), name: z.string().trim().min(1).max(40) }).parse(req.body);
    segments.renameSpeaker(m.id, b.label, b.name);
    toHost(m.id, 'speaker.renamed', b);
    // 纪要同步更新：已生成的纪要里替换说话人名称
    const mi = minutesRepo.get(m.id);
    if (mi && mi.status === 'ready') {
      const rep = (s: string) => s.split(b.label).join(b.name);
      minutesRepo.upsert({ ...mi, summary_md: rep(mi.summary_md), speaker_points: mi.speaker_points.map((p) => ({ ...p, speaker: rep(p.speaker) })),
        action_items: mi.action_items.map((a) => ({ ...a, owner: a.owner ? rep(a.owner) : a.owner })) });
    }
    return { ok: true };
  });

  // ---------- 纪要（F-10）----------
  app.get('/api/meetings/:id/minutes', async (req, reply) => {
    const m = meetings.get((req.params as any).id);
    if (!m) return fail(reply, 404, 'not_found');
    const w = who(req, m);
    if (!w) return fail(reply, 403, 'forbidden');
    if (w.role !== 'host' && !m.settings.minutesVisibleToGuests) return fail(reply, 403, 'minutes_private');
    const shown = cards.published(m.id).map(publicCard).sort((a, b) => b.reactions.useful - a.reactions.useful);
    return { meeting: meetingView(m, w.role), minutes: minutesRepo.get(m.id) ?? null, cards: shown,
      transcript: w.role === 'host' ? segments.list(m.id) : undefined, speakers: w.role === 'host' ? segments.speakers(m.id) : undefined,
      usage: w.role === 'host' ? usage.byMeeting(m.id) : undefined, metrics: w.role === 'host' ? meetingMetrics(m.id) : undefined };
  });

  app.put('/api/meetings/:id/minutes', async (req, reply) => {
    const m = meetings.get((req.params as any).id);
    if (!m) return fail(reply, 404, 'not_found');
    if (who(req, m)?.role !== 'host') return fail(reply, 403, 'forbidden');
    const b = z.object({
      summary_md: z.string(), topics: z.array(z.object({ title: z.string(), conclusion: z.string() })), decisions: z.array(z.string()),
      action_items: z.array(z.object({ task: z.string(), owner: z.string().nullable(), due: z.string().nullable() })),
      speaker_points: z.array(z.object({ speaker: z.string(), points: z.array(z.string()) })),
    }).parse(req.body);
    return minutesRepo.upsert({ meeting_id: m.id, language: minutesRepo.get(m.id)?.language ?? null, status: 'ready', ...b });
  });

  app.post('/api/meetings/:id/minutes/regenerate', async (req, reply) => {
    const m = meetings.get((req.params as any).id);
    if (!m) return fail(reply, 404, 'not_found');
    if (who(req, m)?.role !== 'host') return fail(reply, 403, 'forbidden');
    if (m.status !== 'ended') return fail(reply, 409, 'meeting_not_ended');
    generateMinutes(m.id).catch(() => {});
    return { ok: true };
  });

  // ---------- 分享与导出（F-18）：只含已上屏卡片 ----------
  app.post('/api/meetings/:id/share', async (req, reply) => {
    const m = meetings.get((req.params as any).id);
    if (!m) return fail(reply, 404, 'not_found');
    if (who(req, m)?.role !== 'host') return fail(reply, 403, 'forbidden');
    const b = z.object({ enabled: z.boolean().default(true) }).parse(req.body ?? {});
    const next = meetings.update(m.id, { share_token: b.enabled ? (m.share_token ?? token()) : null })!;
    return { share_token: next.share_token, url: next.share_token ? `${config.publicUrl}/s/${next.share_token}` : null };
  });

  app.get('/api/share/:token', async (req, reply) => {
    const m = meetings.byShare((req.params as any).token);
    if (!m) return fail(reply, 404, 'not_found');
    return { meeting: { title: m.title, started_at: m.started_at, ended_at: m.ended_at, counterparties: m.counterparties },
      minutes: minutesRepo.get(m.id) ?? null, cards: cards.published(m.id).map((c) => ({ ...c, trigger_segment_ids: [], asked_by: null })) };
  });

  app.get('/api/meetings/:id/export', async (req, reply) => {
    const m = meetings.get((req.params as any).id);
    if (!m) return fail(reply, 404, 'not_found');
    if (who(req, m)?.role !== 'host') return fail(reply, 403, 'forbidden');
    const format = ((req.query as any).format ?? 'md') as string;
    if (format !== 'md') return fail(reply, 501, 'format_not_supported_yet'); // docx / pdf 在 M2 实现；PDF 可先用会后页"打印"
    const md = minutesToMarkdown(m.id, { includeTranscript: (req.query as any).transcript === '1' });
    reply.header('content-type', 'text/markdown; charset=utf-8');
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(m.title)}.md`);
    return md;
  });

  // ---------- 用量（F-27）----------
  app.get('/api/usage', async (req, reply) => {
    const u = hostUser(req);
    if (!u) return fail(reply, 401, 'unauthorized');
    return { plan: users.plan(u.plan_id), month: usage.monthly(u.id) };
  });
}

/** 贯穿全程的核心指标：有用率、无关率、出卡数、复述数、预约成功率 */
function meetingMetrics(mid: string) {
  const all = cards.list(mid);
  const shown = all.filter((c) => c.status === 'published');
  const totals = reactions.meetingTotals(mid);
  const reqs = requests.list(mid);
  const segs = segments.list(mid);
  const voted = totals.useful + totals.irrelevant;
  const latencies = shown.filter((c) => c.trigger_segment_ids.length && c.published_at).map((c) => {
    const s = segs.find((x) => x.id === c.trigger_segment_ids.at(-1));
    return s ? c.published_at! - s.created_at : null;
  }).filter((x): x is number => x != null).sort((a, b) => a - b);
  return {
    cardsShown: shown.length, cardsTotal: all.length,
    usefulRate: voted ? totals.useful / voted : null, irrelevantRate: voted ? totals.irrelevant / voted : null,
    echoSegments: segs.filter((s) => s.echo_of_card_id).length,
    requests: reqs.length, requestsFulfilled: reqs.filter((r) => r.status === 'published').length,
    p90CardLatencyMs: latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.9))] : null,
  };
}

/** F-16 会前预加载：参会方主体速览卡，状态 standby，会中提到时直接上屏 */
async function preload(m: Meeting) {
  for (const cp of m.counterparties.slice(0, 5)) {
    const res = await runCardJob(m, {
      type: 'entity_brief', origin: 'preload', triggerQuote: cp, searchQueries: [cp, m.card_language === 'en' ? `${cp} company` : `${cp} 公司 业务`],
      entities: [cp], parentCardId: null, needsReview: true, segmentIds: [], window: [], forceStatus: 'standby',
    }, loadTuning());
    if ('dropped' in res) console.info('[preload] dropped', cp, res.dropped);
  }
}
