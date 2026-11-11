/**
 * 向量模型适配层（复述识别用，需求 4.5）。
 * - local：字符 1-3 gram 哈希向量，零依赖，能识别同语言复述，不能识别跨语言复述。
 * - openai_compat：任意 OpenAI 兼容 /embeddings 接口（多语言 embedding 模型），支持跨语言复述。
 */
import { config } from '../../config.js';

const DIM = 1024;

function fnv(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function normalizeText(s: string) {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ' ').trim();
}

/** 把文本切成 token：中文按字，英文按词 */
export function tokens(s: string): string[] {
  const out: string[] = [];
  for (const m of normalizeText(s).matchAll(/[\p{Script=Han}]|[a-z0-9]+/gu)) out.push(m[0]);
  return out;
}

export function localEmbed(text: string): number[] {
  const v = new Float64Array(DIM);
  const t = tokens(text);
  for (let n = 1; n <= 3; n++) {
    for (let i = 0; i + n <= t.length; i++) {
      const g = t.slice(i, i + n).join('\u0001');
      v[fnv(g) % DIM] += n; // 长 gram 权重更高
    }
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return Array.from(v, (x) => +(x / norm).toFixed(5));
}

async function remoteEmbed(texts: string[]): Promise<number[][]> {
  const r = await fetch(`${config.embed.baseUrl.replace(/\/$/, '')}/embeddings`, {
    method: 'POST', signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.embed.apiKey}` },
    body: JSON.stringify({ model: config.embed.model, input: texts }),
  });
  if (!r.ok) throw new Error(`embed HTTP ${r.status}`);
  const j: any = await r.json();
  return j.data.map((d: any) => d.embedding as number[]);
}

export async function embed(text: string): Promise<{ vec: number[]; kind: 'local' | 'remote' }> {
  if (config.embed.provider === 'openai_compat' && config.embed.baseUrl) {
    try { return { vec: (await remoteEmbed([text]))[0], kind: 'remote' }; }
    catch (e) { console.warn('[embed] remote failed, fallback to local', (e as Error).message); }
  }
  return { vec: localEmbed(text), kind: 'local' };
}

export function cosine(a: number[], b: number[]) {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** 字面重合度：转写片段的 2-gram 有多少比例出现在卡片里（包含度，适合"朗读卡片"的场景） */
export function lexicalContainment(segment: string, card: string) {
  const g = (t: string[]) => { const s = new Set<string>(); for (let i = 0; i + 2 <= t.length; i++) s.add(t[i] + t[i + 1]); if (t.length === 1) s.add(t[0]); return s; };
  const a = g(tokens(segment)), b = g(tokens(card));
  if (a.size < 3) return 0; // 太短的片段（"对""好的"）不判定为复述
  let hit = 0;
  for (const x of a) if (b.has(x)) hit++;
  return hit / a.size;
}
