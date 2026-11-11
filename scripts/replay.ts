/**
 * M0 技术验证用：把一份真实会议转写（文本）回放进正在运行的服务，输出出卡结果、延迟与纪要，
 * 便于对比不同模型 / 搜索供应商（改 .env 后重启服务再跑一次）。
 *
 * 转写文件格式：每行 "说话人: 内容"（没有说话人的行记为 S1）。
 * 用法：npx tsx scripts/replay.ts transcript.txt [--base http://localhost:8787] [--preset brainstorm] [--every 6]
 *   --every N：每 N 行触发一次判定（模拟 30 秒一次的定时评估）
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (k: string, d: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
if (!file) { console.error('usage: npx tsx scripts/replay.ts transcript.txt [--base URL] [--preset P] [--every N] [--title T]'); process.exit(1); }
const BASE = opt('base', 'http://localhost:8787');
const every = Number(opt('every', '6'));

async function api(method: string, p: string, body?: unknown, token?: string) {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j: any = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(j)}`);
  return j;
}

const lines = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
  const m = l.match(/^([^:：]{1,20})[:：]\s*(.+)$/);
  return m ? { speaker: m[1].trim(), text: m[2] } : { speaker: 'S1', text: l };
});

const email = `replay-${Date.now()}@example.com`;
const { token } = await api('POST', '/api/auth/register', { email, password: 'replay-password' });
const { meeting } = await api('POST', '/api/meetings', { title: opt('title', `Replay ${file}`), preset: opt('preset', 'brainstorm'),
  counterparties: opt('counterparties', '').split(',').filter(Boolean), card_language: opt('card-language', 'zh') }, token);
await api('PATCH', `/api/meetings/${meeting.id}`, { status: 'live', consent: true }, token);
console.log(`meeting ${meeting.id} · ${lines.length} lines · judge every ${every} lines`);

const t0 = Date.now();
for (const [i, l] of lines.entries()) {
  const seg = await api('POST', `/api/meetings/${meeting.id}/transcript`, l, token);
  if (seg?.echo_of_card_id) console.log(`  ↺ echo: "${l.text.slice(0, 40)}"`);
  if ((i + 1) % every === 0) {
    const t = Date.now();
    await api('POST', `/api/meetings/${meeting.id}/judge-now`, {}, token);
    console.log(`  · judge after line ${i + 1} (${Date.now() - t}ms)`);
  }
}
await new Promise((r) => setTimeout(r, 3000));
const state = await api('GET', `/api/meetings/${meeting.id}`, undefined, token);
await api('PATCH', `/api/meetings/${meeting.id}`, { status: 'ended' }, token);

console.log('\n=== cards ===');
for (const c of state.cards) {
  console.log(`[${c.status}] ${c.type} · ${c.title}\n  ${c.body}\n${c.bullets.map((b: string) => `  - ${b}`).join('\n')}${c.sources.length ? `\n  sources: ${c.sources.map((s: any) => s.url).join(' ')}` : ''}`);
}
console.log('\n=== metrics ===', state.metrics);

for (let i = 0; i < 90; i++) {
  const m = await api('GET', `/api/meetings/${meeting.id}/minutes`, undefined, token);
  if (m.minutes?.status === 'ready' || m.minutes?.status === 'failed') {
    console.log('\n=== minutes ===\n', JSON.stringify(m.minutes, null, 1));
    console.log('\n=== usage ===', m.usage);
    break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)}s · host console: ${BASE.replace(/:\d+$/, ':5173')}/m/${meeting.id}/summary (log in as ${email} / replay-password)`);
