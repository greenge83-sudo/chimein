import type { Server } from 'socket.io';
import type { Card, CardRequest } from './db.js';
import { reactions } from './db.js';

let io: Server | null = null;
export const setIO = (s: Server) => { io = s; };

export const room = (mid: string) => `m:${mid}`;
export const hostRoom = (mid: string) => `m:${mid}:host`;
export const guestRoom = (mid: string) => `m:${mid}:guest`; // 参会者 + 大屏

export function toAll(mid: string, ev: string, payload: unknown) { io?.to(room(mid)).emit(ev, payload); }
export function toHost(mid: string, ev: string, payload: unknown) { io?.to(hostRoom(mid)).emit(ev, payload); }
export function toGuests(mid: string, ev: string, payload: unknown) { io?.to(guestRoom(mid)).emit(ev, payload); }

export function publicCard(c: Card) {
  return { ...c, reactions: reactions.counts(c.id) };
}

/** 按状态把卡片变化推到正确的终端：未上屏卡片只给主持人看 */
export function broadcastCard(card: Card, kind: 'new' | 'update') {
  const pc = publicCard(card);
  if (card.status === 'published') {
    if (card.parent_card_id && card.type === 'iteration' && kind === 'new') toAll(card.meeting_id, 'card.iterate', { parentId: card.parent_card_id, card: pc });
    else toAll(card.meeting_id, kind === 'new' ? 'card.new' : 'card.update', pc);
    return;
  }
  toGuests(card.meeting_id, 'card.remove', { id: card.id });
  if (card.status === 'pending_review' && kind === 'new') toHost(card.meeting_id, 'card.pending', pc);
  else toHost(card.meeting_id, kind === 'new' ? 'card.new' : 'card.update', pc);
}

export function broadcastRequest(r: CardRequest) { toAll(r.meeting_id, 'request.update', r); }
