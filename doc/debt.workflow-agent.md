# 工作流 Agent · 债务台账

> **版本**：v2.0 | **日期**：2026-05-07 | **状态**：维护中

## 总览

| 指标 | 当前值 |
|------|--------|
| open | 5 |
| in-progress | 0 |
| paid | 7（Phase 2 留尾全部偿还） |

模块范围：`prd-api/src/PrdAgent.Api/Services/CapsuleExecutor.cs`、`prd-admin/src/pages/workflow-agent/`、所有 `CapsuleTypes.*` 胶囊执行链路。本文件只覆盖工作流胶囊侧的债务；视频生成（OpenRouter 直出）的债务见 `debt.video-agent.md`。

---

## paid 债务（Phase 2 7 项已还，2026-05-06 commit `0d3ca22`）

| 编号 | 债务 | 修复方式 | 验证 |
|---|---|---|---|
| #1-old | ASR 模型池绑定手动 | caller fallback 链：`video-agent.video-to-text::asr` → `video-agent.v2d.transcribe::asr` → `document-store.subtitle::asr`，任一绑定 doubao-asr-stream 即可 | 错误信息明确列三个 caller 诊断 |
| #2-old | maxItems 默认 4 硬编码 / 与 count 不联动 | 默认空 = 处理全部上游条目，模板移除 maxItems 配置 | iter 2 实测处理 5 条全转写 |
| #3-old | 缺 LlmRequestContext | hook 提炼前 `BeginScope`，UserId 从 `__triggeredBy` 取 | rule.llm-gateway.md 合规 |
| #4-old | rich-text body 空白破图 | body 为空时降级渲染 `PosterAdPageView` 全 bleed 视图 | feed-card 也复用此 fallback 模式 |
| #5-old | ffmpeg 缺失被误判 | `EnsureFfmpegAvailableAsync` 入口探测 + 平台特定安装指引 | 错误信息含 apt/brew/choco 三种方式 |
| #6-old | Play 后无返回 | 全屏视频左上角「返回详情」按钮重置 hasPlayed | rich-text 视图体验闭环 |
| #7-old | count 与 maxItems 跨节点未联动 | 同 #2-old：maxItems 默认空 → 自动跟随 count | 用户改 count 无需同步两处 |

---

## open 债务（按风险倒序，Phase 3 引入）

### 1. CDS dev 模式 hot-reload 卡进程

**触发场景**：CDS 上 api 服务以默认 `dev` 模式（dotnet watch run）部署时，遇到 rude edit（switch 加 case / 新增 method / 新增 class / 改 enum）。

**当前行为**：`dotnet watch` 检测到 rude edit 应该 fallback 到完整重启 .NET 进程，但**实测会卡住跑旧 IL**。表现为：
- workflow execute 一直命中"未知舱类型 'media-rehost'，已跳过"等
- stack trace 里源文件行号停在几个 commit 前的版本
- 部分请求又能命中新代码（IL 加载半新半旧）

**根因证据**：在分支 `claude/review-emergence-plan-Y8pOR` 上推完 `f349074` 后 8 小时，stack trace 仍报 `CapsuleExecutor.cs:line 6262` —— 这是 `cbef04c` 时期的行号，相差 24 小时。

**当前规避**：用户在 CDS dashboard 把 api 服务**部署模式从 dev 切到 static**（dotnet publish + Production），强制完整构建 + 重启。`cds-compose.yml` 的 `x-cds-deploy-modes.api.static` 已经定义此模式。

**理想行为**：
- 选项 A：`cds-compose.yml` api 服务默认就用 static 模式，dev 模式只手动切（推荐：本仓库这种规模的代码改动 dev 模式负担太大）
- 选项 B：CDS 后端检测 git push 时强制 `docker restart` 容器，绕过 dotnet watch 的不可靠 fallback

**估时**：30min（选项 A 改 cds-compose.yml 一行）

**关联**：`cds-compose.yml`、CDS 部署模式机制。

### 2. B 站 / YouTube 无 mp4 直链

**触发场景**：用户在 ad-4-3 / feed-card 模板里选 B 站或 YouTube，点 Play 按钮无视频可播。

**当前行为**：`NormalizeBilibiliVideoItem` / `NormalizeYoutubeVideoItem` 输出 `videoUrl=""`。weekly-poster-publisher 把 coverUrl 当 imageUrl 写进 page，前端 isVideoUrl 判定为图片，不显示 Play 按钮，正常展示静图卡片。CTA 跳转 bilibili.com / youtube.com。

**理想行为**：
- 选项 A：在 NormalizeBilibiliVideoItem 内追加 `fetch_video_playurl` 二次调用，拿真实 mp4 URL（B 站需 wbi 签名，复杂）
- 选项 B：feed-card 视图检测 videoUrl 为空时，Play 按钮变成「跳转原平台 ↗」

**估时**：B 选项 30min；A 选项 2-3h（wbi 签名实现）

**关联**：`CapsuleExecutor.cs` `NormalizeBilibiliVideoItem` / `NormalizeYoutubeVideoItem`、`PosterFeedCardView`。

### 3. 小红书图文笔记无视频

**触发场景**：小红书博主作品里的图文笔记（type=normal）。

**当前行为**：videoUrl 为空，coverUrl 取 cover.url_default 或 image_list[0].url。feed-card 视图正常展示首张图。但海报只展示一张图，没有翻多图（小红书原生支持图集）。

**理想行为**：feed-card 视图检测 image_list 长度 > 1 时，在视频区域加图片轮播（左右切换 vs 翻页箭头共用）。

**估时**：1.5h

**关联**：`PosterFeedCardView`、`NormalizeXiaohongshuItem` 输出 image_list 字段。

### 4. CDN avatar URL 也防盗链

**触发场景**：feed-card 海报顶部条头像在浏览器加载时。

**当前行为**：抖音 / B 站 / 小红书的 avatar URL 都防盗链。已在 `tiktokCreatorToHomepageTemplate` 模板里把 `authorAvatarUrl` 加入 `rehostFields` 默认值（`videoUrl,coverUrl,authorAvatarUrl`），通过 media-rehost 落到 cfi.miduo.org。但**用户手动改 rehostFields 配置时容易漏掉头像字段**。

**理想行为**：media-rehost 胶囊把头像字段做成必选（不可去掉），或者 PosterFeedCardView 检测到 avatar 是抖音 CDN host 时显示渐变兜底（已实现 onError 兜底，但仍发出 403 请求）。

**估时**：30min

**关联**：`tiktokCreatorToHomepageTemplate / tiktokCreatorToHomepageRichTemplate`、`PosterFeedCardView`。

### 5. TranscriptCues 仅 ASR 模式可得

**触发场景**：metadata / llm 模式不调 ASR，无 cues。feed-card 视图遇到 null 字段不渲染浮层。

**当前行为**：向下兼容 OK，但用户用 metadata 模式时看不到字幕。

**理想行为**：
- 选项 A：metadata 模式从上游 `subtitles` 字段（如果有）解析时间戳生成 cues
- 选项 B：UI 提示「此视频无字幕轨道」+ 引导切到 ASR 模板

**估时**：选项 A 视上游 subtitle 数据格式而定（30min-2h）；B 选项 15min

**关联**：`CapsuleExecutor.cs` `ExecuteVideoToTextAsync` metadata 分支、`PosterFeedCardView`。

### 6. 自动配置闭环：缺项卡只读 + 入口未对话化（2026-06-14 Phase 1）

**已落地**（`design.workflow-auto-config.md` 首期）：`WorkflowValidationService` 校验 + 自动接线 + 自愈 + 缺项扫描，对话气泡新增「已自动校验/接线/待补项」卡；已用 Playwright 直连预览域名验收（AI 一句话生成 → 「结构可执行」+ 列出 TAPD 工作空间 ID / Cookie 两项待补）。

**当前边界**：
- **缺项卡是只读清单**，不是可填表单：用户看到「补齐这 N 项」后仍需手动进对应节点配置 / 工作流变量填写，未做「就地填 → 一键写回」。Phase 2 应复用 `TemplatePickerDialog` 的字段组件做可填表单 + 提交后 patch 工作流（含 cookie 验证 / workspace 下拉 / secret 落变量）。
- **空状态未对话化**：`WorkflowListPage` 空状态仍是「新建工作流 / 从模板」，未把「描述你想做什么」大输入框作为默认入口（Phase 3）。当前对话入口只在画布编辑器内的「AI」按钮。
- **自动接线仅覆盖线性场景**：`AutoWireEdges` 在「零有效连线 + ≥2 节点」时按声明顺序链式连接；condition/merge 等分支/汇聚拓扑仍依赖 LLM 给出正确 edges（给错会被修正插槽，但不会自动补分支结构）。
- **structured output 未启用**：仍靠 ```json 提取 + 自愈回路兜底，未确认 Gateway 是否支持 response_format 强制结构化（Phase 2 决策 5）。
- **xUnit 单测已写未本地执行**：本环境无 dotnet SDK，`WorkflowValidationServiceTests`（11 例）随提交进 CI；本地校验走 CDS 静态构建（dotnet publish 通过）+ Playwright 端到端取证。
- **requiredInputs 未持久化**：校验结果只在本次 SSE 推送，刷新/重载对话历史不带 `requiredInputs`（`WorkflowChatGenerated` 未存该字段）。

**估时**：Phase 2 可填缺项卡 3-4h；Phase 3 空状态对话化 1-2h。

---

## 待落地（任务 D 上线后追加）

任务 D（抖音 OAuth + cron 真订阅）落地后，预计会引入新债务：
- aweme_id 去重表的索引策略（按 user/account 分桶 vs 全局）
- OAuth token 续期失败的降级策略
- cron 漂移对 5 分钟轮询粒度的影响

待真正落地后再补本节。

---

## 相关文档

- `doc/plan.emergence-1-tiktok-douyin-poster.md`：涌现 1 主计划文档（Phase 1 + 2 + 3 已完成）
- `doc/guide.poster-feed-card.md`：用户教程（多平台博主订阅 → 首页海报）
- `doc/debt.video-agent.md`：视频生成 Agent 债务（Remotion 已废弃路径）
- `.claude/rules/llm-gateway.md`：LlmRequestContext 强制要求
- `.claude/rules/server-authority.md`：CancellationToken.None + Run/Worker 模式
- `cds-compose.yml`：api 服务部署模式定义（dev / static）
