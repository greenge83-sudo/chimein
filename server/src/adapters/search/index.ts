/** 联网搜索适配层（需求 6.2：可替换供应商）。并行最多 3 个查询，单次超时 5 秒，结果按会议缓存。 */
import { config } from '../../config.js';
import { usage } from '../../db.js';

export interface SearchResult { title: string; url: string; snippet: string; date?: string }

async function tavily(q: string, lang: string): Promise<SearchResult[]> {
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST', signal: AbortSignal.timeout(config.search.timeoutMs),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.search.tavilyKey}` },
    body: JSON.stringify({ query: q, max_results: 5, search_depth: 'basic' }),
  });
  if (!r.ok) throw new Error(`tavily HTTP ${r.status}`);
  const j: any = await r.json();
  return (j.results ?? []).map((x: any) => ({ title: x.title, url: x.url, snippet: String(x.content ?? '').slice(0, 500), date: x.published_date }));
}

async function bocha(q: string): Promise<SearchResult[]> {
  const r = await fetch('https://api.bochaai.com/v1/web-search', {
    method: 'POST', signal: AbortSignal.timeout(config.search.timeoutMs),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.search.bochaKey}` },
    body: JSON.stringify({ query: q, summary: true, count: 5 }),
  });
  if (!r.ok) throw new Error(`bocha HTTP ${r.status}`);
  const j: any = await r.json();
  return (j.data?.webPages?.value ?? []).map((x: any) => ({
    title: x.name, url: x.url, snippet: String(x.summary ?? x.snippet ?? '').slice(0, 500), date: x.dateLastCrawled,
  }));
}

async function mock(q: string): Promise<SearchResult[]> {
  await new Promise((r) => setTimeout(r, 200));
  return [
    { title: `[演示来源] ${q.slice(0, 20)} 行业报告`, url: `https://example.com/demo-report?q=${encodeURIComponent(q)}`, snippet: '演示数据：接入真实搜索后替换。' },
    { title: `[演示来源] ${q.slice(0, 20)} 新闻`, url: `https://example.org/demo-news?q=${encodeURIComponent(q)}`, snippet: '演示数据。' },
  ];
}

const cache = new Map<string, SearchResult[]>(); // key: meetingId|query

export async function search(queries: string[], ctx: { userId: string; meetingId: string; lang: string }): Promise<SearchResult[]> {
  const qs = [...new Set(queries.map((q) => q.trim()).filter(Boolean))].slice(0, config.search.maxQueries);
  const fn = config.search.provider === 'tavily' ? (q: string) => tavily(q, ctx.lang)
    : config.search.provider === 'bocha' ? bocha : mock;
  const results = await Promise.all(qs.map(async (q) => {
    const key = `${ctx.meetingId}|${q}`;
    if (cache.has(key)) return cache.get(key)!;
    try {
      const r = await fn(q);
      cache.set(key, r);
      usage.record(ctx.userId, ctx.meetingId, 'searches', 1, config.search.provider === 'mock' ? 0 : 0.008, { q });
      return r;
    } catch (e) {
      console.warn('[search] failed', q, (e as Error).message);
      return [];
    }
  }));
  const seen = new Set<string>();
  return results.flat().filter((r) => r.url && !seen.has(r.url) && seen.add(r.url));
}

export function clearSearchCache(meetingId: string) {
  for (const k of cache.keys()) if (k.startsWith(`${meetingId}|`)) cache.delete(k);
}
