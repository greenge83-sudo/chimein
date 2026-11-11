import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chimein-unit-'));
const { lexicalContainment, localEmbed, cosine } = await import('../src/adapters/embed/index.js');
const { validateAndNormalize } = await import('../src/pipeline/cardgen.js');
const { defaultTuning } = await import('../src/config.js');

const card = '按公开行业报告口径，2025 年中国宠物用品市场规模约 3000 亿元，年增速约 8%。线上渠道占比超过一半。';

test('复述识别：朗读或轻微改写卡片内容判为复述', () => {
  assert.ok(lexicalContainment('中国宠物用品市场规模约3000亿元，年增速约8%', card) >= defaultTuning.echoLexicalThreshold);
  assert.ok(lexicalContainment('线上渠道占比超过一半', card) >= defaultTuning.echoLexicalThreshold);
});

test('复述识别：新观点、短应答不判为复述', () => {
  assert.ok(lexicalContainment('那我们的线下门店要不要做会员体系', card) < defaultTuning.echoLexicalThreshold);
  assert.equal(lexicalContainment('对', card), 0);
  assert.ok(cosine(localEmbed(card), localEmbed('今天天气不错，我们先吃饭吧')) < defaultTuning.echoSemanticThreshold);
});

const meeting: any = { card_language: 'zh', is_important: false };
const job: any = { type: 'data_reference', parentCardId: null };
const results = [{ title: '报告', url: 'https://a.example/report', snippet: '' }];
const out = (o: any) => ({ type: 'data_reference', language: 'zh', title: '宠物用品市场规模', body: '正文', bullets: [], sources: [], parent_card_id: null, increment: null, confidence: 0.8, ...o });

test('校验：事实类卡片必须有来源，且来源只能来自搜索结果', () => {
  assert.equal(typeof validateAndNormalize(out({ sources: [] }), job, meeting, defaultTuning, results), 'string');
  assert.equal(typeof validateAndNormalize(out({ sources: [{ title: 'x', url: 'https://made.up/x' }] }), job, meeting, defaultTuning, results), 'string');
  const ok = validateAndNormalize(out({ sources: [{ title: '报告', url: 'https://a.example/report' }] }), job, meeting, defaultTuning, results);
  assert.equal(typeof ok, 'object');
});

test('校验：置信度 < 0.6 不推送；字数截断', () => {
  const low = validateAndNormalize(out({ sources: [{ title: '报告', url: 'https://a.example/report' }], confidence: 0.5 }), job, meeting, defaultTuning, results);
  assert.equal(typeof low, 'string');
  const long = validateAndNormalize(out({ title: '一'.repeat(30), body: '二'.repeat(200), bullets: ['a', 'b', 'c', 'd'], sources: [{ title: '报告', url: 'https://a.example/report' }] }),
    job, meeting, defaultTuning, results) as any;
  assert.ok(long.title.length <= 16 && long.body.length <= 80 && long.bullets.length <= 3);
});

test('校验：迭代卡必须有增量说明', () => {
  const it: any = { type: 'iteration', parentCardId: 'c1' };
  assert.equal(typeof validateAndNormalize(out({ type: 'iteration', increment: '' }), it, meeting, defaultTuning, []), 'string');
  assert.equal(typeof validateAndNormalize(out({ type: 'iteration', increment: '新增了 2026 年数据' }), it, meeting, defaultTuning, []), 'object');
});
