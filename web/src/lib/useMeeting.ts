/** 会议实时状态：首次拉取 + socket 增量 + 断线重连后补齐（需求 五 弱网处理） */
import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { api, auth, type Card, type CardRequest, type Creds, type Segment } from './api';

export interface MeetingState {
  status: string; elapsedMs: number; startedAt: number | null; aiPaused: boolean; frequency: string; subtitles: boolean; title: string;
}
export interface Ack { id: string; summary: string; needsClarification: boolean; at: number }

export function useMeeting(creds: Creds | null) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [cards, setCards] = useState<Record<string, Card>>({});
  const [requests, setRequests] = useState<Record<string, CardRequest>>({});
  const [state, setState] = useState<MeetingState | null>(null);
  const [ai, setAi] = useState<{ state: string; topic: string | null }>({ state: 'listening', topic: null });
  const [transcript, setTranscript] = useState<Segment[]>([]);
  const [partial, setPartial] = useState<string>('');
  const [acks, setAcks] = useState<Ack[]>([]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [subtitle, setSubtitle] = useState<string>('');
  const [online, setOnline] = useState(0);
  const [connected, setConnected] = useState(false);
  const [minutesStatus, setMinutesStatus] = useState<string | null>(null);
  const [lastJudge, setLastJudge] = useState<any>(null);
  const [fresh, setFresh] = useState<Record<string, number>>({});
  const socketRef = useRef<Socket | null>(null);

  const load = useCallback(async () => {
    if (!creds) return;
    try {
      const d = await api('GET', `/api/meetings/${creds.meetingId}`, undefined, creds);
      setData(d);
      setCards(Object.fromEntries(d.cards.map((c: Card) => [c.id, c])));
      setRequests(Object.fromEntries(d.requests.map((r: CardRequest) => [r.id, r])));
      if (d.transcript) setTranscript(d.transcript);
      setMinutesStatus(d.minutesStatus);
      const f = d.cards.find((c: Card) => c.focused);
      setFocusId(f?.id ?? null);
      const m = d.meeting;
      setState((s) => s ?? { status: m.status, elapsedMs: m.elapsedMs, startedAt: m.started_at, aiPaused: m.settings.aiPaused, frequency: m.settings.frequency, subtitles: m.settings.subtitles, title: m.title });
      setError(null);
    } catch (e: any) { setError(e.code ?? String(e)); }
  }, [creds?.meetingId, creds?.role, creds?.screenKey]);

  useEffect(() => {
    if (!creds) return;
    load();
    const s = io({
      auth: { meetingId: creds.meetingId, hostToken: creds.role === 'host' ? auth.hostToken() : undefined,
        participantToken: creds.role === 'guest' ? auth.participantToken(creds.meetingId) : undefined, screenKey: creds.screenKey },
      transports: ['websocket', 'polling'],
    });
    socketRef.current = s;
    let firstConnect = true;
    s.on('connect', () => { setConnected(true); if (!firstConnect) load(); firstConnect = false; });
    s.on('disconnect', () => setConnected(false));
    s.on('error.fatal', (e) => setError(e.error));
    const upsert = (c: Card) => {
      setCards((m) => { if (!m[c.id] && c.status === 'published') setFresh((f) => ({ ...f, [c.id]: Date.now() })); return { ...m, [c.id]: { ...m[c.id], ...c } }; });
    };
    s.on('card.new', upsert);
    s.on('card.update', upsert);
    s.on('card.pending', upsert);
    s.on('card.iterate', ({ card, parentId }) => { upsert(card); setFresh((f) => ({ ...f, [parentId]: Date.now() })); });
    s.on('card.remove', ({ id }) => setCards((m) => { const n = { ...m }; delete n[id]; return n; }));
    s.on('card.reactions', ({ id, reactions }) => setCards((m) => (m[id] ? { ...m, [id]: { ...m[id], reactions } } : m)));
    s.on('card.focus', ({ id }) => setFocusId(id));
    s.on('request.update', (r: CardRequest) => setRequests((m) => ({ ...m, [r.id]: r })));
    s.on('request.ack', ({ request, summary, needsClarification }) => {
      setRequests((m) => ({ ...m, [request.id]: request }));
      const a = { id: request.id, summary, needsClarification, at: Date.now() };
      setAcks((x) => [...x, a]);
      setTimeout(() => setAcks((x) => x.filter((y) => y !== a)), 3500);
    });
    s.on('ai.status', setAi);
    s.on('meeting.state', (st: MeetingState) => setState(st));
    s.on('transcript.final', (seg: Segment) => { setTranscript((t) => [...t.slice(-999), seg]); setPartial(''); });
    s.on('transcript.partial', ({ text }) => setPartial(text));
    s.on('subtitle', ({ text }) => setSubtitle(text));
    s.on('participant.count', ({ online }) => setOnline(online));
    s.on('minutes.status', ({ status }) => setMinutesStatus(status));
    s.on('judge.result', setLastJudge);
    s.on('speaker.renamed', ({ label, name }) => setTranscript((t) => t.map((x) => (x.speaker_label === label ? { ...x, speaker_name: name } : x))));
    s.on('meeting.deleted', () => setError('not_found'));
    return () => { s.close(); socketRef.current = null; };
  }, [creds?.meetingId, creds?.role, creds?.screenKey]);

  // 本地计时：每秒推进会议时长
  useEffect(() => {
    const iv = setInterval(() => setState((s) => (s && s.status === 'live' ? { ...s, elapsedMs: s.elapsedMs + 1000 } : s)), 1000);
    return () => clearInterval(iv);
  }, []);

  return { data, error, cards, requests, state, ai, transcript, partial, acks, focusId, subtitle, online, connected, minutesStatus, lastJudge, fresh,
    socket: socketRef, reload: load, setCards };
}

/** 把卡片整理成卡片流：顶层卡（迭代卡挂在原卡下），置顶在前，其余按最近更新排序 */
export function cardStream(cards: Record<string, Card>, filter: (c: Card) => boolean) {
  const all = Object.values(cards).filter(filter);
  const children: Record<string, Card[]> = {};
  const top: Card[] = [];
  for (const c of all) {
    if (c.parent_card_id && c.type === 'iteration' && cards[c.parent_card_id]) (children[c.parent_card_id] ??= []).push(c);
    else top.push(c);
  }
  const key = (c: Card) => Math.max(c.published_at ?? c.created_at, ...(children[c.id] ?? []).map((x) => x.published_at ?? x.created_at));
  top.sort((a, b) => Number(b.pinned) - Number(a.pinned) || key(b) - key(a));
  for (const k in children) children[k].sort((a, b) => (a.published_at ?? 0) - (b.published_at ?? 0));
  return { top, children };
}
