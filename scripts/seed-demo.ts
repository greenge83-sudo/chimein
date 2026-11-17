/**
 * 设计评审用：往正在运行的服务里放一场带示例卡片的会议（内容为虚构示例，非真实数据），
 * 方便直接看手机端 / 大屏端的卡片设计。
 * 用法：npx tsx scripts/seed-demo.ts [--base http://localhost:8787] [--preset external]
 * 需与服务使用同一个 DATA_DIR。
 */
const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const BASE = opt('base', 'http://localhost:8787');
const EMAIL = 'demo@example.com', PASSWORD = 'demo-password';

async function api(method: string, p: string, body?: unknown, token?: string) {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j: any = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, json: j };
}

let auth = await api('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
if (!auth.ok) auth = await api('POST', '/api/auth/register', { email: EMAIL, password: PASSWORD, name: 'Demo' });
const token = auth.json.token;
const created = await api('POST', '/api/meetings', { title: '宠物品牌合作洽谈（示例）', preset: opt('preset', 'brainstorm'), agenda: '1. 合作模式 2. 定价 3. 下一步', card_language: 'zh' }, token);
const m = created.json.meeting;
// 关掉自动出卡，避免演示模型往示例里加占位卡
await api('PATCH', `/api/meetings/${m.id}`, { settings: { aiPaused: true } }, token);
await api('PATCH', `/api/meetings/${m.id}`, { status: 'live', consent: true }, token);

const { cards, segments, participants, reactions } = await import('../server/src/db.js');
const src = (title: string, n: number) => ({ title: `示例来源：${title}`, url: `https://example.com/sample-${n}` });
const base = { meeting_id: m.id, language: 'zh', trigger_segment_ids: [], status: 'published' as const, parent_card_id: null, increment_text: null, request_id: null, asked_by: null, entities: [] as string[] };

for (const [speaker, text] of [
  ['张总', '今天主要和汪星人科技聊一下联名猫粮的合作方式。'],
  ['李经理', '这个宠物食品市场现在到底有多大？增长还快吗？'],
  ['王总监', '我们能不能学一下国外订阅制的做法，按月寄粮？'],
  ['张总', '我记得他们去年融了两个亿，应该不缺钱。'],
  ['李经理', '那 DTC 模式的复购率一般能做到多少？'],
]) segments.insert({ meeting_id: m.id, speaker_label: speaker, speaker_name: speaker, text, lang: 'zh', start_ms: null, end_ms: null, is_final: true, echo_of_card_id: null, is_command: false });

const list: any[] = [
  { type: 'entity_brief', origin: 'preload', title: '汪星人科技速览', body: '因为刚才提到汪星人科技：主营中高端猫粮与宠物零食，2019 年成立于杭州。', bullets: ['员工约 300 人，自有工厂 1 座', '线上渠道占比约 70%', '2025 年推出处方粮产品线'], sources: [src('企业官网公司介绍', 1), src('行业媒体报道 2025', 2)], confidence: 0.82, trigger_quote: '今天主要和汪星人科技聊一下', entities: ['汪星人科技'] },
  { type: 'data_reference', origin: 'auto', title: '宠物食品市场规模', body: '因为刚才问到市场有多大：2025 年国内宠物食品市场约 1800 亿元，同比增长约 9%。', bullets: ['猫粮增速约 12%，高于犬粮', '线上销售占比超过 60%', '不同报告口径不一，差异约 ±15%'], sources: [src('某行业白皮书 2025', 3), src('某咨询机构年度报告', 4)], confidence: 0.78, trigger_quote: '这个宠物食品市场现在到底有多大？' },
  { type: 'case_study', origin: 'auto', title: '订阅制宠物粮案例', body: '因为刚才提到订阅制：海外有品牌用"按月定制配送"把复购率做到 80% 以上。', bullets: ['按宠物体重和年龄定制配方', '首单低价，次月起恢复原价', '流失多发生在第 3 个月'], sources: [src('某品牌公开招股书', 5)], confidence: 0.74, trigger_quote: '能不能学一下国外订阅制的做法' },
  { type: 'fact_check', origin: 'auto', title: '融资金额核对', body: '公开信息显示，汪星人科技 2024 年 B 轮融资约 1.2 亿元，与"两个亿"的说法有出入。', bullets: ['B 轮：2024 年 6 月，约 1.2 亿元', '此前 A 轮约 5000 万元'], sources: [src('融资新闻稿 2024-06', 6)], confidence: 0.71, trigger_quote: '我记得他们去年融了两个亿' },
  { type: 'answer', origin: 'question', asked_by: '李经理', title: 'DTC 复购率参考', body: '宠物食品 DTC 品牌 12 个月复购率多在 35%–50%，订阅制可到 60% 以上。', bullets: ['主粮高于零食和用品', '首单后 30 天内触达最关键'], sources: [src('某电商平台行业洞察', 7)], confidence: 0.7, trigger_quote: 'DTC 模式的复购率一般能做到多少？' },
  { type: 'inspiration', origin: 'auto', title: '还没讨论到的问题', body: '联名的方向已基本一致，下面几点还没有展开：', bullets: ['联名款库存风险由谁承担？', '对方现有经销商会不会有冲突？', '如果首批销量不及预期，怎么退出？'], sources: [], confidence: null, trigger_quote: '那就按联名款先做一批吧' },
  { type: 'knowledge', origin: 'auto', title: '什么是处方粮', body: '因为刚才提到处方粮：针对特定疾病设计、需在兽医指导下使用的宠物食品。', bullets: ['常见于肾病、泌尿、肠胃、减重', '主要走宠物医院渠道，毛利更高'], sources: [], confidence: null, trigger_quote: '他们的处方粮我们能一起卖吗' },
  { type: 'discussion_summary', origin: 'summary', title: '讨论小结 · 前 20 分钟', body: '已讨论合作模式与定价，联名款方向达成一致，分成比例待定。', bullets: ['共识：先做 1 款联名猫粮试水', '分歧：线上独家期 3 个月还是 6 个月', '待定：分成比例、库存承担方'], sources: [], confidence: null, trigger_quote: '' },
];
const made: any[] = [];
for (const c of list) { made.push(cards.insert({ ...base, ...c })); await new Promise((r) => setTimeout(r, 15)); }
// 迭代卡：挂在"市场规模"卡下，只显示新增
const parent = made[1];
cards.insert({ ...base, type: 'iteration', origin: 'auto', title: '市场规模 · 更新', body: '高端猫粮（单价 80 元/公斤以上）细分市场约 260 亿元，增速约 20%。', bullets: [], sources: [src('某券商研报 2025Q3', 8)], confidence: 0.72, trigger_quote: '那高端这一块呢', parent_card_id: parent.id, increment_text: '新增高端细分市场数据', version: 2 });
const p = participants.create(m.id, '小王', 'guest');
reactions.set(parent.id, p.id, 'useful', true); reactions.set(made[2].id, p.id, 'useful', true);

console.log(JSON.stringify({ meetingId: m.id, code: m.join_code, host: `${BASE}/m/${m.id}/host`, screen: m.links.screen.replace(/^https?:\/\/[^/]+/, BASE), join: `${BASE}/m/${m.id}`, participantToken: p.token, login: `${EMAIL} / ${PASSWORD}` }, null, 1));
