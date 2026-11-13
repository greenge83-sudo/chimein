import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';

const env = (k: string, d = '') => process.env[k] ?? d;

export type Region = 'global' | 'cn';
export type Preset = 'external' | 'brainstorm' | 'review' | 'project' | 'casual' | 'interview';
export const PRESET_IDS: Preset[] = ['external', 'brainstorm', 'review', 'project', 'casual', 'interview'];
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
  isProd: env('NODE_ENV') === 'production' || process.env.npm_lifecycle_event === 'start',

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
  /**
   * 卡片给谁看：room = 在场所有人（内部会议，可投大屏）；
   * our_side = 只给我方成员（面试、对外拜访），卡片只在我方手机上同步，不建议投屏、口令不要给对方。
   */
  audience: 'room' | 'our_side';
  /** 注入判定 / 生成 / 纪要 Prompt 的场景说明 */
  guidance?: string;
}> = {
  external: {
    persona: { zh: '克制、中性', en: 'restrained and neutral' },
    minIntervalMs: 3 * 60_000,
    preferred: ['entity_brief', 'knowledge', 'data_reference'],
    audience: 'our_side',
    guidance: '这是对外洽谈 / 第三方拜访沟通。卡片只给我方成员看。重点：对方公司与品牌的公开信息、对方提到的行业数据与说法的核对、我方可以追问的问题。',
  },
  brainstorm: {
    persona: { zh: '活跃、发散', en: 'lively and divergent' },
    minIntervalMs: 90_000,
    preferred: ['case_study', 'inspiration'],
    audience: 'room',
  },
  review: {
    persona: { zh: '严谨', en: 'rigorous' },
    minIntervalMs: 3 * 60_000,
    preferred: ['data_reference', 'fact_check', 'discussion_summary'],
    audience: 'room',
  },
  project: {
    persona: { zh: '安静', en: 'quiet' },
    minIntervalMs: 5 * 60_000,
    preferred: ['knowledge', 'discussion_summary'],
    audience: 'room',
  },
  casual: {
    persona: { zh: '轻松、口语化', en: 'relaxed and conversational' },
    minIntervalMs: 2 * 60_000,
    preferred: ['knowledge', 'case_study', 'inspiration'],
    audience: 'room',
  },
  interview: {
    persona: { zh: '中性、克制、只陈述公开信息', en: 'neutral, restrained, public facts only' },
    minIntervalMs: 2 * 60_000,
    preferred: ['fact_check', 'knowledge', 'inspiration'],
    audience: 'our_side',
    guidance: [
      '这是一场招聘面试，卡片只给面试官看，候选人看不到。目标是帮面试官把候选人说的内容和公开信息对上、并给出可以追问的问题。',
      '可以核对：候选人提到的公司、产品、项目的公开信息（成立时间、规模、业务、公开事件、发布时间等），行业数据，技术概念与术语。',
      '不得做：检索候选人本人的个人信息、社交账号或私生活；判断候选人是否诚实或"说谎"；对候选人打分或给出录用建议；涉及年龄、性别、婚育、民族、宗教、健康、籍贯等与岗位无关的话题一律不出卡。',
      '与公开信息不一致时，只写"公开信息显示……"，并给 1-2 个中性的追问建议（例如"可请候选人说明当时团队规模"），由面试官自己判断。',
      '讨论停滞或候选人回答笼统时，可以出"灵感追问"卡，给出能验证真实经历的追问（具体做了什么、数据口径、遇到的困难）。',
    ].join('\n'),
  },
};

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'audio'), { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'uploads'), { recursive: true });
