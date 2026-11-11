const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string | null) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ } },
};

export const auth = {
  hostToken: () => store.get('hostToken'),
  setHostToken: (t: string | null) => store.set('hostToken', t),
  participantToken: (mid: string) => store.get(`pt:${mid}`),
  setParticipantToken: (mid: string, t: string) => store.set(`pt:${mid}`, t),
};

export type Role = 'host' | 'guest' | 'screen';
export interface Creds { role: Role; meetingId: string; screenKey?: string }

export function headersFor(c?: Creds): Record<string, string> {
  const h: Record<string, string> = {};
  if (!c || c.role === 'host') { const t = auth.hostToken(); if (t) h.authorization = `Bearer ${t}`; }
  if (c?.role === 'guest') { const t = auth.participantToken(c.meetingId); if (t) h['x-participant-token'] = t; }
  if (c?.role === 'screen' && c.screenKey) h['x-screen-key'] = c.screenKey;
  return h;
}

export class ApiError extends Error { constructor(public status: number, public code: string) { super(code); } }

export async function api<T = any>(method: string, path: string, body?: unknown, creds?: Creds): Promise<T> {
  const isForm = body instanceof FormData;
  const r = await fetch(path, {
    method,
    headers: { ...(body && !isForm ? { 'content-type': 'application/json' } : {}), ...headersFor(creds) },
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const text = await r.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!r.ok) throw new ApiError(r.status, json?.error ?? `HTTP ${r.status}`);
  return json as T;
}

export interface Source { title: string; url: string }
export interface Card {
  id: string; meeting_id: string; type: string; language: string | null; title: string; body: string; bullets: string[]; sources: Source[];
  confidence: number | null; trigger_quote: string | null; status: string; pinned: boolean; focused: boolean; origin: string;
  parent_card_id: string | null; version: number; increment_text: string | null; request_id: string | null; asked_by: string | null;
  created_at: number; published_at: number | null; updated_at: number; reactions: { useful: number; irrelevant: number; saved: number };
}
export interface CardRequest {
  id: string; requested_by: string | null; channel: string; request_text: string; mode: string; topic: string | null; due_at: number | null;
  status: string; card_id: string | null; created_at: number; parsed_intent?: { request_summary?: string } | null;
}
export interface Segment { id: string; speaker_label: string | null; speaker_name: string | null; text: string; echo_of_card_id: string | null; is_command: boolean; created_at: number }

export function fmtDuration(ms: number) {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(ss).padStart(2, '0')}`;
}
