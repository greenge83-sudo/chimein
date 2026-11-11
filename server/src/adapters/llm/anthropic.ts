import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { LLMProvider, LLMRequest, LLMResult } from './types.js';

let client: Anthropic | null = null;
const getClient = () => (client ??= new Anthropic({ maxRetries: 1 }));

/** 判定要快：低 effort；生成卡片：中；纪要：要质量 */
const EFFORT: Record<string, 'low' | 'medium' | 'high'> = { judge: 'low', command: 'low', generate: 'medium', minutes: 'high' };
/** 支持服务端拒答兜底的模型（Haiku 没有服务端 fallback） */
const SERVER_FALLBACK = /^claude-(sonnet|opus|fable)-/;

export const anthropicProvider: LLMProvider = {
  name: 'anthropic',
  async json<T>(req: LLMRequest<T>, model: string): Promise<LLMResult<T>> {
    const useFallback = SERVER_FALLBACK.test(model);
    const res = await getClient().beta.messages.parse(
      {
        model,
        max_tokens: req.maxTokens ?? (req.role === 'minutes' ? 16000 : 4000),
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: req.user }],
        output_config: { effort: EFFORT[req.role] ?? 'medium', format: betaZodOutputFormat(req.schema as any) },
        ...(useFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      },
      { timeout: req.role === 'minutes' ? 180_000 : 30_000 },
    );
    if (res.stop_reason === 'refusal') throw new Error(`anthropic refusal (${(res as any).stop_details?.category ?? 'unknown'})`);
    if (res.stop_reason === 'max_tokens') throw new Error('anthropic output truncated (max_tokens)');
    if (res.parsed_output == null) throw new Error('anthropic returned no parsable JSON');
    return {
      data: res.parsed_output as T,
      provider: 'anthropic',
      model: res.model,
      inputTokens: res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0),
      outputTokens: res.usage.output_tokens,
    };
  },
};
