import type { z } from 'zod';

export type LLMRole = 'judge' | 'generate' | 'minutes' | 'command';

export interface LLMRequest<T> {
  role: LLMRole;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  /** 结构化原始输入，仅供 mock provider 生成演示结果使用 */
  input: any;
  maxTokens?: number;
}

export interface LLMResult<T> {
  data: T;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LLMProvider {
  name: string;
  json<T>(req: LLMRequest<T>, model: string): Promise<LLMResult<T>>;
}
