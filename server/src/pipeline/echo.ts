/** 复述识别（需求 4.5） */
import { embeddings, type Card } from '../db.js';
import { embed, cosine, lexicalContainment } from '../adapters/embed/index.js';
import type { Tuning } from '../config.js';

export const cardText = (c: Pick<Card, 'title' | 'body' | 'bullets'> & { increment_text?: string | null }) =>
  [c.title, c.body, ...c.bullets, c.increment_text ?? ''].filter(Boolean).join('\n');

/** 卡片上屏后写入"已展示内容库" */
export async function indexShownCard(card: Card) {
  const text = cardText(card);
  const { vec } = await embed(text);
  embeddings.put(card.id, card.meeting_id, text, vec);
}

/** 返回被复述的卡片 ID；不是复述返回 null */
export async function detectEcho(meetingId: string, text: string, tuning: Tuning): Promise<{ cardId: string; semantic: number; lexical: number } | null> {
  const recent = embeddings.recent(meetingId, tuning.echoCompareRecentCards);
  if (!recent.length || text.trim().length < 4) return null;
  const { vec } = await embed(text);
  let best: { cardId: string; semantic: number; lexical: number } | null = null;
  for (const r of recent) {
    const semantic = r.embedding.length === vec.length ? cosine(vec, r.embedding) : 0;
    const lexical = lexicalContainment(text, r.text);
    const hit = semantic >= tuning.echoSemanticThreshold || lexical >= tuning.echoLexicalThreshold;
    if (hit && (!best || Math.max(semantic, lexical) > Math.max(best.semantic, best.lexical))) best = { cardId: r.card_id, semantic, lexical };
  }
  return best;
}

/** 生成前去重：与已上屏卡片高度相似则不出 */
export async function isDuplicateOfShown(meetingId: string, text: string, threshold: number) {
  const recent = embeddings.recent(meetingId, 200);
  if (!recent.length) return null;
  const { vec } = await embed(text);
  for (const r of recent) {
    const s = r.embedding.length === vec.length ? cosine(vec, r.embedding) : 0;
    if (s >= threshold) return r.card_id;
  }
  return null;
}
