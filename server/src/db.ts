/**
 * 数据层（需求 7.1 的 12 张表）。
 * MVP 开发阶段使用 Node 内置 SQLite，零依赖即可跑通；所有读写都集中在本文件，
 * 上线前可整体替换为 PostgreSQL + pgvector，而不影响业务代码。
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { customAlphabet } from 'nanoid';
import { config, type CardType, type Preset, type Frequency } from './config.js';

export const db = new DatabaseSync(path.join(config.dataDir, 'chimein.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, price REAL NOT NULL DEFAULT 0, billing_period TEXT,
  limits TEXT NOT NULL DEFAULT '{}', features TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT, email TEXT UNIQUE, phone TEXT UNIQUE, auth_provider TEXT NOT NULL,
  password_hash TEXT, region TEXT NOT NULL, locale TEXT NOT NULL DEFAULT 'zh', plan_id TEXT NOT NULL REFERENCES plans(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY, host_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL,
  preset TEXT NOT NULL, agenda TEXT, counterparties TEXT NOT NULL DEFAULT '[]', join_code TEXT NOT NULL,
  screen_key TEXT NOT NULL, share_token TEXT, language TEXT NOT NULL DEFAULT 'auto', card_language TEXT NOT NULL DEFAULT 'zh',
  is_important INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'draft', settings TEXT NOT NULL DEFAULT '{}',
  audio_url TEXT, audio_expires_at INTEGER, started_at INTEGER, ended_at INTEGER, paused_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS meetings_live_code ON meetings(join_code) WHERE status != 'ended';
CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, nickname TEXT NOT NULL,
  role TEXT NOT NULL, token TEXT NOT NULL UNIQUE, joined_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS transcript_segments (
  id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, speaker_label TEXT,
  speaker_name TEXT, text TEXT NOT NULL, lang TEXT, start_ms INTEGER, end_ms INTEGER, is_final INTEGER NOT NULL DEFAULT 1,
  echo_of_card_id TEXT, is_command INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS seg_meeting ON transcript_segments(meeting_id, created_at);
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, type TEXT NOT NULL,
  language TEXT, title TEXT NOT NULL, body TEXT NOT NULL, bullets TEXT NOT NULL DEFAULT '[]', sources TEXT NOT NULL DEFAULT '[]',
  confidence REAL, trigger_quote TEXT, trigger_segment_ids TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0, focused INTEGER NOT NULL DEFAULT 0, origin TEXT NOT NULL, parent_card_id TEXT,
  version INTEGER NOT NULL DEFAULT 1, increment_text TEXT, request_id TEXT, asked_by TEXT, entities TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL, published_at INTEGER, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cards_meeting ON cards(meeting_id, updated_at);
CREATE TABLE IF NOT EXISTS card_requests (
  id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, requested_by TEXT,
  channel TEXT NOT NULL, request_text TEXT NOT NULL, parsed_intent TEXT, mode TEXT NOT NULL, topic TEXT, due_at INTEGER,
  card_type TEXT, status TEXT NOT NULL, card_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS card_embeddings (
  card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  text TEXT NOT NULL, embedding TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS card_reactions (
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE, participant_id TEXT NOT NULL, kind TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY (card_id, participant_id, kind)
);
CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, kind TEXT NOT NULL,
  content_text TEXT NOT NULL, file_url TEXT, file_name TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS minutes (
  meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE, language TEXT, summary_md TEXT NOT NULL DEFAULT '',
  topics TEXT NOT NULL DEFAULT '[]', decisions TEXT NOT NULL DEFAULT '[]', action_items TEXT NOT NULL DEFAULT '[]',
  speaker_points TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending', version INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, meeting_id TEXT, kind TEXT NOT NULL,
  quantity REAL NOT NULL, cost_estimate REAL NOT NULL DEFAULT 0, detail TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_user ON usage_records(user_id, created_at);
`);

// MVP：所有用户默认内测套餐，只记录用量（需求第十节）。套餐内容放配置，不写死在代码里。
db.prepare(`INSERT OR IGNORE INTO plans (id,name,price,billing_period,limits,features) VALUES (?,?,?,?,?,?)`).run(
  'beta', 'Beta', 0, null,
  JSON.stringify({ monthlyMinutes: null, maxParticipants: 30, maxMeetingMinutes: 240 }),
  JSON.stringify(['auto_cards', 'questions', 'minutes', 'voice_requests', 'deepdive', 'export', 'review_queue', 'preload']),
);

export const id = customAlphabet('23456789abcdefghjkmnpqrstuvwxyz', 12);
export const token = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 32);
export const code6 = customAlphabet('0123456789', 6);
export const now = () => Date.now();

// ---------- 类型 ----------
export type CardStatus = 'standby' | 'pending_review' | 'ready' | 'published' | 'hidden' | 'cancelled';
export type CardOrigin = 'auto' | 'question' | 'command' | 'request' | 'deepdive' | 'preload' | 'summary';
export interface Source { title: string; url: string }

export interface Meeting {
  id: string; host_id: string; title: string; preset: Preset; agenda: string | null; counterparties: string[];
  join_code: string; screen_key: string; share_token: string | null; language: 'zh' | 'en' | 'auto';
  card_language: 'zh' | 'en' | 'bilingual'; is_important: boolean;
  status: 'draft' | 'live' | 'paused' | 'ended';
  settings: { frequency: Frequency; aiPaused: boolean; subtitles: boolean; wakeWords?: string[]; minutesVisibleToGuests: boolean };
  audio_url: string | null; audio_expires_at: number | null; started_at: number | null; ended_at: number | null;
  paused_ms: number; created_at: number;
}
export interface Card {
  id: string; meeting_id: string; type: CardType; language: string | null; title: string; body: string; bullets: string[];
  sources: Source[]; confidence: number | null; trigger_quote: string | null; trigger_segment_ids: string[];
  status: CardStatus; pinned: boolean; focused: boolean; origin: CardOrigin; parent_card_id: string | null; version: number;
  increment_text: string | null; request_id: string | null; asked_by: string | null; entities: string[];
  created_at: number; published_at: number | null; updated_at: number;
}
export interface Segment {
  id: string; meeting_id: string; speaker_label: string | null; speaker_name: string | null; text: string; lang: string | null;
  start_ms: number | null; end_ms: number | null; is_final: boolean; echo_of_card_id: string | null; is_command: boolean; created_at: number;
}
export interface CardRequest {
  id: string; meeting_id: string; requested_by: string | null; channel: 'voice' | 'text'; request_text: string;
  parsed_intent: any; mode: 'now' | 'later' | 'on_topic' | 'at_time'; topic: string | null; due_at: number | null;
  card_type: CardType | null; status: 'queued' | 'preparing' | 'ready' | 'published' | 'cancelled' | 'failed';
  card_id: string | null; created_at: number; updated_at: number;
}
export interface Participant { id: string; meeting_id: string; nickname: string; role: 'host' | 'guest' | 'screen'; token: string; joined_at: number; last_seen_at: number }
export interface User { id: string; name: string | null; email: string | null; phone: string | null; auth_provider: string; password_hash: string | null; region: string; locale: string; plan_id: string; created_at: number }

// ---------- 序列化 ----------
const J = (v: unknown) => JSON.stringify(v ?? null);
const P = <T>(v: unknown, d: T): T => { try { return v == null ? d : JSON.parse(String(v)); } catch { return d; } };

function rowMeeting(r: any): Meeting | undefined {
  if (!r) return undefined;
  return { ...r, counterparties: P(r.counterparties, []), settings: P(r.settings, {}), is_important: !!r.is_important };
}
function rowCard(r: any): Card | undefined {
  if (!r) return undefined;
  return {
    ...r, bullets: P(r.bullets, []), sources: P(r.sources, []), trigger_segment_ids: P(r.trigger_segment_ids, []),
    entities: P(r.entities, []), pinned: !!r.pinned, focused: !!r.focused,
  };
}
function rowSeg(r: any): Segment { return { ...r, is_final: !!r.is_final, is_command: !!r.is_command }; }
function rowReq(r: any): CardRequest | undefined { return r ? { ...r, parsed_intent: P(r.parsed_intent, null) } : undefined; }

// ---------- 用户 / 会话 ----------
export const users = {
  create(u: Omit<User, 'id' | 'created_at' | 'plan_id'>): User {
    const user: User = { ...u, id: id(), plan_id: 'beta', created_at: now() };
    db.prepare(`INSERT INTO users (id,name,email,phone,auth_provider,password_hash,region,locale,plan_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(user.id, user.name, user.email, user.phone, user.auth_provider, user.password_hash, user.region, user.locale, user.plan_id, user.created_at);
    return user;
  },
  byEmail: (email: string) => db.prepare('SELECT * FROM users WHERE email = ?').get(email) as User | undefined,
  get: (uid: string) => db.prepare('SELECT * FROM users WHERE id = ?').get(uid) as User | undefined,
  newSession(uid: string) {
    const t = token();
    db.prepare('INSERT INTO sessions (token,user_id,created_at) VALUES (?,?,?)').run(t, uid, now());
    return t;
  },
  bySession: (t: string) => db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(t) as User | undefined,
  deleteSession: (t: string) => db.prepare('DELETE FROM sessions WHERE token = ?').run(t),
  plan: (planId: string) => {
    const r: any = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
    return r ? { ...r, limits: P(r.limits, {}), features: P<string[]>(r.features, []) } : undefined;
  },
};

// ---------- 会议 ----------
export const meetings = {
  create(m: Pick<Meeting, 'host_id' | 'title' | 'preset' | 'agenda' | 'counterparties' | 'language' | 'card_language' | 'is_important'>): Meeting {
    let join_code = code6();
    while (db.prepare(`SELECT 1 FROM meetings WHERE join_code = ? AND status != 'ended'`).get(join_code)) join_code = code6();
    const meeting: Meeting = {
      ...m, id: id(), join_code, screen_key: token(), share_token: null, status: 'draft',
      settings: { frequency: 'standard', aiPaused: false, subtitles: false, minutesVisibleToGuests: false },
      audio_url: null, audio_expires_at: null, started_at: null, ended_at: null, paused_ms: 0, created_at: now(),
    };
    db.prepare(`INSERT INTO meetings (id,host_id,title,preset,agenda,counterparties,join_code,screen_key,language,card_language,is_important,status,settings,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      meeting.id, meeting.host_id, meeting.title, meeting.preset, meeting.agenda, J(meeting.counterparties), meeting.join_code,
      meeting.screen_key, meeting.language, meeting.card_language, meeting.is_important ? 1 : 0, meeting.status, J(meeting.settings), meeting.created_at,
    );
    return meeting;
  },
  get: (mid: string) => rowMeeting(db.prepare('SELECT * FROM meetings WHERE id = ?').get(mid)),
  byCode: (code: string) => rowMeeting(db.prepare(`SELECT * FROM meetings WHERE join_code = ? AND status != 'ended'`).get(code)),
  byShare: (t: string) => rowMeeting(db.prepare('SELECT * FROM meetings WHERE share_token = ?').get(t)),
  listByHost(hostId: string, q?: string) {
    const rows = db.prepare(`SELECT m.*, (SELECT COUNT(*) FROM cards c WHERE c.meeting_id = m.id AND c.status = 'published') AS card_count
      FROM meetings m WHERE host_id = ? ORDER BY created_at DESC`).all(hostId) as any[];
    let list = rows.map((r) => ({ ...rowMeeting(r)!, card_count: r.card_count as number }));
    if (q) {
      const s = q.toLowerCase();
      list = list.filter((m) => m.title.toLowerCase().includes(s) || m.counterparties.some((c) => c.toLowerCase().includes(s))
        || (m.agenda ?? '').toLowerCase().includes(s) || new Date(m.created_at).toISOString().slice(0, 10).includes(s));
    }
    return list;
  },
  update(mid: string, patch: Partial<Meeting>) {
    const cur = meetings.get(mid);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, settings: { ...cur.settings, ...(patch.settings ?? {}) } };
    db.prepare(`UPDATE meetings SET title=?,preset=?,agenda=?,counterparties=?,language=?,card_language=?,is_important=?,status=?,settings=?,
      share_token=?,audio_url=?,audio_expires_at=?,started_at=?,ended_at=?,paused_ms=?,join_code=? WHERE id=?`).run(
      next.title, next.preset, next.agenda, J(next.counterparties), next.language, next.card_language, next.is_important ? 1 : 0, next.status,
      J(next.settings), next.share_token, next.audio_url, next.audio_expires_at, next.started_at, next.ended_at, next.paused_ms, next.join_code, mid,
    );
    return next;
  },
  delete: (mid: string) => db.prepare('DELETE FROM meetings WHERE id = ?').run(mid),
  expiredAudio: () => db.prepare('SELECT * FROM meetings WHERE audio_url IS NOT NULL AND audio_expires_at < ?').all(now()).map(rowMeeting) as Meeting[],
};

// ---------- 参会者 ----------
export const participants = {
  create(meetingId: string, nickname: string, role: Participant['role']): Participant {
    const p: Participant = { id: id(), meeting_id: meetingId, nickname, role, token: token(), joined_at: now(), last_seen_at: now() };
    db.prepare('INSERT INTO participants (id,meeting_id,nickname,role,token,joined_at,last_seen_at) VALUES (?,?,?,?,?,?,?)')
      .run(p.id, p.meeting_id, p.nickname, p.role, p.token, p.joined_at, p.last_seen_at);
    return p;
  },
  byToken: (t: string) => db.prepare('SELECT * FROM participants WHERE token = ?').get(t) as Participant | undefined,
  get: (pid: string) => db.prepare('SELECT * FROM participants WHERE id = ?').get(pid) as Participant | undefined,
  countGuests: (mid: string) => (db.prepare(`SELECT COUNT(*) n FROM participants WHERE meeting_id = ? AND role = 'guest'`).get(mid) as any).n as number,
  touch: (pid: string) => db.prepare('UPDATE participants SET last_seen_at = ? WHERE id = ?').run(now(), pid),
};

// ---------- 转写 ----------
export const segments = {
  insert(s: Omit<Segment, 'id' | 'created_at'> & { created_at?: number }): Segment {
    const seg: Segment = { ...s, id: id(), created_at: s.created_at ?? now() };
    db.prepare(`INSERT INTO transcript_segments (id,meeting_id,speaker_label,speaker_name,text,lang,start_ms,end_ms,is_final,echo_of_card_id,is_command,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(seg.id, seg.meeting_id, seg.speaker_label, seg.speaker_name, seg.text, seg.lang, seg.start_ms,
      seg.end_ms, seg.is_final ? 1 : 0, seg.echo_of_card_id, seg.is_command ? 1 : 0, seg.created_at);
    return seg;
  },
  list: (mid: string) => (db.prepare('SELECT * FROM transcript_segments WHERE meeting_id = ? ORDER BY created_at').all(mid) as any[]).map(rowSeg),
  since: (mid: string, ts: number) =>
    (db.prepare('SELECT * FROM transcript_segments WHERE meeting_id = ? AND created_at >= ? ORDER BY created_at').all(mid, ts) as any[]).map(rowSeg),
  renameSpeaker(mid: string, label: string, name: string) {
    db.prepare('UPDATE transcript_segments SET speaker_name = ? WHERE meeting_id = ? AND speaker_label = ?').run(name, mid, label);
  },
  speakers: (mid: string) => db.prepare(`SELECT speaker_label, MAX(speaker_name) AS speaker_name, COUNT(*) AS n FROM transcript_segments
      WHERE meeting_id = ? AND speaker_label IS NOT NULL GROUP BY speaker_label`).all(mid) as { speaker_label: string; speaker_name: string | null; n: number }[],
};

// ---------- 卡片 ----------
export const cards = {
  insert(c: Omit<Card, 'id' | 'created_at' | 'updated_at' | 'published_at' | 'pinned' | 'focused' | 'version'> & Partial<Pick<Card, 'version'>>): Card {
    const t = now();
    const card: Card = { ...c, id: id(), pinned: false, focused: false, version: c.version ?? 1, created_at: t, updated_at: t,
      published_at: c.status === 'published' ? t : null };
    db.prepare(`INSERT INTO cards (id,meeting_id,type,language,title,body,bullets,sources,confidence,trigger_quote,trigger_segment_ids,status,pinned,focused,
      origin,parent_card_id,version,increment_text,request_id,asked_by,entities,created_at,published_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      card.id, card.meeting_id, card.type, card.language, card.title, card.body, J(card.bullets), J(card.sources), card.confidence,
      card.trigger_quote, J(card.trigger_segment_ids), card.status, 0, 0, card.origin, card.parent_card_id, card.version,
      card.increment_text, card.request_id, card.asked_by, J(card.entities), card.created_at, card.published_at, card.updated_at,
    );
    return card;
  },
  get: (cid: string) => rowCard(db.prepare('SELECT * FROM cards WHERE id = ?').get(cid)),
  list: (mid: string, since = 0) =>
    (db.prepare('SELECT * FROM cards WHERE meeting_id = ? AND updated_at >= ? ORDER BY created_at').all(mid, since) as any[]).map((r) => rowCard(r)!),
  published: (mid: string) =>
    (db.prepare(`SELECT * FROM cards WHERE meeting_id = ? AND status = 'published' ORDER BY published_at`).all(mid) as any[]).map((r) => rowCard(r)!),
  update(cid: string, patch: Partial<Card>) {
    const cur = cards.get(cid);
    if (!cur) return undefined;
    const next: Card = { ...cur, ...patch, updated_at: now() };
    if (patch.status === 'published' && !cur.published_at) next.published_at = now();
    db.prepare(`UPDATE cards SET status=?,pinned=?,focused=?,published_at=?,updated_at=?,title=?,body=?,bullets=?,sources=? WHERE id=?`).run(
      next.status, next.pinned ? 1 : 0, next.focused ? 1 : 0, next.published_at, next.updated_at, next.title, next.body, J(next.bullets), J(next.sources), cid,
    );
    return next;
  },
  clearFocus: (mid: string) => db.prepare('UPDATE cards SET focused = 0, updated_at = ? WHERE meeting_id = ? AND focused = 1').run(now(), mid),
};

export const embeddings = {
  put(cardId: string, meetingId: string, text: string, vec: number[]) {
    db.prepare('INSERT OR REPLACE INTO card_embeddings (card_id,meeting_id,text,embedding,created_at) VALUES (?,?,?,?,?)')
      .run(cardId, meetingId, text, J(vec), now());
  },
  recent(mid: string, limit: number) {
    return (db.prepare('SELECT * FROM card_embeddings WHERE meeting_id = ? ORDER BY created_at DESC LIMIT ?').all(mid, limit) as any[])
      .map((r) => ({ card_id: r.card_id as string, text: r.text as string, embedding: P<number[]>(r.embedding, []) }));
  },
};

export const reactions = {
  set(cardId: string, pid: string, kind: 'useful' | 'irrelevant' | 'saved', on: boolean) {
    if (kind !== 'saved' && on) {
      const other = kind === 'useful' ? 'irrelevant' : 'useful';
      db.prepare('DELETE FROM card_reactions WHERE card_id = ? AND participant_id = ? AND kind = ?').run(cardId, pid, other);
    }
    if (on) db.prepare('INSERT OR IGNORE INTO card_reactions (card_id,participant_id,kind,created_at) VALUES (?,?,?,?)').run(cardId, pid, kind, now());
    else db.prepare('DELETE FROM card_reactions WHERE card_id = ? AND participant_id = ? AND kind = ?').run(cardId, pid, kind);
  },
  counts(cardId: string) {
    const rows = db.prepare('SELECT kind, COUNT(*) n FROM card_reactions WHERE card_id = ? GROUP BY kind').all(cardId) as any[];
    const out = { useful: 0, irrelevant: 0, saved: 0 };
    for (const r of rows) (out as any)[r.kind] = r.n;
    return out;
  },
  mine: (mid: string, pid: string) => db.prepare(`SELECT r.card_id, r.kind FROM card_reactions r JOIN cards c ON c.id = r.card_id
      WHERE c.meeting_id = ? AND r.participant_id = ?`).all(mid, pid) as { card_id: string; kind: string }[],
  byType(mid: string) {
    const rows = db.prepare(`SELECT c.type, r.kind, COUNT(*) n FROM card_reactions r JOIN cards c ON c.id = r.card_id
      WHERE c.meeting_id = ? AND r.kind != 'saved' GROUP BY c.type, r.kind`).all(mid) as any[];
    const out: Record<string, { useful: number; irrelevant: number }> = {};
    for (const r of rows) (out[r.type] ??= { useful: 0, irrelevant: 0 })[r.kind as 'useful' | 'irrelevant'] = r.n;
    return out;
  },
  meetingTotals(mid: string) {
    const r = db.prepare(`SELECT
      SUM(CASE WHEN r.kind='useful' THEN 1 ELSE 0 END) useful, SUM(CASE WHEN r.kind='irrelevant' THEN 1 ELSE 0 END) irrelevant
      FROM card_reactions r JOIN cards c ON c.id = r.card_id WHERE c.meeting_id = ?`).get(mid) as any;
    return { useful: r?.useful ?? 0, irrelevant: r?.irrelevant ?? 0 };
  },
};

export const requests = {
  insert(r: Omit<CardRequest, 'id' | 'created_at' | 'updated_at'>): CardRequest {
    const t = now();
    const req: CardRequest = { ...r, id: id(), created_at: t, updated_at: t };
    db.prepare(`INSERT INTO card_requests (id,meeting_id,requested_by,channel,request_text,parsed_intent,mode,topic,due_at,card_type,status,card_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.id, req.meeting_id, req.requested_by, req.channel, req.request_text, J(req.parsed_intent),
      req.mode, req.topic, req.due_at, req.card_type, req.status, req.card_id, t, t);
    return req;
  },
  get: (rid: string) => rowReq(db.prepare('SELECT * FROM card_requests WHERE id = ?').get(rid)),
  list: (mid: string) => (db.prepare('SELECT * FROM card_requests WHERE meeting_id = ? ORDER BY created_at').all(mid) as any[]).map((r) => rowReq(r)!),
  update(rid: string, patch: Partial<CardRequest>) {
    const cur = requests.get(rid);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, updated_at: now() };
    db.prepare('UPDATE card_requests SET mode=?,topic=?,due_at=?,card_type=?,status=?,card_id=?,request_text=?,updated_at=? WHERE id=?')
      .run(next.mode, next.topic, next.due_at, next.card_type, next.status, next.card_id, next.request_text, next.updated_at, rid);
    return next;
  },
};

export const materials = {
  insert(mid: string, kind: 'text' | 'file', content_text: string, file_url: string | null, file_name: string | null) {
    const m = { id: id(), meeting_id: mid, kind, content_text, file_url, file_name, created_at: now() };
    db.prepare('INSERT INTO materials (id,meeting_id,kind,content_text,file_url,file_name,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(m.id, mid, kind, content_text, file_url, file_name, m.created_at);
    return m;
  },
  list: (mid: string) => db.prepare('SELECT id,meeting_id,kind,content_text,file_url,file_name,created_at FROM materials WHERE meeting_id = ?').all(mid) as any[],
};

export interface Minutes {
  meeting_id: string; language: string | null; summary_md: string; topics: { title: string; conclusion: string }[];
  decisions: string[]; action_items: { task: string; owner: string | null; due: string | null }[];
  speaker_points: { speaker: string; points: string[] }[]; status: 'pending' | 'generating' | 'ready' | 'failed'; version: number; updated_at: number;
}
export const minutesRepo = {
  get(mid: string): Minutes | undefined {
    const r: any = db.prepare('SELECT * FROM minutes WHERE meeting_id = ?').get(mid);
    if (!r) return undefined;
    return { ...r, topics: P(r.topics, []), decisions: P(r.decisions, []), action_items: P(r.action_items, []), speaker_points: P(r.speaker_points, []) };
  },
  upsert(m: Omit<Minutes, 'updated_at' | 'version'> & { version?: number }) {
    const cur = minutesRepo.get(m.meeting_id);
    const version = m.version ?? (cur ? cur.version + 1 : 1);
    db.prepare(`INSERT INTO minutes (meeting_id,language,summary_md,topics,decisions,action_items,speaker_points,status,version,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(meeting_id) DO UPDATE SET language=excluded.language, summary_md=excluded.summary_md,
      topics=excluded.topics, decisions=excluded.decisions, action_items=excluded.action_items, speaker_points=excluded.speaker_points,
      status=excluded.status, version=excluded.version, updated_at=excluded.updated_at`).run(
      m.meeting_id, m.language, m.summary_md, J(m.topics), J(m.decisions), J(m.action_items), J(m.speaker_points), m.status, version, now(),
    );
    return minutesRepo.get(m.meeting_id)!;
  },
  setStatus: (mid: string, status: Minutes['status']) =>
    db.prepare(`INSERT INTO minutes (meeting_id,status,updated_at) VALUES (?,?,?) ON CONFLICT(meeting_id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at`)
      .run(mid, status, now()),
};

export type UsageKind = 'asr_minutes' | 'cards' | 'searches' | 'llm_tokens' | 'registry_lookups' | 'meeting_minutes';
export const usage = {
  record(userId: string, meetingId: string | null, kind: UsageKind, quantity: number, cost = 0, detail?: unknown) {
    db.prepare('INSERT INTO usage_records (user_id,meeting_id,kind,quantity,cost_estimate,detail,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(userId, meetingId, kind, quantity, cost, detail == null ? null : J(detail), now());
  },
  monthly(userId: string) {
    const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
    return db.prepare(`SELECT kind, SUM(quantity) quantity, SUM(cost_estimate) cost FROM usage_records WHERE user_id = ? AND created_at >= ? GROUP BY kind`)
      .all(userId, start.getTime()) as { kind: UsageKind; quantity: number; cost: number }[];
  },
  byMeeting: (mid: string) => db.prepare(`SELECT kind, SUM(quantity) quantity, SUM(cost_estimate) cost FROM usage_records WHERE meeting_id = ? GROUP BY kind`)
    .all(mid) as { kind: UsageKind; quantity: number; cost: number }[],
};
