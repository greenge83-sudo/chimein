/**
 * 演示用 mock 模型：不调用任何外部服务，用简单规则模拟判定/生成/指令解析/纪要，
 * 保证没有 API Key 时也能把"收音 → 转写 → 判定 → 出卡 → 同步 → 纪要"全链路跑通。
 * 生成的内容都带"[演示]"标记，避免被误当成真实信息。
 */
import type { LLMProvider, LLMRequest, LLMResult } from './types.js';

const DATA_HINT = /(市场|规模|增长|增速|份额|营收|收入|用户数|渗透率|多少|多大|market|size|growth|revenue|share|how (big|many|much))/i;
const CASE_HINT = /(怎么做|做法|模式|策略|打法|案例|玩法|strategy|playbook|approach|case)/i;
const TERM_HINT = /(是什么|什么意思|概念|政策|技术|what is|meaning of)/i;

function mockJudge(input: any) {
  const lines: { text: string }[] = input.window ?? [];
  const text = lines.map((l) => l.text).join(' ');
  const last = lines.at(-1)?.text ?? '';
  const base = {
    should_card: false, card_type: null, value_score: 0.2, reason: '[演示] 暂无值得插话的点', trigger_quote: '',
    search_queries: [] as string[], entities: [] as string[], parent_card_id: null, is_instruction: false, instruction_text: null,
    matched_request_id: null as string | null, needs_review: false,
  };
  for (const r of input.pendingTopicRequests ?? []) {
    if (r.topic && text.includes(r.topic)) base.matched_request_id = r.id;
  }
  if (!last.trim()) return base;
  const cp = (input.counterparties as string[] ?? []).find((c) => c && last.includes(c));
  const quote = lines[lines.length - 1]?.text.slice(0, 60) ?? '';
  const pick = (type: string, score: number, reason: string, ents: string[] = []) => ({
    ...base, should_card: true, card_type: type, value_score: score, reason: `[演示] ${reason}`, trigger_quote: quote,
    search_queries: [last.slice(0, 40)], entities: ents, needs_review: type === 'fact_check' || (type === 'entity_brief' && !!cp),
  });
  if (cp) return pick('entity_brief', 0.85, `提到了参会方 ${cp}`, [cp]);
  if (DATA_HINT.test(last)) return pick('data_reference', 0.82, '讨论需要数字但无人给出');
  if (CASE_HINT.test(last)) return pick('case_study', 0.76, '讨论某个做法，可补充案例');
  if (TERM_HINT.test(last)) return pick('knowledge', 0.74, '出现了需要解释的概念');
  if (lines.length >= 8) return pick('inspiration', 0.72, '讨论持续较久，可给出追问');
  return base;
}

function mockGenerate(input: any) {
  const j = input.judge ?? {};
  const type = j.card_type ?? 'knowledge';
  const quote: string = j.trigger_quote || input.question || '';
  const results: { title: string; url: string; snippet: string }[] = input.searchResults ?? [];
  const titles: Record<string, string> = {
    knowledge: '概念补充', data_reference: '相关数据参考', fact_check: '公开信息核对', entity_brief: `${(j.entities ?? [])[0] ?? '主体'}速览`,
    case_study: '可参考的案例', inspiration: '还可以追问', discussion_summary: '讨论小结', answer: '回答', iteration: '补充更新',
  };
  const zh = input.cardLanguage !== 'en';
  const bodyBy: Record<string, string> = {
    inspiration: zh ? '[演示] 讨论已持续一段时间，下面几个问题还没展开。' : '[Demo] A few angles not yet discussed.',
    discussion_summary: zh ? '[演示] 到目前为止的讨论要点如下。' : '[Demo] Key points so far.',
  };
  const isSummary = type === 'discussion_summary';
  const recent: string[] = (input.window ?? []).slice(-3).map((l: any) => String(l.text).slice(0, 28));
  return {
    type, language: zh ? 'zh' : 'en',
    title: (zh ? titles[type] : type.replace('_', ' ')).slice(0, 16),
    body: bodyBy[type] ?? (zh ? `[演示] 因为刚才提到"${quote.slice(0, 20)}"，这里给出补充（接入真实模型后替换）。` : `[Demo] Because you mentioned "${quote.slice(0, 30)}".`),
    bullets: isSummary ? recent : type === 'inspiration'
      ? (zh ? ['目标用户是谁？', '有没有反方观点？', '成本怎么估算？'] : ['Who is the target user?', 'Any counter-arguments?', 'What are the costs?'])
      : results.slice(0, 2).map((r) => r.title.slice(0, 30)),
    sources: results.slice(0, 2).map((r) => ({ title: r.title, url: r.url })),
    parent_card_id: j.parent_card_id ?? null,
    increment: type === 'iteration' ? (zh ? '[演示] 新增了一条信息' : '[Demo] new info') : null,
    confidence: 0.75,
  };
}

function mockCommand(input: any) {
  const t: string = input.text ?? '';
  let mode = 'now', topic: string | null = null, due: number | null = null;
  const m = t.match(/(\d+|[一二两三四五六七八九十]+)\s*分钟(后|之后|以后)/) || t.match(/in (\d+) min/i);
  const cn: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const topicM = t.match(/(?:讨论到|说到|聊到)(.{1,10}?)(?:的时候|时)/) || t.match(/when we (?:discuss|talk about|get to) ([\w\s]{1,30})/i);
  if (m) { mode = 'at_time'; due = (Number(m[1]) || cn[m[1]] || 5) * 60; }
  else if (topicM) { mode = 'on_topic'; topic = topicM[1].trim(); }
  else if (/(等会|等一下|稍后|待会|later)/i.test(t)) mode = 'later';
  const type = /小结|总结|summary/i.test(t) ? 'discussion_summary' : /案例|case/i.test(t) ? 'case_study'
    : /数据|价格|规模|data|price/i.test(t) ? 'data_reference' : /背景|公司|company/i.test(t) ? 'entity_brief' : 'answer';
  return {
    mode, card_type: type, topic, request_summary: t.replace(/^(插一句|chime ?in)[，,\s]*/i, '').slice(0, 40) || t,
    search_queries: type === 'answer' || type === 'discussion_summary' ? [] : [t.slice(0, 40)], due_in_seconds: due, needs_clarification: false,
  };
}

function mockMinutes(input: any) {
  const segs: { speaker: string; text: string }[] = input.segments ?? [];
  const bySpeaker = new Map<string, string[]>();
  for (const s of segs) { const a = bySpeaker.get(s.speaker) ?? []; if (a.length < 3) a.push(s.text.slice(0, 40)); bySpeaker.set(s.speaker, a); }
  const actions = segs.filter((s) => /(负责|跟进|下周|明天|截止|待办|TODO|follow up|by (monday|friday|next week))/i.test(s.text))
    .map((s) => ({ task: s.text.slice(0, 60), owner: null, due: null }));
  return {
    summary_md: `**[演示纪要]** 本次会议「${input.title}」共 ${segs.length} 段发言，展示了 ${(input.cards ?? []).length} 张脑暴卡。接入真实模型后将生成完整纪要。`,
    topics: (input.cards ?? []).slice(0, 5).map((c: any) => ({ title: c.title, conclusion: '[演示] 围绕该卡片进行了讨论' })),
    decisions: [],
    action_items: actions,
    speaker_points: [...bySpeaker].map(([speaker, points]) => ({ speaker, points })),
  };
}

export const mockProvider: LLMProvider = {
  name: 'mock',
  async json<T>(req: LLMRequest<T>): Promise<LLMResult<T>> {
    await new Promise((r) => setTimeout(r, req.role === 'judge' ? 150 : 600));
    const fn = { judge: mockJudge, generate: mockGenerate, command: mockCommand, minutes: mockMinutes }[req.role];
    const data = req.schema.parse(fn(req.input));
    return { data, provider: 'mock', model: 'mock', inputTokens: 0, outputTokens: 0 };
  },
};
