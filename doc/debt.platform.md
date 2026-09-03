# 平台基础设施杂项 · 债务台账

> **版本**：v1.0 | **日期**：2026-07-31 | **状态**：开发中

**一句话**：平台层九个模块的欠账合成一册：资产存储、更新中心、历史表情符号清理、首页、登录会话、连接器、跨节点互传、预览入口下发、分享链接安全。
**谁该读**：接手其中任一平台模块的工程师；排障时想确认是不是已知边界的人。
**读完能做什么**：按模块小节定位欠账与偿还触发条件。

---

> 本台账由 9 份同模块台账合并而成，内容原样保留、只做归位；原文件已回收，引用已改指本文。

## 平台资产存储

平台资产存储（图片、附件、生成产物落到哪、怎么取）的已知债务与跨模块欠账。

| 字段 | 内容 |
|---|---|
| 模块 | 资源存储（IAssetStorage 实现） |
| 状态 | 活跃 |
| 关联 | `prd-api/src/PrdAgent.Infrastructure/Services/AssetStorage/` |

### 已知工程债务

| ID | 说明 | 优先级 | 触发条件 | 状态 |
|---|---|---|---|---|
| S-1 | `LocalAssetStorage` / `TencentCosStorage` / `CloudflareR2Storage` 三套实现里 `ResolveExtension` / `SanitizeExt` / `MimeToExt` / `ExtToMime` 完全复制粘贴。下一次扩 mime 映射或修通用 bug 都得三处同步——本次 PR 第一轮就是因为只改了 Local 没改 COS/R2 才反复出问题。建议抽到 `AssetStorageExtensions.cs` 静态工具类，三处 internal `using static` 引用。 | **P2** | 下次新增 mime 映射 / 又被同样 bug 咬一次 | new (PR #542 引入) |
| S-2 | 历史已经存为错误后缀的对象（COS/R2 上无数 `.png` 实际是 m4a/mp3/zip）需要数据迁移：扫 `attachments` / `documententries` / `image_assets` 等集合，按 `ContentType` 推断真实后缀，把 `Url` 字段重写并迁对象 key。否则旧数据永远播放不了波形（CDN 仍按 png 处理）。 | **P2** | 用户对老旧文档发起字幕/再加工/外部 share 时 | new |
| S-3 | 知识库历史数据全 fallback 到 `.png`，CDN 配置 `Access-Control-Allow-Origin` 后 wavesurfer 仍然不能 decode 这些"假装是 png 实际是 m4a" 的文件（mime 不对）。需要 S-2 完成后才能修复。 | P2 | S-2 完成 | blocked-on-S-2 |

---

### 跨模块债务（在 PR #542 review 中被发现，但不属于本 PR scope）

| ID | 说明 | 文件 | 优先级 | 触发条件 |
|---|---|---|---|---|
| X-3 | 语音识别诊断块的类型与渲染 helper 在字幕生成抽屉与交换测试面板两处复制，后端加诊断字段要双改。修法：抽成一个共享组件。 | `prd-admin/src/pages/document-store/SubtitleGenerationDrawer.tsx` + `prd-admin/src/components/exchange/ExchangeTestPanel.tsx` | P3 | 后端字段变更 |
| X-4 | 知识库 Agent 的错误消息与诊断 JSON 拼在一起后按 1500 字符硬截断，可能从 JSON 中段切开，前端解析失败、诊断面板直接消失。修法：截断前先解析，优先丢掉体积最大的字段，不在 JSON 中段切。 | `prd-api/src/PrdAgent.Api/Services/DocumentStoreAgentWorker.cs` | P3 | 错误消息很长（>1500 字符）的极端场景 |

---

### 历史背景

- 2026-05-08 PR #542 第一轮修复"知识库 m4a 被存成 .png" — 我先只补 `LocalAssetStorage.MimeToExt` 白名单，没看到 COS/R2 也是同样代码 → 用户反馈"反反复复"。第二轮根治用 `ResolveExtension` 优先 fileName + 默认 `.bin` 兜底。
- Cursor Bugbot 在第二轮 commit `9253b0f` 上的 review 提醒了 S-1/S-2/X-1/X-2/X-3 全部 5 条，本文档登记其中本 PR scope 外的 4 条（X-1/X-2/X-3 + S-1/S-2 因牵涉迁移脚本也单独立项）。

### 还债记录

| 日期 | ID | 处理结果 | 验收 |
|---|---|---|---|
| 2026-05-12 | X-1 | 确认 `SubtitleGenerationProcessor` 已走豆包异步 JSON `audio_data(base64)` 路径，不再把音频作为 multipart 文件传给 Exchange；补充回归测试防止退回空 body/multipart 路径。 | `dotnet test --no-restore --filter SubtitleGenerationProcessorTests` |
| 2026-05-12 | X-2 | Exchange ASR SSE 控制器异常不再把 raw exception、异常类型和 stack 下发给客户端；服务端日志保留完整异常，前端用 `requestId` 对齐排查。 | `dotnet test --no-restore --filter ExchangeControllerTests` |
| 2026-05-12 | X-5 | Exchange Test Panel 收到 SSE `error` 事件时不再清空此前 `result` 事件带来的转写文本、段数、耗时和诊断信息。 | `pnpm test -- ExchangeTestPanel.test.ts` |

## 更新中心（终身存储 + 推送）

更新中心（终身存储加推送）的已知边界与偿还触发条件。

### 总览

| 指标 | 当前值 |
|------|--------|
| open | 5 |
| in-progress | 0 |
| paid | 0 |

模块范围：`prd-api/.../Services/Changelog/*`（ChangelogReader / ChangelogSnapshotStore /
ChangelogPushHub / ChangelogRefreshWorker）、`ChangelogController` 的 `/api/changelog/stream`、

### 背景

2026-06-04 用户要求更新中心「永远缓存、后台固定周期（4h）自动刷新、终身存数据库避免加载空白、
加载只读存量、有更新由服务器 push 到页面」。本次落地：
- `changelog_snapshots` 集合做终身存储，加载只读存量（内存缓存 → DB hydrate → 真冷启动才拉）
- `ChangelogRefreshWorker` 固定周期 force 刷新，与访问解耦（解决「第一个看的人吃亏」）
- `IChangelogPushHub` + `/api/changelog/stream` SSE，内容变化主动推送，前端静默重读存量

### 已知边界（open）

| # | 边界 | 说明 | 偿还建议 |
|---|------|------|----------|
| 1 | 推送中枢是进程内单例 | `ChangelogPushHub` 用进程内 Channel 广播。多实例水平扩展时，A 实例的 Worker 刷新只能推给连到 A 的浏览器，连到 B 的收不到。当前单实例部署无影响。**另**：多实例并发 upsert `changelog_snapshots` 需 `Key` 唯一索引兜底（已在 [doc/guide.platform.mongodb-indexes.md](./guide.platform.mongodb-indexes.md) + `MongoDbContext.CreateIndexes()` 登记 `uniq_changelog_snapshots_key`，DBA 手建；`GetAsync` 已加 `SortByDescending(UpdatedAt)` 防御性读，重复行也只取最新）。 | 多实例化时：(a) 改用 Redis pub/sub 或 Mongo change stream 做跨实例广播，订阅端不变；(b) 上线前由 DBA 建好 `uniq_changelog_snapshots_key` 唯一索引。 |
| 2 | 刷新周期为全局，不分视图冷热 | 三个视图（待发布/历史发布/GitHub 日志）共用同一刷新周期。GitHub 日志变化最频繁、历史发布最稳定，统一 4h 对日志略保守。 | 如需更实时，可拆分各视图独立周期，或接 GitHub push webhook 触发即时刷新（仓库已有 webhook 基建）。 |
| 3 | GitHub 日志前端仍保留 35s 轮询 | `ChangelogPage` 既有的 `GITHUB_LOGS_LIVE_POLL_MS` 客户端轮询未移除，与新的 SSE 推送并存（轮询 force=true 仍会触发真实拉取）。本次为控制改动面未动它。已加 trailing-edge：在途轮询期间到达的 SSE update 不再被吞，待在途请求结束补跑一次。 | 评估改为依赖 SSE 推送后下调/移除该轮询，进一步贴合「加载只读存量、刷新交给服务器」。 |
| 4 | 分支预览环境拿不到「仓库总提交数」 | 2026-06-10 新增 `repoTotalCommitCount`（本地 `git rev-list --count`，浅克隆/无 `.git` 时用 GitHub `commits?per_page=1` 的 Link header rel="last" 反推）。CDS 分支容器既无完整本地仓库、又未配 `Changelog:GitHubToken`，匿名调 GitHub 被 403 限流 → 字段为 null，前端降级显示「最近一周」条数。生产环境有 token，不受影响（实测 main 全历史 7282 次提交）。 | 在 CDS 分支 env 注入只读 `Changelog:GitHubToken`，或接受预览环境降级展示。 |
| 5 | 热修复子 tab 非 SSE 实时推送 | 2026-07-09 新增「热修复」子 tab（`GET /api/changelog/github-hotfixes`，数据源 `DefectResolutionTrace` 全历史）。仅在进入该 tab、手动刷新、首屏拉计数三处触发，未接入 `/api/changelog/stream` SSE viewType。新缺陷修复落库后不会自动 push 到已打开的页面。 | 缺陷修复量大且用户需要实时时，给 SSE 增加 `hotfixes` viewType 并在 `DefectResolutionTrace` 落库处触发 push。 |
| 6 | 热修复无 AI 总结 | 后端 `ChangelogAiSummarySubtab` 枚举未含 `hotfix`，前端已隐藏该 tab 的「AI 总结」按钮。 | 如需，在后端 AiSummary 端点补 `hotfix` 分支（喂缺陷编号/标题/发布状态）并放开前端按钮。 |
| 7 | 热修复发布状态判定依赖全量 GitHub 日志 | `github-hotfixes` 复用 `ResolvePublishStatus`，需拉 `GetGitHubLogsAsync(1000)` 求 deployedIndex/shaIndex（reader 5 分钟缓存兜底）。分支预览环境无 token/无完整仓库时（同边界 4）拿不到部署基准 → 未持久化 `PublishStatus` 的追踪显示「unknown」。已发布状态一旦被 `github-logs` tab 写回则稳定。 | 同边界 4：注入 token；或把发布状态判定下沉为独立可缓存服务，避免每次拉全量日志。 |
| 8 | `CHANGELOG.md` 历史行残留已改名文档的旧名 | 2026-07-28 把 15 篇网关文档统一到 `platform.llm-gateway.*` 时，仓库内引用全量改写，唯独 `CHANGELOG.md` 按 CLAUDE.md §4「禁止直接编辑」保持原样，留下 16 处指向旧文件名的 inline code（举例：`plan.` + `llm-gateway.full-cutover.md`，此处刻意拆开写，避免被下一次改名扫描误当成待改写的引用）。这些是熵清理条目里用来标记「该 changelog 已被哪篇文档覆盖」的溯源信息，读者按名去 doc/ 找会扑空。另有一处 `rule.llm-gateway.md` 是更早就悬挂的（该文件从未以此名存在）。 | 下次跑 `scripts/assemble-changelog.sh` 发版、`CHANGELOG.md` 本来就要被工具改写时，在同一次操作里把旧名一并映射掉；或给熵清理工具加一张改名映射表，让溯源按映射解析而不是按字面名。 |

### 偿还触发条件

- 边界 1：一旦更新中心需要多实例部署，必须先偿还（否则推送只覆盖部分用户）。
- 边界 2/3：用户反馈「更新不够实时」或要做 push-webhook 即时刷新时偿还。
- 边界 5/6/7：热修复使用量上来、用户要求实时/总结/更准的发布状态时偿还。
- 边界 8：下次发版跑 assemble-changelog（`CHANGELOG.md` 无论如何都会被工具改写）时顺带偿还，不为它单独动这个文件。

## 历史 emoji 语料清理

规则禁用表情符号，但存量语料里仍有大量历史遗留，本文记为什么先记债与清理方案。

### 一、问题

CLAUDE.md / AGENTS.md §0 禁止任何 emoji。但仓库**存量语料**里仍有大量历史遗留 emoji，主要分布：

- `.claude/skills/**/SKILL.md` 及其 `reference/*.md`：用 emoji 作状态/分级标记（对勾、叉号、警告三角、灯泡、红/绿圆点、实心星、空心方框 等）。
- `doc/**/*.md`：约 2600+ 处既有 emoji（含语义状态标记），散在 130+ 文件。

下游放大点：`scripts/bundle-official-skills.mjs` 把官方白名单技能的 SKILL.md 正文打包进
`prd-api/src/PrdAgent.Api/OfficialSkills/official-skills.generated.json`，该 JSON 由 API 下发给
海鲜市场/下载用户 —— 于是源文件里的 emoji 会**原样出现在对外产物**里。Codex/Bugbot 因此反复
（多个 PR）标这条 P2。

### 二、为什么记债而不是现在改

- 体量大：跨 130+ doc 文件 + 数十个 skill 文件，**多数 emoji 是语义状态标记**（对勾=通过 / 叉号=未做 /
  警告三角=警告），删改需逐一替换为等义文案（「通过 / 未做 / 警告」），不是机械删字符。
- 风险/收益：在一个功能 PR（如知识星球）里铺开全量替换，diff 巨大且易误伤，违反 scope 收敛与
  blocked-state-circuit-breaker（不在功能分支里夹带大范围无关 churn）。

### 三、清理方案（待专项排期）

1. 先治**对外产物**：de-emoji 官方白名单技能（INCLUDE 列表）的 SKILL.md + reference，重跑
   `bundle-official-skills.mjs`，确认 `official-skills.generated.json` 零 emoji。这步范围小、收益高
   （直接消除对外暴露 + 止住 Codex 复发）。

   **进度（2026-07-28，部分偿还）**：角色套装 PR 把 `acceptance-checklist` 的两个 reference 文件
   de-emoji（空心方框 U+2610 改为 `[ ]`，对勾/叉号/红绿圆点/票据/灯泡改为文案分级），并在
   `scripts/test-official-skill-bundles.mjs` 加了守卫——**但守卫只扫角色套装的成员技能**，
   不在套装里的上架技能尚未覆盖。新增套装会自然扩大守卫范围；要一次清完仍需专项排期。
   跟踪见 [doc/debt.skill.role-bundle.md](./debt.skill.role-bundle.md) 的 D4。
2. 再治 `doc/` 存量：分批按目录替换 emoji 状态标记为文案，配一个 CI 守卫（新增 emoji 即 fail）防回潮。
3. 守卫落地后，本债务关闭。

### 四、关联

- `CLAUDE.md` / `AGENTS.md` §0 —— 禁 emoji 总则
- `scripts/bundle-official-skills.mjs` —— 把 SKILL.md 打包进对外 JSON 的放大点
- PR #923 review：Codex 多次标 `official-skills.generated.json` 残留 emoji（task-handoff 示例等）

## 登录后首页（Agent 启动页）

登录后首页重组交付时声明的已知边界，以及明确否决不做的事。

> **关联改动**：后端「最近打开」端点 + 前端 Agent 启动页与其 store（文件见文末「实现来源」）

记录登录后首页重组（继续上次 + 视觉纪律收敛）主动声明的已知边界，避免下一次 session 没人记得。

### 一、已落地

- **「继续上次」区块**：`GET /api/home/recent-work` 聚合视觉/文学工作区（`image_master_workspaces`，按 `scenarioType == article-illustration` 区分归属）与工作流（`workflows`），按 `LastOpenedAt/UpdatedAt` 较大者排序；前端无数据时整体不渲染。
- **色阶尺（tonal ladder）**：46 对渐变强调色收敛为 `hueAccent(H)`（同一饱和度/明度档位只换色相），颜色只出现在图标芯片；卡片底/描边/hover 一律中性。
- **卡片统一配方**：Featured / Quick / Compact / RecentWork 四种卡同底同描边同 hover ring。
- **动画收敛**：问候语彩虹渐变动画删除；进场动画由 30+ 元素逐卡级联降为区块级一次 fade（400ms）。

### 二、已知边界（后续可补）

| # | 边界 | 说明 | 补法 |
|---|------|------|------|
| 1 | 「继续上次」埋点覆盖 7 类（2026-07-05 三期补齐） | 已覆盖：视觉工作区、文学工作区、工作流、缺陷、周报、产品评审、知识库（`/document-store?store=` 深链已加，GetStore 鉴权后打点）。仍未覆盖及原因：涌现树 / 视频创作 / PR 审查（无 `:id` 详情路由，工作现场是页内状态）、网页托管（管理动作非工作现场）、对话式 Agent（会话另有历史入口）。前端默认收起一行 + 「浏览全部脚印」展开（后端上限 30，前端拉 24） | 补新来源三步：详情端点加 `RecentOpenTracker.TouchAsync` + 聚合端点补标题富化与路由 + 前端 `RECENT_AGENT_META` 补图标标签；无深链的先给页面加 `?id=` 路由支持 |
| 3 | 台账冷启动为空 | 上线后所有用户的继续上次会清空，重新打开过工作区/工作流才逐渐积累（每次打开打一条） | 属预期行为（诚实优于杜撰）；如需回填可按各实体 owner 的 LastOpenedAt 一次性初始化，需评估共享工作区归属口径 |
| 4 | 移动端首页未同步方向 C | `MobileHomePage` 是独立实现（2026-07-01 已另行改版为移动工作台），本次只改桌面 AgentLauncherPage | 如需移动端也加「继续上次」，复用 homeRecentWorkStore 即可 |
| 5 | 登录后 UI 视觉验收待真人 | 本次自测覆盖 vitest/tsc/lint/pnpm build/CDS 编译 + AI key 冒烟端点；登录态页面截图验收需真实账号走 /验收 流程 | 用户在预览域名登录验收，或提供测试账号后补跑视觉验收归档 |

### 三、不做的事（明确否决）

- 不再为每个图标维护独立渐变对（回到 46 色状态即视为回归）。
- 「继续上次」不做骨架屏：拉取失败或为空时静默隐藏，不打扰用户。

## 登录会话（超长登录期）· 债务台账

超长登录期与用后自动续期落地后的已知边界与后续可补项。

记录 2026-07-28「三端登录改超长会话 + 用后自动续期」留下的已知边界与后续可补项。
用户诉求原话：「登录一下就过期了，需要超长的登录期，并且使用过后自动延长」。

### 本次落地的会话模型

| 端 | 凭据存放 | 硬过期 | 续期方式 | 撤销手段 |
|---|---|---|---|---|
| MAP（prd-admin） | localStorage（zustand persist） | access token 7 天；会话滑动窗口 7 天 | 每次已鉴权请求 `AuthSlidingExpirationMiddleware` Touch 续满窗口（含 tokenVersion 键）；access token 过期后 401 → refresh → 重试 | 每请求校验 tokenVersion（`/api/auth-ops/force-expire*` 立即生效） |
| 网关控制台（llmgw/web） | localStorage | token 7 天 | 用满 12h 的 token 在租户校验通过后由服务端换发，走 `X-Gw-Token` 响应头，前端在响应里接住 | 每请求 `TenantAccess.ResolveAsync` 重校验 SecurityVersion / 成员版本 / 租户状态 |
| CDS | `cds_gh_session` cookie | 7 天（`CDS_SESSION_TTL_DAYS`，1~90 天） | 剩余不足一半时下一次请求续满并重发 cookie | 会话表删除（logout / 禁用用户） |

### 已知边界 / 待补项

#### 1. MAP 没有服务端 logout，退出登录只清本地

`AuthController` 没有 logout 端点，前端 `authStore.logout()` 只清本地存储。access token 从 60 分钟拉长到
7 天后，**已泄露 token 的可利用窗口从 1 小时变成最多 7 天**（refresh token 因为本地被清、
且泄露方通常拿不到 sessionKey，不受影响）。用户 2026-07-28 明确要求「7 天有效」，此为其知情取舍。

- 缓解：管理端 `/api/auth-ops/force-expire` 可立即吊销（bump tokenVersion），每请求校验。
- 待补：加 `POST /api/auth/logout`，按 `(userId, clientType, sessionKey)` 删除该端 refresh 会话并
  bump tokenVersion，让「点退出」等价于「立即失效」。

#### 2. 网关续期依赖每条已鉴权请求都接住响应头

滑动续期靠 `X-Gw-Token` 响应头下发：走统一请求封装的调用自动接住；绕开封装的裸 fetch 必须自己
把新 token 写回。漏一处的后果不是「不续期」那么轻——「只用那一个功能」的用户会在最初的 7 天期限上
掉登录（真实案例：缺陷上报弹窗的提交请求，已修）。守卫是一条源码扫描测试：带会话 token 的裸 fetch
必须出现回写调用（用服务密钥打 serving 网关的调用不在此列，那条链路本就没有会话）。
EventSource 无法读响应头，若将来引入需另设续期通道。

#### 3. 网关旧 token 不会被续期

`TryRenew` 只续「按当前完整会话时长签发」的 token。发版前签发的 12 小时 token（以及被显式缩短的
MAP SSO 会话）原样到期，用户需重登一次才进入 7 天滑动窗口。属一次性过渡成本，不修。

#### 4. MAP SSO 联邦会话时长语义变更

`/gw/auth/map-sso` 原先固定 15 分钟，现在默认与普通会话一致（7 天）。若安全策略要求联邦会话必须短，
配置 `LlmGwJwt:MapSsoLifetimeMinutes` 收紧即可——但那类 token 不进滑动续期，会回到「一会儿就过期」。

#### 5. CDS 续期是「读-改-写」而非原子递增

`extendSession` 先 `findOne` 再按原 `expiresAt` 条件 `replaceOne`。并发续期时后到的那次是 no-op
（条件不匹配），结果仍然是一个被续满的会话，不会写坏数据；但如果并发的是 logout，续期会安静失败，
下一次请求按未登录处理。当前阈值下每个会话半个 TTL 才触发一次续期，冲突概率极低，暂不改成原子更新。

#### 6. 三端都是 7 天，但没有统一 SSOT

用户 2026-07-28 定调「本项目所有的系统都是 7 天」，MAP / 网关 / CDS 现已全部落到 7 天。
但三处各有各的配置项（`Jwt:AccessTokenMinutes` + `Auth:SessionSlidingDays` / `LlmGwJwt:LifetimeDays` /
`CDS_SESSION_TTL_DAYS`），改一个数字要动三处，存在漂移风险。若要「一处配置管三端」，
需要引入平台级会话策略配置。

### 历史背景

| 时间 | 事件 |
|---|---|
| 2026-07-28 | 用户反馈登录一下就过期，要求超长登录期 + 用后自动延长；三端会话模型按上表统一改造，`no-localstorage` 规则同步补「认证态可进 localStorage」的显式例外 |

## MAP MCP 连接器

连接器核心链路已部署，本文记评审延期的三条开放债务与已还的一条。

### 总览

当前 open: 3 / paid: 1 / 总计: 4

核心连接器（远程 `/api/mcp` + 海鲜市场 5 内置工具 + 知识库读 API + 动态工具框架）已部署并自测通过（路由 + 鉴权链路）。以下为 PR #836 评审尾部识别、判定为低 MVP 影响而显式延后的硬化项。

### 债务列表

| ID | 严重度 | 创建日期 | 描述 | 触发条件 | 状态 | 备注 |
|----|--------|---------|------|---------|------|------|
| 2026-06-18-ai-provision-endpoint | medium | 2026-06-18 | AI 无人值守自助签发 sk-ak 需一个【只接受 AiAccessKey 方案】的专用端点(单身份无歧义)。曾在 AgentApiKeysController 叠 Bearer+AiAccessKey 自测,但同请求双凭据时 FindFirst(sub) 选错用户(Bugbot Medium),已撤回(AiAccessKey 鉴权器本身是既有设计,未动) | 需 AI/自动化无人值守为指定用户签发 sk-ak 时 | open | 新建 POST /api/agent-api-keys/ai-provision，[Authorize(AuthenticationSchemes="AiAccessKey")] |
| 2026-06-18-kb-entries-pagination | low | 2026-06-18 | knowledge_base_list_entries 只有 keyword+limit(上限500),无 cursor/page；超 500 条非文件夹条目的大库无法经 MCP 全量遍历 | 出现 >500 条目的知识库且需 MCP 全量读取时 | open | 加 cursor/page 参数 + tool schema 同步;多数库 <500 条,MVP 影响低 |
| 2026-06-16-stdio-and-oauth | low | 2026-06-16 | v1 只做远程 Streamable HTTP + Bearer 鉴权；本地 stdio 代理包、OAuth 2.0 授权流、`resources`/`prompts` 能力均未做 | 需兼容仅支持本地 stdio 的旧客户端，或需要标准 OAuth 授权而非长效 Bearer 时 | open | 见 [design.platform.map-mcp-connector.md](./design.platform.map-mcp-connector.md) 第三节「非目标」与第九节 v2 |

### 已还的债务（归档）

> 修复后从上面表格挪到这里，保留以便复盘

| ID | 修复 PR | 修复日期 | 备注 |
|----|---------|---------|------|
| 2026-06-16-loopback-forwarded-headers | #836 | 2026-06-16 | 回环转发 X-Client-Base-Url / X-Forwarded-Host / X-Forwarded-Proto;Codex 确认影响海鲜市场 official skills 下载链接 |

### 关联

- [doc/design.platform.map-mcp-connector.md](./design.platform.map-mcp-connector.md) —— 设计与实施阶段
- PR #836 —— 落地 PR；评审中的 P1（知识库身份）、安全（Host 伪造 / 重定向跟随）、协议正确性、可见性等实质项均已在该 PR 内修复，仅本表两项显式延后

## 工程债务台账：系统级跨节点互传（Peer Sync）

跨节点互传首版有意不做的边界、后台自动同步与二进制附件的进展，以及防自指兜底。

> 模块：prd-api PeerSync + prd-admin 系统互联 | 关联：[design.platform.peer-sync.md](./design.platform.peer-sync.md)

记录 v1 已知边界、后续可补项、未覆盖风险。下一次 session 接手先读这里。

### 已知边界（v1 故意不做）

| # | 边界 | 现状 | 后续方向 |
|---|------|------|---------|
| 1 | 二进制附件跨节点 | 已实现（2026-06-23）：导出时文件条目（无正文、走 AttachmentId）带 `Extras["peerAttachment"]`（url/mime/fileName/size/type/thumbnailUrl/extractedText）；接收方下载文件 → 重传到本节点存储 → 重建 Attachment + DocumentEntry，`peerSourceAttachmentUrl` 元数据做幂等。签名也纳入附件标识（避免仅二进制变化的伪「已同步」）。残留小边界见下方 B 系列 | — |
| 2 | 影子用户 | 归属对齐失败（对端无同名 username / email）时归到「操作者」（push 路径=发起用户；node-to-node apply 路径=配对管理员），不创建影子账号 | 后续加「按邮箱建影子账户」开关 |
| 3 | 解除配对的对端清理 | DELETE 仅删本端 PeerNode，对端残留记录需对端管理员手动删 | 后续加 revoke 通知对端 |
| 4 | 双向合并语义 | both = push(targetKey) 然后 pull(targetKey)，共享条目以发起方为准、两侧新增都保留；非「逐条三方合并」 | 复用现有 DocumentStoreSyncController 的签名快照三态判定可做更精细的「仅改动侧驱动」 |
| 5 | 资源覆盖面 | v1 只实现 document-store 一个 ISyncableResource（双向）；其它应用单向能力尚未接入 | 缺陷/视觉/工作流等各加一个 ISyncableResource 实现 + DI 注册即可 |
| 6 | 同步引擎重复 | DocumentStoreSyncResource 的 export/apply 算法与 DocumentStoreSyncController 的私有方法是「同算法两份代码」（为零回归风险，未抽公共引擎） | 后续抽 IDocumentStoreSyncEngine，两边共用，消除分叉风险 |
| 7 | 本节点对外地址来源 | selfBaseUrl 默认从请求 scheme+host 推断，反向代理 / 内网部署可能不可达；可在添加对端时手填 selfBaseUrl 覆盖 | 后续在系统设置固化「本节点对外地址」 |
| 8 | 进度可视化 | transfer 为同步 HTTP 一次性返回逐条结果，未做 SSE 流式进度（多库大库时等待较久，仅 spinner） | 大批量时改 Run/Worker + SSE 推进度（呼应 CLAUDE.md §6） |

### 后台自动同步（2026-06-22 PR #890 新增）

把「双向同步」从手动一次性升级为定期自动保持一致（PeerSyncScheduleWorker + 每库开关）。已落地防风暴五层
（每库 Mongo 租约 / 全局并发上限 / 批量上限 / 到期闸+5min 下限 / 抖动+租约自愈），手动 transfer 与自动 worker
共用同一把库级互斥租约（`TryAcquireStoreSyncLeaseAsync`，30min TTL，owner 限定释放）。遗留项：

| # | 边界 | 现状 | 后续方向 |
|---|------|------|---------|
| A1 | 租约无心跳续租 | 固定 30min TTL，覆盖单库最坏同步耗时（两阶段 HTTP 各 120s + 资源重传）。若出现 >30min 的超大库，超时后锁可被另一发起方抢走 → 同库并发 | 同步期间周期性续租（heartbeat），持短 TTL 但活着就续 |
| A2 | force-align mirror 删除未级联 | 镜像删除对端缺失条目时只删 DocumentEntry（+可能的解析文档），未清其 sync 日志 / view events / 内联评论 / 版本 / mentions / agent runs / 附件 —— 与 `DocumentStoreController.DeleteEntry` 的级联不一致，留孤儿数据。仅手动 force-align 路径触发（自动同步只 Overwrite 不删，不受影响） | 抽 `DeleteEntry` 的级联清理为共享 helper（跨 Api/Infrastructure 层），mirror 删除复用 |
| A3 | apply 不清理「源已清空」的 primary/pins/defaultSortMode | 源库清空主文档 / 移除全部置顶 / 清空默认排序后，apply 的 overwrite/mirror 路径只在「解析到新值 / 字段非 null」时才写 → 目标残留旧 PrimaryEntryId / PinnedEntryIds / DefaultSortMode（含 mirror 刚删的条目 id）。注：per-record 的 sortOrder/category 已纳入变更检测+签名（已修）；本项专指**库级**这三个「null=已清空 还是 null=旧节点没传」无法区分的字段 | 需先在协议层用「null=旧节点字段缺失 / 空=显式清空」哨兵区分，否则旧节点同步会误清目标；区分后 overwrite/mirror 显式清空 |
| A4 | 库级互斥锁未覆盖 incoming apply | `TryAcquireStoreSyncLeaseAsync` 已让**出站**两条路径（手动 `POST /transfer` + 自动 worker）互斥，但**入站** `RemoteApply`（对端 push 进来）直接 `ApplyAsync`，未取同一把锁。故「本地正在出站同步某库」与「对端同时 push 该库进来」仍可交错写。自动同步恒 Overwrite（幂等 upsert，最终收敛、不丢数据）；唯一真风险是入站 mirror 删除与本地写交错，而 mirror 仅手动 force-align（用户二次确认）触发 | RemoteApply 对 document-store 也取同一把锁；需处理「目标库尚不存在（首次接收）」时不存在锁文档、不应误判冲突的边界 |

A2/A3/A4 都是 **手动 force-align/mirror 或入站 apply 路径**的既有/完整性问题，与本次新增的「自动出站同步」无关
（自动同步恒 Overwrite、绝不删条目，幂等收敛），故未在 PR #890 内仓促改动（需跨层 / 协议级 / 安全端点改造），单列于此。

### 二进制附件跨节点（2026-06-23 新增，原 debt #1）

文件类条目（PNG / yaml / pdf 等，无正文、走 AttachmentId）现已随包跨节点：导出带 `peerAttachment` 元信息 →
接收方经 SSRF 校验下载 → 重传到本节点存储 → 重建 Attachment + DocumentEntry，`peerSourceAttachmentUrl` 做幂等。
缩略图尽力本地化，签名纳入附件标识。残留小边界：

| # | 边界 | 现状 | 后续方向 |
|---|------|------|---------|
| B1 | 单文件大小上限 50MB | 超过即跳过该条（failed 计数），避免超大文件拖垮同步 | 需要更大文件时改分片 / 直传对象存储签名 URL |
| B2 | mirror 删除二进制条目不删 Attachment | 镜像删除时只删 DocumentEntry，孤儿 Attachment 残留（内容寻址、无害但占空间）。与 A2 同源 | 复用 A2 的级联清理 helper 时一并处理 |
| B3 | 缩略图本地化失败置空 | 缩略图下载失败时 ThumbnailUrl 留空（不留指向对端的悬挂 URL），主文件仍正常 | 可接受；前端对无缩略图已有兜底 |
| B5 | 附件替换/形态转换不删旧 Attachment 行 | 重下变更的二进制（插新 Attachment）、或纯二进制→文本（清 AttachmentId）时，不删旧 Attachment DB 行（及仅它引用的存储 blob），与 `DocumentStoreController` 的替换清理不一致，留孤儿（Bugbot Low）。内容寻址 blob 通常被多处共享，删除需引用计数 | 与 A2/B2 一并：抽共享级联清理 helper，带引用计数后再删 |
| B6 | 本地替换文件后 peer 源标记未刷新 | 经 peer-sync 导入的二进制条目，之后本地走 `ReplaceEntryFile` 换文件：只改 AttachmentId，没清 metadata 的 peerSourceAttachmentUrl/Size → 再导出仍发旧 sourceId；若新文件同大小，已应用旧标记的对端会判「未变」跳过下载，本地替换不传播（Codex P2，narrow：import→本地替换→再导出 链路） | `ReplaceEntryFile`（及其它改 AttachmentId 的本地路径）替换附件时清除 peerSourceAttachmentUrl/Size/peerSourceContentHash 标记；或导出时校验标记仍描述当前附件 |
| B4 | 可提取文本的文件（PDF/DOCX/TXT）只同步正文不同步原始下载件 | 这类上传同时存 DocumentId（正文）+ AttachmentId（原件）。当前导出仅在 `content==null` 时带 peerAttachment，故走纯文本路径：知识正文/可搜索内容已同步，但接收方条目无 AttachmentId → 原始可下载文件缺失。纯二进制条目（图片/yaml 等证据件，无 DocumentId）已完整同步——用户「证据图」诉求不受影响（PNG 即纯二进制） | 需把 apply 的文本路径与二进制路径合并为「一条记录可同时落 DocumentId + AttachmentId」：导出在有 AttachmentId 时恒带 peerAttachment 且保留 content；apply 文本 upsert 后再幂等下载挂载附件。属结构性改造，留待专门处理（避免在评审环路内无本地编译器盲改文本路径引回归） |

### 安全与一致性要点（已落地）

- 节点配对：一次性配对码（5 分钟 TTL）+ 握手交换 32 字节共享密钥；后续请求 HMAC-SHA256 签名（method+path+ts+sha256(body)），时间戳偏移超 5 分钟拒绝（防重放）。共享密钥永不出现在 URL / 前端 / 日志。
- SSRF：对端 baseUrl / 发起方回连地址均过 ISafeOutboundUrlValidator。
- 受信节点导出绕过按用户访问校验（SyncActor.PeerSystem），但仅在 HMAC 验签通过后；这是「系统级互信」的有意设计。
- 幂等：沿用 metadata.syncLineageId 血缘键，与旧 skblink token 路径数据互通；重复同步按血缘 upsert，内容未变跳过。
- 向下兼容：bundle / record 带 schemaVersion + Extras 字典，未知字段原样保留。

### 防自指（共享 DB / 配置错误兜底）

CDS 灰度环境下两个分支共用同一 MongoDB，导致 `appsettings.global.MapInstanceId` 在两个分支看是同一个值，
两个分支的 `selfNodeId` 因此相同。已加三层防护：

1. **握手层**：`AddPeerNode` / `Handshake` 收到 `InitiatorNodeId == selfNodeId` 直接拒绝（早期发现）。
2. **验签层**：`VerifyPeerAsync` 收到 `X-Peer-Node == selfNodeId` 即返回 401「不能与本节点自己同步（同 nodeId）」，
   即便配对记录被旁路写入也无效。
3. **用户 transfer 层**：发起 push/pull/双向时若所选节点的 `RemoteNodeId == selfNodeId` → 拒绝。

测试时可用 `PEER_NODE_ID_OVERRIDE` 环境变量强制覆盖 selfNodeId（不写回 DB），让共享 DB 部署的不同分支
互相看到对方为「不同节点」，从而走通真实握手 + HMAC + bundle 传输路径。运维场景下也可用此 env 重置节点身份。

### 验证状态（截至落地）

- 本地无 .NET SDK，后端编译走 CDS（见交付消息预览链接 / CDS check）。
- 前端 tsc / lint 见交付消息。
- 端到端「两个真实节点互传」需两套已部署环境，单分支预览无法自测双节点握手 —— 列为待真人/双环境验收项。

## 预览入口下发（Preview Entrypoints）· 债务台账

分支预览域名怎么产生、谁有权推算它，这条链路上的欠账与过渡期风险。

### 总览

当前 open: 3（PE-transition-window / PE-env-staleness / PE-long-branch-hash）/ 已落地待验证: 6（PE-ssot-inversion / PE-truncation / PE-console-subdomain-rename / PE-truncation-readability / PE-consumer-sweep / PE-llmgw-console-mapnav）/ 总计: 9

记录「分支预览域名怎么产生、谁有权推算它」这条链路上的欠账。

---

### 背景

CDS 自己算出分支 slug，再把 `<previewSlug>.<root>` 与命名子域 `<previewSlug>-<sub>.<root>`
写成显式路由记录。这一套在 CDS **内部**是 SSOT：解析走前向匹配（重算再比），不做反向解析，
v1/v2/v3 三代格式都能兼容。

问题出在 CDS **外部**：MAP 前端曾经自己按当前域名拼 `<预览 slug>-llmgw-web.miduo.org`，
这是第二份域名实现，违反根 `CLAUDE.md` 规则 #11（禁止自己 slugify / 拼域名）。

2026-07-29 现场事故：分支 `claude/llmgw-self-service-panel-redesign-f4oeh6` 的 previewSlug
长 57，加 `-llmgw-web`（10）= 67 > 63（RFC 1035 单标签上限）。CDS 按判据**跳过不发布**
这条路由，前端却照拼，用户点「模型网关」得到的提示是「登录凭据未通过安全校验」——
票据其实签发成功了，问题在部署拓扑，排查方向被完全带偏。

---

### 台账

#### PE-ssot-inversion · 把推算权从消费方收回平台 —— 已落地待验证

**做法**：CDS 在部署时注入 `CDS_PREVIEW_URL` 与 `CDS_SERVICE_URLS`（JSON: subdomain → URL），
prd-api 读取后由 `POST /api/llm-gateway/sso/ticket` 的 `console` 字段下发，前端只消费。

链路四段：CDS 侧算出入口（计算 SSOT）→ 注入容器 env 时按「平台事实」层强制覆盖，项目 env 不得伪造
→ MAP 后端读取并在 SSO 票据里下发 → MAP 前端只消费，不再自己拼。

四态明确（第 ③ 态是过渡期专用，见下）：

| 条件 | 结果 |
|---|---|
| 表里有 `llmgw-web` | 用它 |
| 有表但没这一项 | 「该入口确实没发布」（子域超 DNS 63 上限） |
| 是 CDS 预览但没有表 | 「平台版本早于该能力，地址未知，CDS 更新后自愈」 |
| 非预览且没有表 | 正式环境，同源 `/llmgw/` |

**已验证**：CI（commit `a11a0a6`）Server Build & Test 绿——C# 编译通过、`dotnet test`
含新增 `PlatformEntrypointsTests` 全绿；CDS Build & Test 绿（4297 测试 + tsc）；
Admin Dashboard Build 绿（882 测试 + tsc + lint）。CDS 已用该 sha 镜像重新部署。

**未验证**：浏览器里的实际提示文案。本机无 MAP 管理员凭据，跳转入口需真人管理员会话
（控制器显式拒绝 Agent Key），未能点击取证。

**上线前提**：入口注入是 CDS 侧改动，只有 CDS **自身**（跑 `main`）自更新到含本次改动的
版本之后，预览容器才会拿到 `CDS_SERVICE_URLS`。合入 main 前，所有预览环境命中第 ③ 态。

#### PE-transition-window · 过渡期预览环境失去网关入口 —— open（有界，自愈）

CDS 平台自更新到本次改动之前，预览容器拿不到入口表。此前那些**子域长度正常**、
跳转本来能用的分支，现在会看到第 ③ 态提示而不是直接跳过去。

为什么接受：替代方案是保留前端的域名推算做兜底，那等于把本次要消灭的第二份实现
再留一份，与整改目标直接冲突。选择是「明确告知未知」而不是「静默猜一个」。
影响面仅限分支预览（正式环境走同源路径，行为不变），且 CDS 更新后自动恢复。

#### PE-truncation · 超长分支拿不到网关入口 —— 已落地待验证

原先 `capPreviewSlug` 只作用在 previewSlug **本身**，复合标签 `${previewSlug}-${sub}`
超长时是**跳过不发布**，长分支点不开网关控制台。现已把截断提到复合标签这一层
（`namedServiceLabel`）：按 `-` 段截断 slug + 接 8 位 sha1 摘要压进 63 内。

**摘要不可省**：截断会丢唯一性，前几段相同的两个长分支会塌成同一个 host、互相抢路由
——这正是发布端注释里原本拒绝截断的理由。

同批修掉一处会立刻出事的接线：发布器写 host、`replica-loadtest` 与 `replica-sets`
两处 SSRF 白名单此前各自拼 `<slug>-<sub>`，截断一上线三者算出的就不是同一个 host
（直达链接会被自己的 SSRF 闸挡掉）。现统一走 `namedServiceLabel`。

短分支行为逐字不变（不超限原样返回），无回归面。

#### PE-env-staleness · 入口表在容器创建时定格 —— open（已知边界）

注入发生在容器创建时。若之后给项目新增了带 `cds.subdomain` 的 build profile，
**已在跑的容器不会看到新入口**，要等下次部署。

判断：可接受。新增服务本身就要重新部署才能起容器，同一次部署里两边一致。
若将来出现「不重启就要感知新入口」的需求，再考虑改成运行时查询平台接口。

#### PE-consumer-sweep · 全仓守卫 —— 已落地待验证

单文件断言只锁得住已知的那一个文件，锁不住下一个人新建的文件 —— 这正是同一个反模式
能长出三份拷贝的原因。已加一条全仓守卫测试：扫 MAP 前端与网关前端的全部源码，命中即红，
例外必须写进 ALLOWLIST 并注明理由与清除条件。

判据盯**构造**不盯**提及**：首版写成「出现 miduo.org 就红」，立刻误伤了联系邮箱
`contact@miduo.org` 与产品截图文案 `map.miduo.org`。那种误报会逼后来人把无辜文件塞进
例外清单，守卫就此失效。现判据是「用模板拼预览域名」「根域后缀常量」「网关子域后缀常量」
三条，已做红绿闭环（塞一个假推算文件进去两条同时变红，删掉转绿）。

当前例外只有 1 条：网关前端「回到 MAP」链接的兜底推算（见下条）。

#### PE-console-subdomain-rename · 控制台子域 llmgw-web → llmgw —— 已落地待验证

`-web` 是废字（llmgw 本来就是 web 控制台），还白占 4 个 DNS 标签额度 —— 长分支名下
这 4 个字符正是「发布得出 / 发布不出」的分界。2026-07-29 改名为 `llmgw`。

**旧地址不断**：发布器对每个规范子域同时发布 `LEGACY_SUBDOMAIN_ALIASES` 里的历史名
（`llmgw` → 也发 `llmgw-web`），入口表同样两个 key 都给。存量链接、存量部署（compose
未重新导入、profile 里仍写旧名）都照常工作；prd-api 侧解析也先查新名再回退旧名。

别名什么时候能删：确认没有存量链接/文档还指着旧名之后，从 `LEGACY_SUBDOMAIN_ALIASES`
去掉即可 —— 判据集中在一处，不散落。

#### PE-truncation-readability · 截断只在 `-` 段边界下刀 —— 已落地待验证

首版按字符硬切，切出 `...-f4oeh6-cla` 这种半截词，用户反馈「人类不知道怎么拼」。
改为按 `-` 分段丢弃整段，截出来的每一段都是完整单词。摘要仍保留（段截断照样会
让前几段相同的长分支撞 host）。无连字符的超长 slug 退回字符硬切兜底，避免空串。

#### PE-llmgw-console-mapnav · 控制台反推 MAP 地址是第三份域名实现 —— 已落地待验证

`resolveMapHomeHref` 按 `location.hostname` 剥控制台子域后缀来推 MAP 主入口 —— 与 MAP
侧刚拆掉的那份同源，且硬编码 `-llmgw-web`，子域一改名就整片失效（「返回 MAP」和教程
深链一起断）。

**已改为平台下发**：console-api 读 `CDS_PREVIEW_URL`（分支主入口 = MAP），经匿名的
`/gw/healthz` 下发 `mapHomeUrl`；`getHealth()` 收到即喂进 `setPlatformMapHome`，
`resolveMapHomeHref` 优先返回权威值。喂值放在 api 层而不是页面里，页面一行未改
（也就不碰 `GatewayDataDomainGuardTests` 的 343 条跨模块源码契约）。

**保留的兜底**：平台没下发时（正式环境 / 旧版 CDS / 首帧尚未拿到 health）仍走后缀推算，
后缀表收敛在文件内唯一一处、新旧名都认。这条兜底是全仓守卫当前唯一的例外。
待所有部署都下发 `mapHomeUrl` 后即可删掉推算分支与该例外。

#### PE-long-branch-hash · 超长分支的 host 仍会出现 8 位摘要 —— open

用户明确指出摘要「不符合设计」：`ff49186f` 和先前的半截词 `cla` 是同一类问题 ——
人读不出、记不住、拼不对。

**现状影响已大幅收窄**：子域从 `llmgw-web` 缩到 `llmgw` 省出 4 个字符后，previewSlug
≤57 的分支一律原样发布、不含摘要（本分支 57 恰好压线，规范入口是完整可读的
`llmgw-self-service-panel-redesign-f4oeh6-claude-prd-agent-llmgw`）。摘要只在
slug > 57 时出现，即分支尾段超过约 40 字符。

**为什么没有一了百了**：纯函数式命名要同时满足「长度有界」「不依赖全局状态」
「无碰撞且可读」是不可能的 —— 截断必然可能让前几段相同的两个长分支塌成同一个 host、
互相抢路由（发布器早年因此宁可跳过不发布）。摘要是放弃「可读」换「无碰撞」。

**正解是放弃「不依赖全局状态」**：分支创建时分配一个**短、可读、存下来**的标签
（从分支尾段派生，同项目内重名就追加 `-2`），host 用存储值而非现算。Vercel / Netlify
都是这么做的。四个消费方（发布器 / 网关 URL / 入口表 / 两处 SSRF 白名单）手里都有
branch 实体，改读存储字段即可，无存储值的存量分支回落现有算法。

**未做的原因**：它改变所有预览 host 的生成语义，影响面是整个共享 CDS 的全部项目，
而本机无法端到端验证（CDS 平台未跑本分支代码）。需要用户拍板后再动。

### ONB-key-usability — 新人清单的「可用密钥」只镜像了 scope 一项

**状态**：open（边界已知，影响面窄）

网关前端判「这个租户有没有一把能用的密钥」，目前镜像了
serving 侧三项判据里的三条：`enabled`、未过期、scope 含业务调用（`invoke` /
`stream:invoke` / `raw:invoke`，对应 `GatewaySuccessorObservationPolicy.IsBusinessInvocationScope`）。

**没有镜像**的还有 `GatewayRuntimeGovernance` 的另外三项：`purpose`（`AllowsDataPlaneRequest`
按 sourceSystem 分流 runtime / external-platform）、`ingressProtocols`、`appCallerCodes`。
一把 purpose 或协议不匹配的密钥仍会被清单当成「可用」，用户点进 Quickstart 才会被拒。

**为什么没做**：把整张授权矩阵抄进 TS 就是判据分裂（`predicate-and-wiring-discipline`
形状 3），必然随服务端演进漂移。正解是服务端出一个 onboarding digest 端点，直接复用
serving 的判定 —— 但 `llmgw/console-api` 与 `llmgw/serving` 是两个独立 csproj，
console-api 不引用 serving，要复用得先抽一个共享判定项目。属独立改动。

### ONB-key-page-cap — 密钥列表 500 条上限会影响新人清单的两个事实

**状态**：open（边界已知，触发条件极窄）

`GET /gw/service-keys`按 `CreatedAt` 倒序 `Limit(500)`。
轮换过 500 把以上密钥的租户，若**最新 500 把全部被吊销/禁用**而更早的那把仍启用，
或唯一带 `lastUsedAt` 的记录落在 500 条之外，清单会把「签一把密钥」「跑通首条请求」
两步误判成未完成 —— 已上手的老租户会看到清单重新出现。

**为什么没做**：客户端拿不到分页之外的数据，没有不新增端点的修法。正解与
ONB-key-usability 同一个：服务端 onboarding digest（用存在性查询，不受分页影响）。
两条应当一并解决。

影响面：新人清单是提示性 UI，误判的后果是多显示一个步骤，不影响任何实际能力。

### ONB-everused-preflight — 「跑通首条请求」会被 preflight 提前点亮

**状态**：open（方向保守，影响面窄）

`GatewayRuntimeGovernance.cs` 对**任何通过授权的 scope** 都无条件写 `LastUsedAt`，
紧接着下一行才用 `IsBusinessInvocationScope` 区分「只有 invoke / stream:invoke /
raw:invoke 才算业务流量」。新人清单的 `everUsed` 取自 `lastUsedAt`，所以一次
readiness 或 route preflight（例如自动化探针）就会把「跑通首条请求」点亮，
而租户其实还没发过一条真请求。

**为什么没做**：客户端没有可读的「仅业务调用」持久标记。请求日志有，但默认只留
90 天——正是因为这个才从日志改成了 `lastUsedAt`（见上文 everUsed 的注释）；
`RecordSuccessorObservationAsync` 写的是轮换后继观测，不是通用的「首次业务调用」。
要做就得服务端落一个持久标记并出 digest，与 ONB-key-usability / ONB-key-page-cap
是同一个改动。

**误判方向是保守的**：`lastUsedAt` 只会让这一步**提前**变完成，不会让已完成的
倒回未完成。清单是提示性 UI，提前消失的后果是少一次提示，不影响任何能力；
同 session 内刚跑成功的情况另有 `markRequestCompleted` 本地确证兜住。

---

### 相关

- 根 `CLAUDE.md` 规则 #11 —— 预览地址只能来自 CDS API，禁止本地推算
- `.claude/rules/no-rootless-tree.md` —— 缺席要可声明，不假定不存在的能力
- `.claude/rules/predicate-and-wiring-discipline.md` 形状 3 —— 63 判据此前分裂在三处，本轮收敛

## 分享链接安全

分享链接体系的安全加固还差哪些项，以及已完成两波的验收点。

记录"快速分享"链接体系（网页托管 / 周报 / 知识库 / 工作流）尚未完成的安全加固项。
2026-05-20 用户安全审计触发，分两波完成（C1 前端引导、C2 网页+周报后端 Hash + 速率限制），
本文件留尾剩下的工作。

### 历史背景

| 时间 | 事件 |
|---|---|
| 2026-05-20 | 用户提出 4 个分享场景中"快速分享"按钮存在 5 类问题：默认数字短链 /s/{seq} 可枚举、短链无强密码要求、取消密码无警告、明文密码存储、无在线暴破防护 |
| 2026-05-20 C1 | 前端 ShareDialog 改造：默认长链、短链强 12 位密码、取消密码 10s 倒计时（网页托管 + 周报） |
| 2026-05-20 C2 | 后端 `SharePasswordService`（PBKDF2-SHA256 + FixedTimeEquals + per-shareLink 滑动窗口 1 分钟 10 次限速）落地网页/周报；DB 字段 `PasswordHash/PasswordSalt/RecentAttempts` 新增 |
| 2026-07-31 | 知识库分享补齐 C1 口径：此前创建分享时无条件分配数字短链、前端又优先展示数字链，用户看到的分享地址一直是可枚举的。现改为默认只给不可枚举长链，数字短链按需生成（与网页托管 2026-06-11 懒分配同口径） |

### 已知边界 / 待补项

#### -1. 历史发现：知识库 / 工作流 分享前端展示路由缺失（非本次引入）

**事实**（2026-05-21 curl 自查）：
- 知识库分享：创建分享时生成的是 `/library/share/{token}`，但前端路由表里压根没有这条 Route，只有 `/library/:storeId`
- 工作流分享：URL `/s/{token}` 走 ShortLinkRouter，但 ShortLinkRouter 没有 workflow 专用渲染分支
- 后端 `WorkflowAgentController` 没有 `shares/view/{token}` 端点（只有 list 端点）

**结论**：知识库 / 工作流分享的"分享出去给别人看"流程历史上就是不完整的，访客点击 URL 看到的是 SPA fallback（一般是 home 或 404 兜底）。

**修复方向**（独立任务，本系列不做）：
- 知识库：补上缺的那条 Route → 新建只读页面 → 调公开分享端点渲染
- 工作流：补一个按 token 取分享内容的后端端点 + 对应前端 Route 与只读页面
- 或者：把这两类的"分享"实质改为站内导航链接（私有功能），不发对外 URL

#### 0. P1.next：周报 / 知识库 / 工作流 ShareView 接 `tokenOverride` prop

**现状**：P1 把 4 处分享 URL 统一到 `/s/{token}`，但只有 `ShareViewPage`（网页托管）支持通过 prop 接收 token；其它 3 个 ViewPage 还在用 `useParams().token`，因此 `ShortLinkRouter` 拿到 (type=report/docstore/workflow, token) 后只能 `<Navigate to="/s/report-team/..." />` 跳转到旧专用路径。结果：**用户从字母 URL `/s/{token}` 打开周报分享时，URL bar 会闪一下变成 `/s/report-team/{token}`**。

**待办**：
- 3 个 ViewPage 各加 `tokenOverride?: string` prop（参考 `ShareViewPage`），优先 prop 后 fallback `useParams`
- `ShortLinkRouter.renderTarget` 把这 3 个 case 从 `<Navigate>` 改为直接 `<XxxShareViewPage tokenOverride={token} />`
- 验证：用 `/s/{字母 token}` 打开周报分享时 URL bar 始终保持 `/s/{token}` 不变

#### 1. 分享链接体检 / 测试器实验室页

**现状**：用户希望"做成功能，然后在实验室点击测试"。目前测试分享链接只能去具体页面（网页托管/周报/知识库/工作流）创建，且无法对比 3 种 URL 形态（`/s/{token}` / `/s/{seq}` / 旧 `/s/wp/{token}`）的行为差异。

**待办**：
- 实验室新建页面"分享链接体检"
- 输入：粘贴任意 slug（数字或字母）
- 调 `/api/short-links/resolve/{slug}` 解析得 (targetType, token, seq)
- 展示：3 种 URL（统一长链 / 超短链 / 旧版前缀链）+ 每条带"在新标签页打开测试"按钮
- 额外：列出当前用户最近 N 条分享，每条都能一键三种 URL 互转测试

#### 2. 知识库分享尚未支持密码保护

**现状**：知识库分享链接是"匿名公开访问"，Model 没有 `AccessLevel` / `Password` 字段，端点也没有密码校验逻辑。本次 C2 没有触碰，因为"加密码"是新功能（需前后端联动 UI 改造）而非纯安全修复。

**待办**：
- Model 加 `AccessLevel`（public / password）+ `Password` + `PasswordHash` + `PasswordSalt` + `RecentAttempts`
- 创建端点接受 `password` 参数；访问端点接入 `ISharePasswordService.CheckRateLimit` + `Verify`
- 前端弹窗（DocumentStorePage）接入 C1 同款 ShareDialog（默认勾选密码、强密码、警告）

#### 2. 工作流分享 ShareLink.Password 是 dead code

**现状**：Model 有 `Password` 字段但 `ViewShare` 端点仅校验 `AccessLevel ∈ { public, authenticated }`，根本没引用 `Password`。前端 ExecutionDetailPanel 用 `window.prompt` + `alert` 完成分享（不是 Dialog 组件）。

**待办**：
- 工作流目前实质上不支持密码保护功能 —— 要么删除 Password 字段（保留向后兼容字段），要么补全校验逻辑
- 前端 alert 升级为 ShareDialog 组件（接入 C1 同款）
- 工作流的 ShareLink Model 也加 `PasswordHash/Salt/RecentAttempts`（与其他三个同步）

#### 3. 数字短链端点速率限制

**现状**：`/s/{seq}` 端点根据 seq 直接解析 token 重定向；如果攻击者枚举 seq，每个不存在的 seq 也会消耗一次 DB 查询。本次 C2 没有为 `/s/{seq}` 入口加 IP-level 限流（前面提到 IP 不可靠，但对 `/s/{seq}` 这种枚举攻击只能按 IP 限流 —— 因为不绑定具体 shareLink）。

**待办**：评估是否需要在反向代理（nginx / CF）层做 `/s/{seq}` 的速率限制（如 100 req/min/IP），与应用层失败锁互补。

#### 4. 明文密码字段保留在 DB

**位置**：所有 ShareLink Model 的 `Password` 字段

**现状**：C2 同时存明文 + Hash，明文用于"展示给分享者"（让用户能看到他设的密码）和"复用去重"（同密码复用同 ShareLink）。如果 DB 被打爆，明文密码会泄露。

**待办**：评估是否值得移除明文 —— 移除后"展示给分享者"功能消失（用户必须自己记），"复用去重"逻辑也要改（按 Hash 比对而非明文）。安全收益 vs 体验损失需要产品决策。

#### 5. 已分配的数字短链历史链接

**位置**：现存 `web_page_share_links.ShortSeq != 0` 的所有记录、`short_links` 集合

**现状**：C1 改了"默认显示长链"，但**历史已经分享出去的数字短链 URL 仍然有效**。任何已经持有 `/s/123` 链接的人继续可访问（旧分享没密码 → 任何获得该数字的人都可访问）。

**待办**：评估是否需要批量"为旧链接补默认强密码 + 通知 owner 重新分享"，或者"批量删除无密码的数字短链"。需要产品决策（影响存量用户）。

### 验收点（已完成项）

供后续手工验证：

1. **网页托管 ShareDialog**：登录 → 网页托管页 → 站点卡片右上"分享"按钮
   - 默认弹窗：密码已勾选 + 默认长链
   - 展开"高级选项"勾选数字短链：密码 checkbox 自动锁定 + 自动填 12 位强密码 + 编辑成弱密码时按钮 disabled
   - 短链 + 取消密码：弹出 10s 倒计时风险确认模态
2. **周报 ShareDialog**：登录 → 周报页 → 团队周视图右上"分享"按钮
   - 默认弹窗：密码已勾选（8 位）+ 显示长链 `/s/report-team/xxx`
3. **后端 Hash 校验**：
   - 创建新分享后查 DB `web_page_share_links` 或 `report_share_links`：应同时有 `Password`（明文）+ `PasswordHash`（base64）+ `PasswordSalt`（base64）
   - 旧分享 PasswordHash 为空，访问时走明文恒时比对（不报错）
4. **滑动窗口速率限制**：
   - 用错误密码访问同一分享链接 10 次（1 分钟内）：第 11 次应得 HTTP 429 + `Retry-After` header
   - 等 1 分钟后再试：恢复
   - 输错 5 次 + 输对 1 次：清空窗口（输错记录不残留拖累下次）

### 关联文件

- `prd-api/src/PrdAgent.Infrastructure/Services/SharePasswordService.cs`（分享密码校验 SSOT）
- `prd-api/src/PrdAgent.Api/Controllers/Api/HomeRecentWorkController.cs`、`prd-admin/src/pages/AgentLauncherPage.tsx`、`prd-admin/src/stores/homeRecentWorkStore.ts`（登录后首页「继续上次」）
- `prd-api/src/PrdAgent.Core/Models/WorkflowModels.cs`、`prd-api/src/PrdAgent.Api/Controllers/Api/WorkflowAgentController.cs`（工作流分享与 dead 的 Password 字段）
- `prd-api/src/PrdAgent.Api/Controllers/Api/ShortLinksController.cs`（数字短链解析入口，待评估限流）
- `prd-admin/src/pages/labs/ShareLinkTesterPage.tsx`（分享链接体检页，待建）
- `prd-api/src/PrdAgent.Api/Services/DocumentStoreAgentWorker.cs`、`prd-admin/src/components/exchange/ExchangeTestPanel.tsx`、`prd-admin/src/pages/document-store/SubtitleGenerationDrawer.tsx`（跨模块债务 X-3 / X-4）
- `.claude/rules/no-rootless-tree.md`（无根之木禁令：本债务台账即"暴露未实现的能力"实践）

---

## CI 聚合闸接线（release-script-test 未进 ci-status）

分支保护认的是 `ci.yml` 里的聚合 job `ci-status`，而它的 `needs` 只有
changes / server-build / admin-build / desktop-check / cds-build / docs-readability /
acceptance-report-gate 七个，**没有 `release-script-test`**。

后果：`release-script-test` 里那一批守卫（静态发布布局、网关挂载一致性、公网表面冒烟、
发布证据、gw-smoke、rollout 账本、ASR WebSocket 转发、cdscli 冒烟覆盖，以及本次新增的
changelog 合并守卫）跑归跑、红也会显示在 PR 的检查列表里，**但红不会让 `CI Status` 变红**，
因此不阻断合并。这正是 `predicate-and-wiring-discipline` 形状 7 的一种：守卫接了 CI，
却没接到真正把门的那一处。

| ID | 说明 | 优先级 | 触发条件 | 状态 |
|---|---|---|---|---|
| CI-1 | `ci-status` 的 `needs` 与结果计算补上 `release-script-test`，让这批守卫真的把门 | **P2** | 下一次有人依赖这批守卫拦回归时；或任何一次「守卫红了却合进去了」 | new（2026-08-30 PR #1459 review 发现） |

**为什么当期不做**：它改的是全仓分支保护行为——这批守卫一旦进聚合，所有触碰发布脚本的
PR 都会被它拦。该 job 是路径过滤的，多数 PR 会 skip，聚合的结果计算要一并处理 skip 档，
属于需要人明确点头的流程变更（AGENTS.md §5.5 的 B 类），不该由一份周报 PR 顺手改掉。
发现它的那个 PR 已按范围熔断停在这里。

---

## 已结清（供回溯）

下列条目台账里已自己标记为解决/交付，移到文末只为让上文只剩未还的账；内容原样保留。

### 跨模块债务（在 PR #542 review 中被发现，但不属于本 PR scope）

| ID | 说明 | 文件 | 优先级 | 触发条件 |
|---|---|---|---|---|
| X-1 | `SubtitleGenerationProcessor.cs` 的 `doubao-asr` 异步分支曾传空 `multipartFields`，且参考实现 `TranscriptRunWorker.ProcessAsrViaGatewayAsync` 始终包含 `model / response_format / timestamp_granularities[] / language`。Gateway Exchange 路径只把 multipart 文件转成 `image_urls`，而 `DoubaoAsrTransformer.TransformRequest` 只读 `audio_url / audio_data / url`，因此该路径不能走 multipart files。当前代码已改为 JSON `audio_data(base64)`，并用 `SubtitleGenerationProcessorTests.DoubaoAsyncAsr_ShouldSendAudioDataJson_NotMultipart` 锁定回归。 | `prd-api/src/PrdAgent.Api/Services/SubtitleGenerationProcessor.cs` | **P1** | 已还债：2026-05-12 |
| X-2 | `ExchangeController.cs` SSE error 事件曾直接把 `ex.StackTrace` 前 3 行 + `ex.GetType().Name` + raw `ex.Message` 推给客户端，泄露后端实现细节（文件路径、类名、方法签名）。当前已改成客户端只收到友好 message、`errorCode`、`requestId`、`exchangeId`，完整异常仅通过 `LogError` 写服务端日志。 | `prd-api/src/PrdAgent.Api/Controllers/Api/ExchangeController.cs` | **P2** | 已还债：2026-05-12 |
| X-5 | `ExchangeController.cs` ASR 失败时后端先发 `result` event（含 text/segmentCount/durationMs/diagnostic），紧接着为兼容老前端再发 `error` event。前端 `ExchangeTestPanel.tsx` 的 error handler 曾把 `sseResult` 覆盖为 `text:''/segmentCount:0/durationMs:0`，把 result event 携带的部分转录数据丢光。当前已改为保留已有 `text/segmentCount/durationMs`，只追加 error message，并补充前端单测锁定。 | `prd-api/src/PrdAgent.Api/Controllers/Api/ExchangeController.cs` + `prd-admin/src/components/exchange/ExchangeTestPanel.tsx` | P3 | 已还债：2026-05-12 |

### 二、已知边界（后续可补）

| # | 边界 | 说明 | 补法 |
|---|------|------|------|
| 3 | 智能体接入台没进百宝箱 | 接入台已在三处可达（侧栏账号菜单、侧栏「实用工具」、命令面板），唯独没登记进百宝箱 `BUILTIN_TOOLS`：那里的每个条目都要求一张与既有风格一致的卡片插画（`src/assets/agent-card-art/{key}-light.webp` 与暗色对应），本轮没有可用素材，硬塞一张程序化渐变会明显劣于旁边的条目 | 补一对 `mcp-console` 插画后，在 `toolboxStore.BUILTIN_TOOLS` 加一条（`agentKey: 'mcp-console'`）、在 `AgentCardArtwork` 的 presentation 表加一行任务文案、在 `tokens.css` 明暗两块各加一条 artwork token；三处齐了测试自然绿 |
| 2 | ~~实体全局时间戳近似~~（已修复 2026-07-05） | 首版用实体 `UpdatedAt/LastOpenedAt/LastExecutedAt` 近似"我的最近"，实测共享成员编辑、定时工作流自跑会顶进所有用户的继续上次（用户反馈"人人一样且不是自己操作的"）。已改为每用户台账 `home_recent_opens`（打开详情时 `RecentOpenTracker.TouchAsync` 打点），端点只读台账 | 已闭环；禁止回退全局时间戳方案 |

---

## 实现来源

给要跳去看代码的人；只读这篇文档的人可以整块跳过。

| 位置 | 文件 |
|------|------|
| 总览 | `prd-admin/src/pages/changelog/ChangelogPage.tsx` |
| ONB-key-page-cap — 密钥列表 500 条上限会影响新人清单的两个事实 | `llmgw/console-api/Program.cs` |
| 0. P1.next：周报 / 知识库 / 工作流 ShareView 接 `tokenOverride` prop | `prd-admin/src/pages/ReportTeamShareViewPage.tsx`、`prd-admin/src/pages/DocumentStoreShareView*.tsx`、`prd-admin/src/pages/WorkflowShareView*.tsx`、`prd-admin/src/pages/ShortLinkRouter.tsx::renderTarget` |
| 2. 知识库分享尚未支持密码保护 | `prd-api/src/PrdAgent.Core/Models/DocumentStoreShareLink.cs`、`prd-api/src/PrdAgent.Api/Controllers/Api/DocumentStoreController.cs::AccessShareLink` |
| 关联文件 | `prd-admin/src/pages/WebPagesPage.tsx::ShareDialog`、`prd-admin/src/pages/report-agent/components/ShareTeamWeekDialog.tsx` |
| 相关 | `cds/src/services/preview-slug.ts`（slug 计算 SSOT含 v1/v2/v3 沿革） |
| 相关 | `cds/tests/services/preview-entrypoints.test.ts`（入口表守卫含 67 字符现场用例） |
