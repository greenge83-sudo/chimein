/**
 * 端到端测试：用 mock 模型/搜索启动真实服务，走一遍 M1 验收的主流程。
 * 运行：npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io as ioc, type Socket } from 'socket.io-client';

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let proc: ChildProcess;
let guest: Socket | undefined;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimein-test-'));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function api(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(BASE + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}
async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); }
  throw new Error('timeout');
}

before(async () => {
  // 测试里把自动判定间隔调大，改用 judge-now 手动触发，保证确定性
  fs.writeFileSync(path.join(dataDir, 'tuning.json'), JSON.stringify({ judgeEveryMs: 3600_000, laterAutoShowSilenceMs: 3600_000 }));
  proc = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, LLM_JUDGE_PROVIDER: 'mock', LLM_GENERATE_PROVIDER: 'mock',
      LLM_MINUTES_PROVIDER: 'mock', SEARCH_PROVIDER: 'mock', ASR_PROVIDER: 'browser', EMBED_PROVIDER: 'local', NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr!.on('data', (d) => { if (process.env.DEBUG) process.stderr.write(d); });
  proc.stdout!.on('data', (d) => { if (process.env.DEBUG) process.stderr.write(d); });
  await waitFor(async () => { try { return (await fetch(`${BASE}/healthz`)).ok; } catch { return false; } }, 15000);
});
after(() => { guest?.close(); proc?.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('M1 主流程', async () => {
  // 主持人注册
  const reg = await api('POST', '/api/auth/register', { email: 'host@example.com', password: 'password123' });
  assert.equal(reg.status, 200);
  const H = { authorization: `Bearer ${reg.json.token}` };

  // 创建会议（含参会方 → 预加载主体速览卡）
  const created = await api('POST', '/api/meetings', { title: '宠物品牌合作洽谈', preset: 'brainstorm', counterparties: ['汪星人科技'], card_language: 'zh' }, H);
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const m = created.json.meeting;
  assert.match(m.join_code, /^\d{6}$/);
  assert.ok(m.links.screen.includes(m.id));

  // 参会者扫码加入（口令 + 昵称，免登录）
  const join = await api('POST', '/api/join', { code: m.join_code, nickname: '小王' });
  assert.equal(join.status, 200);
  const G = { 'x-participant-token': join.json.participantToken };
  assert.equal((await api('POST', '/api/join', { code: '000000', nickname: 'x' })).status, 404);

  // 参会者 socket 同步
  const events: { ev: string; data: any }[] = [];
  guest = ioc(BASE, { auth: { meetingId: m.id, participantToken: join.json.participantToken }, transports: ['websocket'] });
  guest!.onAny((ev, data) => events.push({ ev, data }));
  await waitFor(() => guest!.connected);

  // 开始会议必须先确认告知
  assert.equal((await api('PATCH', `/api/meetings/${m.id}`, { status: 'live' }, H)).status, 400);
  assert.equal((await api('PATCH', `/api/meetings/${m.id}`, { status: 'live', consent: true }, H)).status, 200);

  // 预加载卡：提到参会方时直接上屏
  await waitFor(async () => (await api('GET', `/api/meetings/${m.id}`, undefined, H)).json.cards.find((c: any) => c.origin === 'preload'), 5000);
  await api('POST', `/api/meetings/${m.id}/transcript`, { text: '今天主要和汪星人科技聊一下合作方式', speaker: 'S1' }, H);
  const preCard = await waitFor(() => events.find((e) => (e.ev === 'card.update' || e.ev === 'card.new') && e.data.origin === 'preload' && e.data.status === 'published')?.data);
  assert.equal(preCard.type, 'entity_brief');

  // 发言 → 判定 → 出卡（数据参考卡必须带来源）
  await api('POST', `/api/meetings/${m.id}/transcript`, { text: '这个宠物用品市场现在到底有多大？增长快不快？', speaker: 'S2' }, H);
  await api('POST', `/api/meetings/${m.id}/judge-now`, {}, H);
  const dataCard = await waitFor(() => events.find((e) => e.ev === 'card.new' && e.data.type === 'data_reference')?.data, 8000);
  assert.ok(dataCard.sources.length >= 1, 'factual card has sources');
  assert.ok(dataCard.title.length <= 16);
  assert.ok(events.some((e) => e.ev === 'ai.status' && e.data.state === 'thinking'));

  // 复述识别：朗读卡片内容不再出卡
  const before = events.filter((e) => e.ev === 'card.new').length;
  const echoSeg = (await api('POST', `/api/meetings/${m.id}/transcript`, { text: dataCard.body.replace('[演示] ', ''), speaker: 'S1' }, H)).json;
  assert.equal(echoSeg.echo_of_card_id, dataCard.id, 'reading the card aloud is marked as echo');
  await api('POST', `/api/meetings/${m.id}/judge-now`, {}, H);
  await sleep(1500);
  assert.equal(events.filter((e) => e.ev === 'card.new').length, before, 'echo does not trigger a new card');

  // 语音指令（唤醒词）+ 话题触发预约
  await api('POST', `/api/meetings/${m.id}/transcript`, { text: '插一句，讨论到定价的时候，给一些竞品价格数据', speaker: 'S1' }, H);
  const ack = await waitFor(() => events.find((e) => e.ev === 'request.ack')?.data, 3000);
  assert.equal(ack.request.mode, 'on_topic');
  assert.equal(ack.request.topic, '定价');
  await api('POST', `/api/meetings/${m.id}/transcript`, { text: '那我们接下来说说定价吧', speaker: 'S2' }, H);
  await waitFor(() => events.find((e) => e.ev === 'request.update' && e.data.id === ack.request.id && e.data.status === 'published'), 6000);

  // 文字提问
  const q = await api('POST', `/api/meetings/${m.id}/questions`, { text: 'DTC 是什么意思？' }, G);
  assert.equal(q.status, 200);
  const ans = await waitFor(() => events.find((e) => e.ev === 'card.new' && e.data.origin === 'question')?.data, 6000);
  assert.equal(ans.asked_by, '小王');

  // 稍后预约 → ready（参会者看不到）→ 主持人点展示
  const later = await api('POST', `/api/meetings/${m.id}/requests`, { text: '等会儿给我们准备一张宠物 DTC 品牌的案例卡' }, G);
  assert.equal(later.json.mode, 'later');
  await waitFor(async () => (await api('GET', `/api/meetings/${m.id}/requests`, undefined, H)).json.find((r: any) => r.id === later.json.id && r.status === 'ready'), 6000);
  const guestView = await api('GET', `/api/meetings/${m.id}`, undefined, G);
  assert.ok(!guestView.json.cards.some((c: any) => c.request_id === later.json.id), 'ready card hidden from guests');
  await api('PATCH', `/api/requests/${later.json.id}`, { action: 'show_now' }, H);
  await waitFor(() => events.find((e) => (e.ev === 'card.update' || e.ev === 'card.new') && e.data.request_id === later.json.id && e.data.status === 'published'), 3000);

  // 反馈
  const r1 = await api('POST', `/api/cards/${dataCard.id}/reactions`, { kind: 'useful' }, G);
  assert.equal(r1.json.useful, 1);

  // 主持人隐藏卡片 → 参会者端移除
  await api('PATCH', `/api/cards/${ans.id}`, { status: 'hidden' }, H);
  await waitFor(() => events.find((e) => e.ev === 'card.remove' && e.data.id === ans.id), 2000);

  // 结束 → 纪要
  await api('POST', `/api/meetings/${m.id}/transcript`, { text: '小李下周五前负责把报价单发过去', speaker: 'S2' }, H);
  assert.equal((await api('PATCH', `/api/meetings/${m.id}`, { status: 'ended' }, H)).status, 200);
  const mins = await waitFor(async () => { const r = await api('GET', `/api/meetings/${m.id}/minutes`, undefined, H); return r.json.minutes?.status === 'ready' ? r.json : undefined; }, 6000);
  assert.ok(mins.minutes.action_items.length >= 1);
  assert.ok(mins.metrics.cardsShown >= 4);

  // 对外分享与导出不含未上屏卡片
  const share = await api('POST', `/api/meetings/${m.id}/share`, { enabled: true }, H);
  const shared = await api('GET', `/api/share/${share.json.share_token}`);
  assert.ok(shared.json.cards.every((c: any) => c.status === 'published'));
  assert.ok(!shared.json.cards.some((c: any) => c.id === ans.id));
  const md = await api('GET', `/api/meetings/${m.id}/export?format=md`, undefined, H);
  assert.ok(String(md.json).includes('宠物品牌合作洽谈'));

  // 会议结束后口令失效
  assert.equal((await api('POST', '/api/join', { code: m.join_code, nickname: 'late' })).status, 404);

  // 用量计量
  const u = await api('GET', '/api/usage', undefined, H);
  assert.ok(u.json.month.some((x: any) => x.kind === 'cards' && x.quantity >= 4));

});
