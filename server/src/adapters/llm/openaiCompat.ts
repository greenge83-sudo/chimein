/**
 * OpenAI 兼容接口：覆盖 DeepSeek / GLM / Qwen / Kimi / MiniMax 等中国大陆区模型（需求 6.3）。
 * 使用 JSON 模式 + zod 校验；校验失败重试一次并附上错误信息。
 */
import { z } from 'zod';
import { config } from '../../config.js';
import type { LLMProvider, LLMRequest, LLMResult } from './types.js';

export const openaiCompatProvider: LLMProvider = {
  name: 'openai_compat',
  async json<T>(req: LLMRequest<T>, model: string): Promise<LLMResult<T>> {
    const { baseUrl, apiKey } = config.llm.openaiCompat;
    if (!baseUrl || !apiKey) throw new Error('OPENAI_COMPAT_BASE_URL / OPENAI_COMPAT_API_KEY not configured');
    const schemaHint = JSON.stringify(z.toJSONSchema(req.schema as any));
    const messages: { role: string; content: string }[] = [
      { role: 'system', content: `${req.system}\n\nRespond with ONLY a JSON object matching this JSON Schema:\n${schemaHint}` },
      { role: 'user', content: req.user },
    ];
    let inTok = 0, outTok = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = AbortSignal.timeout(req.role === 'minutes' ? 180_000 : 30_000);
      const r = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', signal: ctrl,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, response_format: { type: 'json_object' }, max_tokens: req.maxTokens ?? (req.role === 'minutes' ? 8000 : 2000) }),
      });
      if (!r.ok) throw new Error(`openai_compat HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
      const j: any = await r.json();
      inTok += j.usage?.prompt_tokens ?? 0; outTok += j.usage?.completion_tokens ?? 0;
      const text: string = j.choices?.[0]?.message?.content ?? '';
      try {
        const parsed = req.schema.parse(JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')));
        return { data: parsed, provider: 'openai_compat', model, inputTokens: inTok, outputTokens: outTok };
      } catch (e) {
        messages.push({ role: 'assistant', content: text }, { role: 'user', content: `Invalid JSON for the schema: ${String(e).slice(0, 500)}. Return corrected JSON only.` });
      }
    }
    throw new Error('openai_compat: invalid JSON after retry');
  },
};
