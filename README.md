# 插一句 ChimeIn — AI 脑爆伴侣

依据《AI 脑爆伴侣 — 开发需求文档 v0.2》实现。当前版本覆盖 **M0 技术验证全链路 + M1 MVP 的全部 P0**，并顺带完成了 M2 中成本较低的几项 P1。

```
主持人浏览器收音 ──WebSocket──▶ 实时网关 ──▶ 流式语音识别（可替换）
                                   │
                ┌──────────────────┴──────────────────┐
           大脑一 · 记录员                       大脑二 · 伴侣（核心）
           转写入库 → 会后纪要           复述过滤/指令识别 → ① 判定 → ② 检索 → ③ 生成 → 校验/去重/分流
                                                          │
                                         按会议分房间推送：主持人控制台 / 大屏 / 手机
```

## 快速开始

```bash
npm install
```

```bash
cp .env.example .env
```

```bash
npm run dev
```

**Windows（PowerShell）**：需要先装 [Node.js 22 LTS（≥ 22.5）](https://nodejs.org/) 和 [Git](https://git-scm.com/)，然后逐行执行：

```powershell
cd $HOME
git clone https://github.com/greenge83-sudo/chimein
cd chimein
npm install
Copy-Item .env.example .env
npm run dev
```

打开 http://localhost:5173 ，注册主持人账号 → 新建会议 → 进入控制台 → 开始会议。

- 默认 `.env` 全部使用 **mock**（不调用任何外部服务，卡片带“[演示]”标记），用于体验流程和联调。
- 没有麦克风时，用控制台左下角“模拟发言”输入台词；或用 `scripts/replay.ts` 回放整段转写。
- 生产构建：`npm run build && npm start`（同一个 Node 服务托管 API、WebSocket 与前端，端口 `PORT`）。

### 接入真实服务（改 `.env` 后重启）

| 环节 | 海外区 | 中国大陆区 |
|---|---|---|
| 判定 / 指令解析 | `LLM_JUDGE_PROVIDER=anthropic`，`LLM_JUDGE_MODEL=claude-haiku-5-5` | `openai_compat` + `deepseek-v4.1-flash` 等 |
| 生成脑暴卡 | `anthropic` + `claude-sonnet-5-5` | `openai_compat` + `glm-5.3` 等 |
| 会后纪要 | `anthropic` + `claude-opus-5-5` | `openai_compat` + Kimi / Qwen |
| 联网搜索 | `SEARCH_PROVIDER=tavily` | `SEARCH_PROVIDER=bocha` |
| 语音识别 | `ASR_PROVIDER=soniox` 或 `assemblyai` | 待接：阿里云 / 讯飞 / 火山（见“下一步”） |
| 复述向量 | `EMBED_PROVIDER=openai_compat`（任意多语言 embedding） | 同左 |

- Anthropic：填 `ANTHROPIC_API_KEY`；使用结构化输出（zod schema 校验），Sonnet / Opus 开启服务端拒答兜底（`fallbacks: "default"`）。
- 国产模型：`OPENAI_COMPAT_BASE_URL` + `OPENAI_COMPAT_API_KEY`（DeepSeek / 智谱 / 通义 / Kimi / MiniMax 都兼容这个接口）。
- 备用模型：`LLM_FALLBACK_PROVIDER` / `LLM_FALLBACK_MODEL`，主模型失败时自动切换；仍失败则大屏显示“AI 暂时离席”，不影响转写保存。
- `ASR_PROVIDER=browser`：主持人浏览器自带识别（Chrome），免 Key 试用，无说话人分离，不能作为正式方案。

### 可调参数与 Prompt（不改代码）

- `data/tuning.json`：覆盖 `server/src/config.ts` 里的 `defaultTuning`（判定间隔 30 秒、价值阈值 0.7、置信度 0.6、复述阈值 0.8、小结间隔、唤醒词、字数限制、频率档位等）。
- `data/prompts/{judge,generate,command,minutes}.md`：存在时覆盖内置 Prompt（`server/src/prompts/`）。

## M0：用真实会议转写对比模型

```bash
npx tsx scripts/replay.ts scripts/samples/brainstorm-zh.txt --every 4 --preset brainstorm
```

转写文件每行 `说话人: 内容`。脚本会建会、逐行送入、每 N 行触发一次判定，最后打印卡片、出卡延迟、预约完成率、纪要和本场用量/成本。换模型只需改 `.env` 并重启服务后再跑一次。

## 测试

```bash
npm test
```

```bash
npm run typecheck
```

- `server/test/e2e.test.ts`：启动真实服务走完 M1 主流程——注册、建会、口令加入、告知确认、预加载卡命中上屏、判定出卡（带来源、字数）、**复述不重复出卡**、唤醒词 + 话题触发预约、文字提问、稍后卡（参会者不可见 → 主持人展示）、反馈、隐藏、结束生成纪要、**分享/导出只含已上屏卡**、会后口令失效、用量计量。
- `server/test/unit.test.ts`：复述识别、卡片校验（无来源/编造链接/低置信度/超字数/迭代卡无增量）。

## 需求覆盖情况

| 编号 | 功能 | 状态 |
|---|---|---|
| F-01 | 主持人账号 | ✅ 邮箱 + 密码；注册时写入部署区域。Google / Apple / 手机验证码 / 微信登录未接 |
| F-02 | 创建会议 | ✅ 主题、类型预设、议程、参会方、背景资料（文字 / PDF / Word）、主语言、卡片语言、重要会议；链接 + 二维码 + 6 位口令 |
| F-03 | 参会者加入 | ✅ 口令 + 昵称免登录；会议结束后失效；人数上限按套餐配置 |
| F-04 | 实时收音与转写 | ✅ AudioWorklet 16k PCM、100ms 一包、回声消除/降噪、屏幕常亮、麦克风选择与音量条；Soniox / AssemblyAI 适配（含断线缓存补传）；转写只推主持人 |
| F-05 | 自动出卡 | ✅ 4.3 全部规则：30 秒评估、阈值（随频率档位与反馈调整）、预设间隔、去重/迭代卡、置信度门槛、反馈降权 |
| F-06 | 实时同步 | ✅ Socket.IO 按会议分房间；断线重连后自动补齐 |
| F-07 | 联网检索与来源 | ✅ 最多 3 个并行查询、5 秒超时、按会议缓存；**来源只允许来自本次搜索结果**，事实类无来源不出 |
| F-08 | 主持人控制 | ✅ 开始/暂停/结束、AI 开关、频率三档、隐藏/置顶/聚焦 |
| F-09 | 卡片反馈 | ✅ 有用/无关/收藏，计入后续判定 |
| F-10 | 会后纪要 | ✅ 概要、议题结论、决定、待办、分人要点；超长按 15 分钟分段再合并；可编辑、可重新生成 |
| F-11 | 历史与保留期 | ✅ 历史列表与搜索；录音 14 天后自动删除；一键删除整场 |
| F-13 | 文字提问 | ✅ 以卡片上屏并标注提问人 |
| F-14 | 语音指令与预约卡 | ✅ 唤醒词（可按会议自定义）、判定识别“对 AI 说话”、立即/稍后/话题触发/定时/会议结束前；2 秒内“已收到”提示；预约列表可取消/展示/修改 |
| F-24 | 复述识别与增量输出 | ✅ 语义相似度 + 字面重合度双判据；复述片段不进判定、纪要中保留；迭代卡只写增量 |
| F-25 | 多语言 | ✅ 界面中/英；卡片中文/英文/双语 |
| F-27 | 用量计量 | ✅ 会议时长、转写分钟、出卡、搜索、token 与成本估算；按场与按月查看 |
| F-12 | 审核队列（P1） | ✅ 重要会议下事实核对、在场参会方的主体速览先进队列 |
| F-15 | 深挖（P1） | ✅ |
| F-16 | 会前预加载（P1） | ✅ 备用状态，会中提到即上屏 |
| F-17 | 大屏字幕（P1） | ✅ 默认关闭 |
| F-18 | 导出与分享（P1） | ⚠️ Markdown 导出 + 浏览器打印存 PDF + 只读分享链接已完成；Word 导出未做 |
| F-19 | 说话人命名（P1） | ✅ 纪要同步替换 |
| F-26 | 企业登记信息（P1） | ⚠️ 按 6.4 的 MVP 方案：中国企业附“在公示系统查看”链接；授权数据服务商 / OpenCorporates 未接 |
| F-20~23, F-28 | P2 | 未开始（按里程碑放在 M3） |

**核心指标**（有用率、无关率、复述片段数、预约完成率、出卡延迟 P90）在控制台“本场指标”与会后页可看。

## 目录

```
server/src
  config.ts              区域、供应商路由、出卡策略参数、会议类型预设
  db.ts                  12 张表（开发期 SQLite，集中在此文件，便于换 PostgreSQL + pgvector）
  pipeline/runtime.ts    会议运行时：收音、复述过滤、唤醒词、定时判定、预约调度、小结、结束
  pipeline/cardgen.ts    检索 → 生成 → 校验 → 去重 → 审核分流 → 推送
  pipeline/echo.ts       已展示内容库与复述识别
  pipeline/minutes.ts    纪要与 Markdown 导出
  adapters/{llm,asr,search,embed}  可替换的供应商适配层
  prompts/*.md           判定 / 生成 / 指令解析 / 纪要 Prompt
  routes/api.ts          REST 接口（7.2）
  socket.ts              WebSocket 事件（7.3）
web/src/pages            登录、会议列表、创建会议、主持人控制台、大屏、参会者、会后页、分享页
scripts/replay.ts        M0 转写回放
```

## 已知限制 / 下一步

1. **真实供应商未在本环境联调**：Anthropic、OpenAI 兼容、Tavily、博查、Soniox、AssemblyAI 适配器已写好并通过类型检查，但没有 Key，只用 mock 跑通。M0 第一步是填 Key 跑 `scripts/replay.ts` 与真实录音，重点核对 Soniox 模型名（`SONIOX_MODEL`）与 AssemblyAI 多语言模型名（`ASSEMBLYAI_SPEECH_MODEL`）。
2. 大陆区 ASR（阿里云 / 讯飞 / 火山）适配器待补，接口参照 `adapters/asr/index.ts` 的 `soniox()`。
3. 数据库：开发期用 Node 内置 SQLite；上线前替换为 PostgreSQL + pgvector，多实例时 Socket.IO 加 Redis adapter，AI 流水线放 BullMQ。
4. 账号：补 Google / Apple / 手机验证码 / 微信登录。
5. Word 导出、企业登记数据服务商接入（M2）。
6. 存储加密、GDPR / 个保法的数据导出接口、大陆区备案（上线前）。
