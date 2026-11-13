/** 大脑二 · 检索 + 生成 + 校验 + 分流（需求 6.1 第 5-7 步、8.2） */
import { cards, materials, usage, type Card, type CardOrigin, type CardStatus, type Meeting, type Segment } from '../db.js';
import { FACTUAL_TYPES, PRESETS, SEARCH_TYPES, type CardType, type Tuning } from '../config.js';
import { llmJson, prompt } from '../adapters/llm/index.js';
import { search, type SearchResult } from '../adapters/search/index.js';
import { GenerateSchema, type GenerateOut } from './schemas.js';
import { cardText, indexShownCard, isDuplicateOfShown } from './echo.js';
import { broadcastCard } from '../bus.js';

export interface CardJob {
  type: CardType;
  origin: CardOrigin;
  triggerQuote: string;
  searchQueries: string[];
  entities: string[];
  parentCardId: string | null;
  needsReview: boolean;
  segmentIds: string[];
  window: Segment[];
  /** 提问 / 预约原文 */
  question?: string;
  askedBy?: string | null;
  requestId?: string | null;
  /** 指定生成后的状态（预约"稍后"→ ready；预加载 → standby） */
  forceStatus?: CardStatus;
  /** 深挖：更详细 */
  detailed?: boolean;
}

export type CardJobResult = { card: Card } | { dropped: string };

const isZh = (lang: string) => lang !== 'en';

export function limitsText(m: Meeting, t: Tuning) {
  const L = t.cardLimits;
  if (m.card_language === 'en') return `title ≤ ${L.titleEn} chars; body ≤ ${L.bodyEn} chars; at most ${L.bullets} bullets, each ≤ ${L.bulletEn} chars; include the triggering phrase in body ("Since you just mentioned …")`;
  if (m.card_language === 'bilingual') return `标题 ≤ ${L.title} 字；正文 ≤ ${L.body} 字（中文在前，英文译文另起一行，英文不计入字数）；要点最多 ${L.bullets} 条，每条 ≤ ${L.bullet} 字；正文带触发原话片段（"因为刚才提到……"）`;
  return `标题 ≤ ${L.title} 字；正文 ≤ ${L.body} 字；要点最多 ${L.bullets} 条，每条 ≤ ${L.bullet} 字；正文带触发原话片段（"因为刚才提到……"）`;
}

/** 面试场景：与岗位无关、受反歧视法规保护的话题，代码侧兜底拦截（Prompt 之外的第二道防线） */
export const INTERVIEW_PROTECTED = /(年龄|多大了|几岁|出生年|婚姻|婚育|婚恋|恋爱|有没有对象|要孩子|结婚|已婚|未婚|离异|怀孕|备孕|生育|生孩子|育儿|民族|宗教|信仰|籍贯|户口|健康状况|病史|残疾|性取向|政治面貌|\bage\b|marital|married|pregnan|religio|ethnic|disabilit|sexual orientation|health condition)/i;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** 代码侧校验：字数、来源、置信度（需求 6.1 第 6 步）。不合格返回原因字符串 */
export function validateAndNormalize(out: GenerateOut, job: CardJob, m: Meeting, t: Tuning, results: SearchResult[]): GenerateOut | string {
  const L = t.cardLimits;
  const en = m.card_language === 'en';
  const bilingual = m.card_language === 'bilingual';
  const o: GenerateOut = { ...out, type: job.type === 'iteration' ? 'iteration' : out.type };
  o.title = clip(o.title.trim(), en ? L.titleEn : L.title);
  o.body = clip(o.body.trim(), en ? L.bodyEn : bilingual ? L.body + L.bodyEn : job.detailed ? L.body * 3 : L.body);
  o.bullets = o.bullets.map((b) => clip(b.trim(), en ? L.bulletEn : bilingual ? L.bullet + L.bulletEn : L.bullet)).filter(Boolean).slice(0, job.detailed ? 6 : L.bullets);
  if (!o.title || !o.body) return 'empty title/body';
  // 来源只能来自本次搜索结果或背景资料（防编造链接）
  const allowed = new Set(results.map((r) => r.url));
  o.sources = o.sources.filter((s) => /^https?:\/\//.test(s.url) && allowed.has(s.url)).slice(0, 3);
  const factual = FACTUAL_TYPES.includes(job.type) || (job.type === 'iteration' && o.sources.length > 0);
  if (factual && FACTUAL_TYPES.includes(job.type) && o.sources.length === 0) return 'factual card without sources';
  if (factual && o.confidence < t.confidenceThreshold) return `confidence ${o.confidence} < ${t.confidenceThreshold}`;
  if (m.preset === 'interview') {
    const text = [o.title, o.body, ...o.bullets].join(' ');
    if (INTERVIEW_PROTECTED.test(text)) return 'interview: protected-attribute topic';
  }
  if (job.type === 'iteration') {
    if (!job.parentCardId) return 'iteration without parent';
    if (!o.increment || !o.increment.trim()) return 'iteration without increment';
  }
  return o;
}

export async function runCardJob(m: Meeting, job: CardJob, t: Tuning): Promise<CardJobResult> {
  const lang = m.card_language;
  // 0) 主体速览按主体去重：同一主体已有速览卡（含预加载备用卡）就不再出
  if (job.type === 'entity_brief' && job.origin !== 'deepdive' && job.entities.length) {
    const ents = job.entities.map((e) => e.toLowerCase());
    const existing = cards.list(m.id).find((c) => c.type === 'entity_brief' && !['hidden', 'cancelled'].includes(c.status)
      && c.entities.some((e) => ents.includes(e.toLowerCase())));
    if (existing) return { dropped: `entity already covered by ${existing.id}` };
  }
  // 1) 检索（按需）
  let results: SearchResult[] = [];
  const needSearch = SEARCH_TYPES.includes(job.type) || ((job.type === 'answer' || job.type === 'iteration') && job.searchQueries.length > 0);
  if (needSearch && job.searchQueries.length) {
    results = await search(job.searchQueries, { userId: m.host_id, meetingId: m.id, lang });
  }
  // 会前资料：简单关键词召回相关片段
  const mats = materials.list(m.id);
  const keywords = [...job.entities, ...job.searchQueries, job.triggerQuote, job.question ?? ''].join(' ');
  const matSnippets = relevantSnippets(mats.map((x) => x.content_text).join('\n'), keywords, 3);
  if (job.type === 'entity_brief' && m.counterparties.length && isZh(lang)) {
    // 6.4：中国企业 MVP 附"在公示系统查看"链接（官方查询入口，非商业 API）
    for (const e of job.entities.filter((e) => /[\p{Script=Han}]/u.test(e))) {
      results.push({ title: `国家企业信用信息公示系统：${e}`, url: 'https://www.gsxt.gov.cn/', snippet: '官方企业登记信息查询入口（需人工查看）' });
    }
  }
  const parent = job.parentCardId ? cards.get(job.parentCardId) : undefined;

  // 2) 生成
  const preset = PRESETS[m.preset];
  const system = prompt('generate', {
    productName: '插一句 ChimeIn', persona: preset.persona[isZh(lang) ? 'zh' : 'en'], limits: limitsText(m, t), guidance: preset.guidance ?? '-',
    cardLanguage: lang === 'zh' ? '中文' : lang === 'en' ? 'English' : '中英双语（中文在前，英文在后）',
  });
  const user = JSON.stringify({
    meeting: { title: m.title, agenda: m.agenda, counterparties: m.counterparties },
    task: {
      card_type: job.type, origin: job.origin, trigger_quote: job.triggerQuote, question: job.question ?? null,
      entities: job.entities, detailed: !!job.detailed,
      instruction: job.detailed ? '这是"深挖"子卡：在原卡基础上给出更详细、更深入的内容，可放宽字数到 3 倍。' : undefined,
    },
    parent_card: parent ? { id: parent.id, title: parent.title, body: parent.body, bullets: parent.bullets } : null,
    recent_transcript: job.window.slice(-20).map((s) => `${s.speaker_name ?? s.speaker_label ?? '?'}: ${s.text}`),
    search_results: results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet, date: r.date })),
    background_materials: matSnippets,
  }, null, 1);
  const res = await llmJson({ role: 'generate', system, user, schema: GenerateSchema,
    input: { judge: { card_type: job.type, trigger_quote: job.triggerQuote, entities: job.entities, parent_card_id: job.parentCardId },
      question: job.question, searchResults: results, cardLanguage: lang, window: job.window } }, { userId: m.host_id, meetingId: m.id });

  const checked = validateAndNormalize(res.data, job, m, t, results);
  if (typeof checked === 'string') return { dropped: checked };

  // 3) 去重：与已上屏卡重复的不出（迭代卡/深挖/提问除外）
  if (!['iteration', 'answer'].includes(job.type) && job.origin !== 'deepdive') {
    const dup = await isDuplicateOfShown(m.id, cardText({ title: checked.title, body: checked.body, bullets: checked.bullets }), t.duplicateCardThreshold);
    if (dup) return { dropped: `duplicate of ${dup}` };
  }

  // 4) 分流（需求 4.3 第 7 条 / F-12）
  let status: CardStatus = job.forceStatus ?? 'published';
  if (!job.forceStatus && m.is_important && (job.type === 'fact_check' || (job.type === 'entity_brief' && job.needsReview))) status = 'pending_review';

  const card = cards.insert({
    meeting_id: m.id, type: checked.type as CardType, language: checked.language, title: checked.title, body: checked.body,
    bullets: checked.bullets, sources: checked.sources, confidence: checked.confidence, trigger_quote: job.triggerQuote || null,
    trigger_segment_ids: job.segmentIds, status, origin: job.origin, parent_card_id: job.parentCardId ?? null,
    increment_text: checked.increment || null, request_id: job.requestId ?? null, asked_by: job.askedBy ?? null, entities: job.entities,
    version: parent && job.type === 'iteration' ? parent.version + 1 : 1,
  });
  usage.record(m.host_id, m.id, 'cards', 1, 0, { type: card.type, origin: card.origin });
  if (status === 'published') await onPublished(card);
  broadcastCard(card, 'new');
  return { card };
}

/** 卡片上屏后的统一处理：写入已展示内容库；迭代卡把原卡顶到最显眼位置 */
export async function onPublished(card: Card) {
  await indexShownCard(card);
  if (card.parent_card_id && card.type === 'iteration') {
    const parent = cards.update(card.parent_card_id, {});
    if (parent) broadcastCard(parent, 'update');
  }
}

function relevantSnippets(text: string, keywords: string, n: number) {
  if (!text.trim()) return [];
  const paras = text.split(/\n{1,}/).map((p) => p.trim()).filter((p) => p.length > 10);
  const keys = [...new Set(keywords.split(/[\s,，。、;；]+/).filter((k) => k.length >= 2))];
  return paras
    .map((p) => ({ p, s: keys.reduce((acc, k) => acc + (p.includes(k) ? 1 : 0), 0) }))
    .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.p.slice(0, 600));
}
