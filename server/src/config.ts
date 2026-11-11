import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';

const env = (k: string, d = '') => process.env[k] ?? d;

export type Region = 'global' | 'cn';
export type Preset = 'external' | 'brainstorm' | 'review' | 'project' | 'casual';
export type Frequency = 'quiet' | 'standard' | 'active';
export type CardType =
  | 'knowledge'
  | 'data_reference'
  | 'fact_check'
  | 'entity_brief'
  | 'case_study'
  | 'inspiration'
  | 'discussion_summary'
  | 'answer'
  | 'iteration';

export const CARD_TYPES: CardType[] = [
  'knowledge', 'data_reference', 'fact_check', 'entity_brief', 'case_study',
  'inspiration', 'discussion_summary', 'answer', 'iteration',
];

/** 事实类卡片：必须带来源、受置信度门槛约束（需求 4.2 / 4.3 / 九） */
export const FACTUAL_TYPES: CardType[] = ['data_reference', 'fact_check', 'entity_brief', 'case_study'];
/** 需要联网检索的卡片类型 */
export const SEARCH_TYPES: CardType[] = ['data_reference', 'fact_check', 'entity_brief', 'case_study'];

export const config = {
  region: (env('DEPLOY_REGION', 'global') as Region),
  port: Number(env('PORT', '8787')),
  publicUrl: env('PUBLIC_URL', 'http://localhost:5173').replace(/\/$/, ''),
  dataDir: path.resolve(env('DATA_DIR', './data')),
  isProd: env('NODE_ENV') === 'production',

  llm: {
    judge: { provider: env('LLM_JUDGE_PROVIDER', 'mock'), model: env('LLM_JUDGE_MODEL', 'claude-haiku-5-5') },
    generate: { provider: env('LLM_GENERATE_PROVIDER', 'mock'), model: env('LLM_GENERATE_MODEL', 'claude-sonnet-5-5') },
    minutes: { provider: env('LLM_MINUTES_PROVIDER', 'mock'), model: env('LLM_MINUTES_MODEL', 'claude-opus-5-5') },
    fallback: { provider: env('LLM_FALLBACK_PROVIDER'), model: env('LLM_FALLBACK_MODEL') },
    openaiCompat: { baseUrl: env('OPENAI_COMPAT_BASE_URL'), apiKey: env('OPENAI_COMPAT_API_KEY') },
  },
  search: {
    provider: env('SEARCH_PROVIDER', 'mock'),
    tavilyKey: env('TAVILY_API_KEY'),
    bochaKey: env('BOCHA_API_KEY'),
    maxQueries: 3,
    timeoutMs: 5000,
  },
  asr: {
    provider: env('ASR_PROVIDER', 'browser'),
    sonioxKey: env('SONIOX_API_KEY'),
    assemblyaiKey: env('ASSEMBLYAI_API_KEY'),
  },
  embed: {
    provider: env('EMBED_PROVIDER', 'local'),
    baseUrl: env('EMBED_BASE_URL'),
    apiKey: env('EMBED_API_KEY'),
    model: env('EMBED_MODEL'),
  },
};

/**
 * 出卡策略可调参数（需求 4.3：上述数字均为初始值，做成后台可配置项）。
 * 读取 data/tuning.json 覆盖默认值，无需改代码。
 */
export const defaultTuning = {
  judgeEveryMs: 30_000,
  windowMs: 3 * 60_000,
  valueThreshold: 0.7,
  confidenceThreshold: 0.6,
  echoSemanticThreshold: 0.8,
  echoLexicalThreshold: 0.6,
  echoCompareRecentCards: 10,
  duplicateCardThreshold: 0.85,
  summaryEveryMs: 18 * 60_000,
  laterAutoShowSilenceMs: 15_000,
  frequency: {
    quiet: { intervalFactor: 1.5, thresholdDelta: +0.1 },
    standard: { intervalFactor: 1, thresholdDelta: 0 },
    active: { intervalFactor: 0.6, thresholdDelta: -0.1 },
  } as Record<Frequency, { intervalFactor: number; thresholdDelta: number }>,
  /** 每张卡片被点"无关"多于"有用"多少次后，该类型分值降权 */
  irrelevantPenaltyPerVote: 0.05,
  wakeWords: { zh: ['插一句'], en: ['chimein', 'chime in'] },
  cardLimits: { title: 16, body: 80, bullets: 3, bullet: 30, titleEn: 60, bodyEn: 320, bulletEn: 110 },
};
export type Tuning = typeof defaultTuning;

export function loadTuning(): Tuning {
  const p = path.join(config.dataDir, 'tuning.json');
  try {
    if (fs.existsSync(p)) return deepMerge(structuredClone(defaultTuning), JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch (e) {
    console.warn('[tuning] failed to read tuning.json, using defaults', e);
  }
  return structuredClone(defaultTuning);
}

function deepMerge<T>(a: T, b: any): T {
  for (const k of Object.keys(b ?? {})) {
    const av = (a as any)[k];
    if (av && typeof av === 'object' && !Array.isArray(av)) deepMerge(av, b[k]);
    else (a as any)[k] = b[k];
  }
  return a;
}

/** 会议类型预设（需求第二节） */
export const PRESETS: Record<Preset, {
  persona: { zh: string; en: string };
  minIntervalMs: number;
  preferred: CardType[];
}> = {
  external: {
    persona: { zh: '克制、中性', en: 'restrained and neutral' },
    minIntervalMs: 3 * 60_000,
    preferred: ['entity_brief', 'knowledge', 'data_reference'],
  },
  brainstorm: {
    persona: { zh: '活跃、发散', en: 'lively and divergent' },
    minIntervalMs: 90_000,
    preferred: ['case_study', 'inspiration'],
  },
  review: {
    persona: { zh: '严谨', en: 'rigorous' },
    minIntervalMs: 3 * 60_000,
    preferred: ['data_reference', 'fact_check', 'discussion_summary'],
  },
  project: {
    persona: { zh: '安静', en: 'quiet' },
    minIntervalMs: 5 * 60_000,
    preferred: ['knowledge', 'discussion_summary'],
  },
  casual: {
    persona: { zh: '轻松、口语化', en: 'relaxed and conversational' },
    minIntervalMs: 2 * 60_000,
    preferred: ['knowledge', 'case_study', 'inspiration'],
  },
};

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'audio'), { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'uploads'), { recursive: true });
