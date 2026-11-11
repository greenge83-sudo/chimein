import { z } from 'zod';

const CardTypeEnum = z.enum([
  'knowledge', 'data_reference', 'fact_check', 'entity_brief', 'case_study', 'inspiration', 'discussion_summary', 'answer', 'iteration',
]);

/** 8.1 判定输出 */
export const JudgeSchema = z.object({
  should_card: z.boolean(),
  card_type: CardTypeEnum.nullable(),
  value_score: z.number().describe('0-1'),
  reason: z.string(),
  trigger_quote: z.string(),
  search_queries: z.array(z.string()),
  entities: z.array(z.string()),
  parent_card_id: z.string().nullable(),
  is_instruction: z.boolean(),
  instruction_text: z.string().nullable(),
  matched_request_id: z.string().nullable(),
  needs_review: z.boolean(),
});
export type JudgeOut = z.infer<typeof JudgeSchema>;

/** 8.2 生成输出 */
export const GenerateSchema = z.object({
  type: CardTypeEnum,
  language: z.string(),
  title: z.string(),
  body: z.string(),
  bullets: z.array(z.string()),
  sources: z.array(z.object({ title: z.string(), url: z.string() })),
  parent_card_id: z.string().nullable(),
  increment: z.string().nullable(),
  confidence: z.number().describe('0-1'),
});
export type GenerateOut = z.infer<typeof GenerateSchema>;

/** 8.4 指令解析输出 */
export const CommandSchema = z.object({
  mode: z.enum(['now', 'later', 'on_topic', 'at_time']),
  card_type: CardTypeEnum.nullable(),
  topic: z.string().nullable(),
  request_summary: z.string(),
  search_queries: z.array(z.string()),
  due_in_seconds: z.number().nullable(),
  needs_clarification: z.boolean(),
});
export type CommandOut = z.infer<typeof CommandSchema>;

/** 8.3 纪要输出 */
export const MinutesSchema = z.object({
  summary_md: z.string(),
  topics: z.array(z.object({ title: z.string(), conclusion: z.string() })),
  decisions: z.array(z.string()),
  action_items: z.array(z.object({ task: z.string(), owner: z.string().nullable(), due: z.string().nullable() })),
  speaker_points: z.array(z.object({ speaker: z.string(), points: z.array(z.string()) })),
});
export type MinutesOut = z.infer<typeof MinutesSchema>;
