import { useSyncExternalStore } from 'react';

export type Lang = 'zh' | 'en';
const dict = {
  appName: ['插一句', 'ChimeIn'],
  tagline: ['会议里的 AI 搭子：关键时刻插一句', 'An AI teammate that chimes in at the right moment'],
  login: ['登录', 'Log in'], register: ['注册', 'Sign up'], logout: ['退出', 'Log out'],
  email: ['邮箱', 'Email'], password: ['密码（至少 8 位）', 'Password (8+ chars)'], name: ['称呼', 'Name'],
  noAccount: ['还没有账号？注册', 'No account? Sign up'], hasAccount: ['已有账号？登录', 'Have an account? Log in'],
  meetings: ['我的会议', 'My meetings'], newMeeting: ['新建会议', 'New meeting'], search: ['按标题、参会方、日期搜索', 'Search title, counterparty, date'],
  noMeetings: ['还没有会议，先新建一场', 'No meetings yet'], cards: ['卡片', 'cards'], duration: ['时长', 'Duration'],
  title: ['会议主题', 'Title'], preset: ['会议类型', 'Meeting type'], agenda: ['议程（可选）', 'Agenda (optional)'],
  counterparties: ['参会方公司 / 品牌（可选，逗号分隔）', 'Counterparties (optional, comma separated)'],
  background: ['背景资料（可选，粘贴文字）', 'Background notes (optional)'], uploadFile: ['上传 PDF / Word', 'Upload PDF / Word'],
  meetingLang: ['会议主语言', 'Spoken language'], cardLang: ['卡片语言', 'Card language'], important: ['重要会议（事实核对、对方主体速览先审后上屏）', 'Important meeting (review fact-checks before showing)'],
  create: ['创建会议', 'Create'], creating: ['创建中…', 'Creating…'],
  'preset.external': ['对外洽谈', 'External negotiation'], 'preset.brainstorm': ['头脑风暴', 'Brainstorm'], 'preset.review': ['经营分析 / 周例会', 'Business review'],
  'preset.project': ['项目进展会', 'Project update'], 'preset.casual': ['自由讨论', 'Casual discussion'],
  'lang.auto': ['自动（中英混说）', 'Auto (mixed)'], 'lang.zh': ['中文', 'Chinese'], 'lang.en': ['英文', 'English'], 'lang.bilingual': ['中英双语', 'Bilingual'],
  joinLink: ['参会者链接', 'Join link'], screenLink: ['大屏链接（会议室电脑打开并投屏）', 'Screen link (open on the room PC)'],
  hostLink: ['主持人控制台', 'Host console'], code: ['会议口令', 'Code'], copy: ['复制', 'Copy'], copied: ['已复制', 'Copied'], open: ['打开', 'Open'],
  enterConsole: ['进入控制台', 'Open console'],
  joinTitle: ['加入会议', 'Join meeting'], nickname: ['昵称', 'Nickname'], join: ['加入', 'Join'], invalidCode: ['口令不对，或会议已结束', 'Wrong code or meeting ended'],
  'ai.listening': ['聆听中', 'Listening'], 'ai.thinking': ['思考中', 'Thinking'], 'ai.paused': ['已暂停', 'Paused'], 'ai.away': ['AI 暂时离席', 'AI is away'],
  checking: ['正在查', 'Looking up'], aiListeningBadge: ['AI 正在聆听', 'AI is listening'],
  start: ['开始会议', 'Start'], resume: ['继续会议', 'Resume'], pause: ['暂停会议', 'Pause'], end: ['结束会议', 'End meeting'],
  consent: ['请告知参会方：本会议将被 AI 转写。确认已告知后开始。', 'Please inform attendees that this meeting will be transcribed by AI. Confirm to start.'],
  confirmEnd: ['确定结束会议？结束后将生成纪要。', 'End the meeting and generate minutes?'],
  aiOn: ['AI 出卡', 'AI cards'], frequency: ['出卡频率', 'Frequency'], 'freq.quiet': ['安静', 'Quiet'], 'freq.standard': ['标准', 'Standard'], 'freq.active': ['活跃', 'Active'],
  subtitles: ['大屏字幕', 'Screen subtitles'], summaryNow: ['立即出一张小结', 'Summarize now'], judgeNow: ['立即判定', 'Evaluate now'],
  mic: ['麦克风', 'Microphone'], online: ['在线', 'online'], transcript: ['实时转写（仅主持人可见）', 'Live transcript (host only)'],
  simulate: ['模拟发言（无麦克风测试用）', 'Simulate speech (testing)'], speaker: ['说话人', 'Speaker'], send: ['发送', 'Send'],
  reviewQueue: ['待审核', 'Review queue'], approve: ['上屏', 'Show'], hide: ['隐藏', 'Hide'], unhide: ['恢复', 'Unhide'], pin: ['置顶', 'Pin'], unpin: ['取消置顶', 'Unpin'],
  focus: ['聚焦', 'Focus'], unfocus: ['取消聚焦', 'Unfocus'], standby: ['备用', 'Standby'], ready: ['已就绪', 'Ready'],
  useful: ['有用', 'Useful'], irrelevant: ['无关', 'Not relevant'], save: ['收藏', 'Save'], saved: ['已收藏', 'Saved'], deepdive: ['深挖', 'Dig deeper'],
  sources: ['来源', 'Sources'], because: ['因为刚才提到', 'Because someone said'], update: ['更新', 'Update'], askedBy: ['提问人', 'Asked by'],
  askAI: ['问 AI，或预约一张卡（如"等会儿给我们准备…"）', 'Ask AI, or request a card ("later, prepare…")'],
  requests: ['预约中', 'Requests'], 'req.queued': ['排队', 'Queued'], 'req.preparing': ['准备中', 'Preparing'], 'req.ready': ['已就绪', 'Ready'],
  'req.published': ['已展示', 'Shown'], 'req.cancelled': ['已取消', 'Cancelled'], 'req.failed': ['未能生成', 'Failed'],
  cancel: ['取消', 'Cancel'], showNow: ['展示', 'Show'], received: ['已收到', 'Got it'], clarify: ['AI 的理解，不对可取消', 'AI understood this — cancel if wrong'],
  noCards: ['AI 在听，值得插话时会出卡', 'AI is listening and will chime in when it matters'],
  waitingStart: ['会议尚未开始', 'Meeting has not started'], ended: ['会议已结束', 'Meeting ended'], viewSummary: ['查看纪要', 'View minutes'],
  minutes: ['会议纪要', 'Minutes'], generating: ['纪要生成中…', 'Generating minutes…'], minutesFailed: ['纪要生成失败', 'Minutes failed'], regenerate: ['重新生成', 'Regenerate'],
  edit: ['编辑', 'Edit'], saveEdit: ['保存', 'Save'], summary: ['会议概要', 'Summary'], topics: ['议题与结论', 'Topics'], decisions: ['决定', 'Decisions'],
  actions: ['待办', 'Action items'], owner: ['负责人', 'Owner'], due: ['时间', 'Due'], speakerPoints: ['分人发言要点', 'By speaker'],
  cardReview: ['卡片回顾（按"有用"排序）', 'Cards (by usefulness)'], fullTranscript: ['转写全文', 'Full transcript'],
  exportMd: ['导出 Markdown', 'Export Markdown'], print: ['打印 / 存 PDF', 'Print / PDF'], share: ['生成分享链接', 'Create share link'], unshare: ['关闭分享', 'Disable sharing'],
  shareNote: ['分享链接只包含已上屏卡片', 'Shared link only includes shown cards'], deleteMeeting: ['删除整场会议', 'Delete meeting'],
  confirmDelete: ['删除后转写、卡片、纪要、录音全部清除，不可恢复。确定？', 'Delete transcript, cards, minutes and audio permanently?'],
  renameSpeaker: ['说话人命名', 'Rename speakers'], metrics: ['本场指标', 'Metrics'], usefulRate: ['有用率', 'Useful rate'], irrelevantRate: ['无关率', 'Irrelevant rate'],
  echoes: ['复述片段', 'Echo segments'], reqDone: ['预约完成', 'Requests done'], p90: ['出卡延迟 P90', 'Card latency P90'], usage: ['用量', 'Usage'],
  minutesToGuests: ['允许参会者查看纪要', 'Let attendees view minutes'], back: ['返回', 'Back'], scanToJoin: ['扫码加入', 'Scan to join'],
  micDenied: ['无法使用麦克风：', 'Microphone unavailable: '], browserAsrNote: ['当前使用浏览器自带识别（试用，无说话人分离），建议 Chrome。', 'Using browser speech recognition (trial; no speaker separation). Chrome recommended.'],
  materials: ['背景资料', 'Materials'], wakeHint: ['唤醒词', 'Wake word'], screen: ['大屏', 'Screen'],
} as const;
export type Key = keyof typeof dict;

let lang: Lang = (() => {
  try { const s = localStorage.getItem('lang'); if (s === 'zh' || s === 'en') return s; } catch { /* ignore */ }
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
})();
const subs = new Set<() => void>();
export function setLang(l: Lang) { lang = l; try { localStorage.setItem('lang', l); } catch { /* ignore */ } document.documentElement.lang = l; subs.forEach((f) => f()); }
export function getLang() { return lang; }
export function useLang() { return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => lang); }
export function t(k: Key): string { const v = dict[k]; return v ? v[lang === 'zh' ? 0 : 1] : k; }
export function useT() { useLang(); return t; }
