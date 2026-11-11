import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../../config.js';
import { usage } from '../../db.js';
import { anthropicProvider } from './anthropic.js';
import { openaiCompatProvider } from './openaiCompat.js';
import { mockProvider } from './mock.js';
import type { LLMProvider, LLMRequest, LLMResult, LLMRole } from './types.js';

export type { LLMRole } from './types.js';

const providers: Record<string, LLMProvider> = {
  anthropic: anthropicProvider, openai_compat: openaiCompatProvider, mock: mockProvider,
};

function route(role: LLMRole) {
  const r = role === 'command' ? config.llm.judge : config.llm[role];
  return { provider: providers[r.provider] ?? mockProvider, model: r.model };
}

/** 粗略成本估算（美元 / 百万 token），用于 usage_records，后台按场看成本 */
const PRICE: Record<string, [number, number]> = {
  'claude-haiku-5-5': [0.1, 0.5], 'claude-sonnet-5-5': [2, 10], 'claude-opus-5-5': [4, 20],
};

export async function llmJson<T>(req: LLMRequest<T>, meta: { userId: string; meetingId: string | null }): Promise<LLMResult<T>> {
  const primary = route(req.role);
  const attempts: { provider: LLMProvider; model: string }[] = [primary];
  const fb = config.llm.fallback;
  if (fb.provider && providers[fb.provider]) attempts.push({ provider: providers[fb.provider], model: fb.model });
  let lastErr: unknown;
  for (const a of attempts) {
    try {
      const res = await a.provider.json(req, a.model);
      const [pi, po] = PRICE[res.model] ?? [0, 0];
      const tokens = res.inputTokens + res.outputTokens;
      if (tokens > 0) usage.record(meta.userId, meta.meetingId, 'llm_tokens', tokens, (res.inputTokens * pi + res.outputTokens * po) / 1e6,
        { role: req.role, model: res.model, in: res.inputTokens, out: res.outputTokens });
      return res;
    } catch (e) {
      lastErr = e;
      console.warn(`[llm] ${req.role} via ${a.provider.name}/${a.model} failed:`, (e as Error).message);
    }
  }
  throw lastErr;
}

// ---------- Prompt 模板：放在配置文件里，不写死在代码中（需求 8.4 末尾）----------
const here = path.dirname(fileURLToPath(import.meta.url));
const builtinDir = path.resolve(here, '../../prompts');
export function prompt(name: 'judge' | 'generate' | 'command' | 'minutes', vars: Record<string, string>) {
  const override = path.join(config.dataDir, 'prompts', `${name}.md`);
  const file = fs.existsSync(override) ? override : path.join(builtinDir, `${name}.md`);
  return fs.readFileSync(file, 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}
