# 视觉创作 · 债务台账

> **版本**：v1.0 | **日期**：2026-07-31 | **状态**：开发中

**一句话**：视觉创作两条线的欠账合成一册：验收技能的分波待补项，以及视觉分镜台首版边界。
**谁该读**：接手视觉创作或其验收技能的工程师。
**读完能做什么**：按线定位欠账与明确不做的部分。

---

> 本台账由 2 份同模块台账合并而成，内容原样保留、只做归位；原文件已回收，引用已改指本文。

## Visual Agent 验收技能

视觉验收技能各波已落地与待补内容，以及明确不做的部分。

> 模块: create-visual-test-to-kb 验收技能
> 创建: 2026-05-27

`create-visual-test-to-kb` 技能 2026-05-27 做了一波增强（wave 1），本文件登记当时刻意不做、留作后续的部分，避免下一次 session 无人记得。

### wave 1 已落地（2026-05-27）

- **E1 强制必给地址**：`archive_report.py` doc-store 模式归档收尾必打印「验收归档完成 · 必给地址」块——分享短链优先，接口超时拿不到则给 owner 登录路径；条目已建即视为归档成功，分享链单独 try/except，绝不静默。curl 重试 3→5、退避加长。main() 包 try/except，写库失败打印「归档失败」+ exit(3)，不抛裸栈。
- **E2 ZZ 照做风模板 + 逐步配图**：新增 `templates/zz-report.md`（全大标题、一句话一步、文字在上图在下、分支顺序讲）。`assemble()` 支持 `{{IMG:<截图name>}}` 逐步内联占位（与旧 `{{EVIDENCE}}` 集中证据二选一/并用）；`validate_inputs` + `PLACEHOLDER_PAT` 放宽接受 `{{IMG:`。标准 §6.3 写明 ZZ 九条铁律。
- **E3/E4/E7 画框 + 步骤序号**：`harness.mjs` 新增 `box`/`clearBoxes`/`stepClick`/`stepShot`。`stepClick` 在点击目标上画红框 + 序号角标 → 截「点这里」图 → 清框 → 真点击；`stepShot` 截结果图并框住变化处。让"点哪到哪""哪里变了"一目了然。已用本地样例验证红框 + 序号渲染正确。
- **旧命名固定结构 + 状态走标签**（用户定 2026-05-27，已于 2026-07-23 被新规则取代）：旧标题为 `项目 · 模块 · 功能 · 操作方式 · 验收报告`。其“状态走元数据”的原则继续保留，但项目名和冗余报告后缀不再占标题首部；新报告统一使用 `验收前缀 · 重点对象 · 目标日期`，见 [doc/rule.acceptance.map-enterprise.md](./rule.acceptance.map-enterprise.md) §4.1.2。
- **防断头报告**（实测根因 2026-05-27）：doc-store 两步归档（建条目→PUT 正文），PUT 撞 524 会留下"有标题、点开空白(暂无可预览的内容)"的空壳。修复：建条目后强制 `GET /content` 校验 `hasContent`，PUT 抛错（curl 重试耗尽）或返回了但没落库都先复查、再写一次→仍失败自动删空壳 + 报错（main 打印「归档失败」exit 3）。standard §2.2 立为硬规则。教训：此前 5 条历史归档全是空壳（PUT 在早期 CDS 不稳时静默丢失），用户"点开看不到"才暴露。注：524 多是网关丢了**响应**，写入其实可能已落库——故校验以 `hasContent` 为准，不以 PUT 返回为准。
- **分享 URL 路由修正**（实测 2026-05-27）：脚本原拼 `/library/share/{token}`——该路由在 App.tsx **不存在**，会落到营销首页（用户以为没分享）。正确路由是 `/s/lib/{token}`（`LibraryShareViewPage`），实测能渲染书册目录 + 正文 + 4 张内联截图，可直接当"点开即看"交付。SKILL.md「分享给登出第三方」旧称"只渲染目录不渲染正文"的缺陷描述同步更正（新页面已能渲染正文）。
- **殿堂≠分享 概念订正**（用户强调 2026-05-27）：殿堂(发布到殿堂)=`isPublic=true`→进 `/public/stores`→**对所有人**公开浏览；分享(共享给别人)=`/s/lib/{token}`→**对部分人**(持链接者)，token 独立授权，**库私有也能看**(已实测：库 isPublic=false 时分享链仍渲染正文+4图)。二者正交，绝不能拿"设 public 进殿堂"冒充"分享给某人"。修复：(A 数据)把「验收报告」库 `isPublic` 从误设的 true 改回 false→退出殿堂，分享链仍可用；(B) SKILL.md 交付段重写为三路径(分享链/owner自看/殿堂)并删掉"设 public 走殿堂当分享"错误兜底；(C) archive_report.py 复用库时校验 isPublic 与 config 不符则告警，必给地址默认给分享链+owner、殿堂不作默认；(D) standard §8.5 立术语区分。教训：该库被早期 session 误设公开，验收报告一度对所有人可见，是可见性漂移。

- **归档后自查能否打开**（用户要求 2026-05-27「创建之后要能打开」）：新增 `scripts/verify-open.mjs`——headless 打开分享链断言报告真渲染(标题 + 正文 + 截图)，exit 0=能看、exit 2=空/打不开→重新推送验收。SKILL.md 工作流第 5 步定为强制：归档后必跑，杜绝"建了条目但点开空白"流到用户手里。全链路复验已实测：脚本归档(写正文 success + hasContent 校验) → 分享链 → verify-open(必现文字命中 + 4 图齐 + 无死页 exit 0) 全绿。历史 2 条空壳(旧MECE + SaaS)已删除，库内仅剩有内容条目。

### wave v1.0 已落地（2026-06-04，固化自元 issue #605 三位执行 Agent 反馈）

harness `scripts/harness.mjs` 实装、本地自测 10/10 通过（local http 造 console.error + 500 + 未捕获异常 + 撑破 modal + dark-only 页，断言全部命中）：

- **运行时错误自动捕获**（issue #605 二.2，"机器最该补、人最易漏"）：`attachAutoCapture`，`launch()` 默认装。pageerror→P0、同源 5xx→P0、console.error→P1、同源 4xx→P1、requestfailed→P1。判级保守去噪：只计同源（app 自己 host），跨域第三方不计；401/403/404 跳过；主动 abort 跳过；`ignore` 正则白名单。`blockSeverity`（默认 P0）：≥此级别的 finding 自动折叠进"截图那一刻"的 warnings → `archive_report.py` 准入（§3.5 第 4 项）直接拒收，把机器抓到的严重运行时错误变成硬门禁。P1 记 result.json 不硬阻断。
- **机读 result.json**（issue #605 二.3）：`writeManifest(outDir, extra)` 除 manifest.json（契约不变）外同写 result.json = `{verdict,target,themeSupport,timing,shots,autoFindings,autoFindingsSummary}`，下游 Agent 直接消费不解析 markdown。
- **dark-only 双主题伪命令消除**（issue #605 二.2）：`detectThemeSupport` 切 dark/light 采样 body 背景亮度，差 < 24 判 dark-only，driver 据此单图 + 注明，不计 fail。
- **导航 timing**（issue #605 二.5）：`captureTiming`，呼应 CLAUDE §6。
- **过程视频**（issue #605 二.1）：见下方"录屏决定重审"。
- 标准同步：`reference/standard-v2.md` §5.3/5.4/5.5 + header；离线镜像 [doc/rule.skill.issues-system.md](./rule.skill.issues-system.md) §5 bump v1.0。

#### 录屏决定重审（2026-06-04）

2026-05-27 用户原话"录屏幕有点难了"判"明确不做"，顾虑是**体积大 + 阅读器不渲染 + 进知识库正文膨胀**，但当时也留口"未来若要做必须走外部对象存储 + 仅存链接，不进知识库正文"。issue #605 二.1 执行 Agent 复提视频为最高 ROI。**调和方案（不违背原决定）**：`launch(cfg,{recordVideoDir})` + `finalizeVideo()` 产 `walkthrough.webm` 作**默认关闭的本地可选附件**，**绝不自动上传知识库正文**——完全落在原决定的"未来若要做"caveat 内。需长期托管仍走外部对象存储仅存链接。

### wave 2 待补（差异化）

- **E5 自动识别变化区画框**：当前 `stepShot` 的高亮区要调用方手传 locator。理想是操作前后 DOM diff 自动定位"新增/变化的元素"并自动画框，driver 不用手指。可借 MutationObserver 在 `stepClick` 内记录点击后新增节点，回传给下一张 `stepShot` 当默认 highlight。
- **E6 流程缩略图横条**：把一轮验收的 N 张步骤图拼成一条带序号的横向缩略图（流程总览），放报告顶部"一眼看完整个流程"。纯图像拼接（可 Playwright 起一个 canvas 页或 python PIL），不依赖外部服务。
- **E8 AI 生成 ZZ 文案**：步骤 caption / 一句话描述目前人写。可接 `ILlmGateway`（走 AppCallerRegistry 注册一条 caller）把"截图 + 操作动作"喂给 vision 模型自动产 ZZ 风一句话，人只校对。注意 CLAUDE §6 流式可视化、§0 禁 emoji。

### wave 3 待补（智力层）

- **E9/E10 AI 视觉判定 + Verdict 建议**：把 N 张截图喂 vision 模型，自动比对"预期 vs 实际"、给出每条用例 pass/fail 初判 + 整体 Verdict 草案，人只复核。能把"读图核对"从纯人工降到"AI 初筛 + 人确认"。需谨慎：AI 判定只作建议，最终 Verdict 仍由 §7 规则 + 人把关（避免假阳性放过真 bug）。
- **E11/E12 历史回归对比**：同一目标的本轮截图与上一轮归档截图做像素/结构 diff，自动标出"这次和上次哪里变了"，回归验收用。依赖归档库按 target 检索历史报告 + 取图。

### 明确不做（用户 2026-05-27 定）

- **录屏（screen recording）**：用户原话"录屏幕有点难了"。Playwright 有 `recordVideo` 能力，但产物大、入库膨胀（与"代码里不允许验收图片"的体积顾虑同源）、且分享阅读器不渲染视频。结论：不做，留此条说明缘由，未来若要做必须走外部对象存储 + 仅存链接，不进知识库正文。**（2026-06-04 重审：已按此 caveat 落地为"默认关闭的本地可选附件，不进知识库正文"，见上方 wave v1.0「录屏决定重审」。原顾虑未被违背。）**
- **自动把操作过程转成视角偏移 + 标注的现成开源组件**：子智能体 2026-05-27 搜过 GitHub，无 Playwright 可直接集成的"自动平移/缩放镜头 + 标注"库。最接近的 Screenize（操作录制转视频）、rrweb（会话回放）都不是 Playwright 截图链路能直接拼的（一个是独立录屏 app，一个是 DOM 事件回放 SDK）。结论：放弃找现成轮子；我们自建的 `box`/`stepClick` 红框 + 序号已覆盖"标注"这一核心诉求（"视角偏移"= 镜头跟随，属录屏范畴，随上一条一起不做）。

## Visual Agent 视觉分镜台

视觉分镜台（先排分镜再逐格生成关键帧）首版的已知边界与评审后追加的待补项。

> 模块：prd-admin `/visual-storyboard` + prd-api ImageGenController storyboard-script
> 首版：2026-06-14（storyboard-first MVP，复用视觉创作生图引擎渲染关键帧）

### 背景

视频智能体原实现简陋（storyboard 半成品：拆镜后无润色、无拼接、串行、裸轮询）。
本次按「分镜优先（复用图片引擎）」方向重做为「视觉分镜台」：想法/文章 → LLM 拆镜 →
每镜关键帧图复用成熟的 image-gen run + SSE + 重试链路实时渲染 → 逐镜精修。
出视频（image-to-video）作为可插拔上层，本期不依赖视频模型额度（用户确认无可用额度）。

### 已知边界（后续可补）

| # | 边界 | 现状 | 后续 |
|---|------|------|------|
| 1 | image-to-video（「动起来」） | 每镜/整片按钮已接线但**显式禁用**，tooltip 说明「需配置视频模型池」 | 配置「视频生成」模型池后：末帧 carry-forward 做参考帧 + 逐镜 image-to-video + ffmpeg 拼接成片 |
| 2 | 分镜会话持久化 | 分镜组合（scenes 列表 + 关键帧映射）目前驻留前端，刷新后丢失；关键帧图本身经 image-gen 落 COS | V2：把 storyboard 作为一等 run 实体存库（参考 ImageGenRun），支持列表/恢复/分享（违反 frontend-architecture「前端无业务状态」，列为优先债） |
| 3 | 关键帧并发与连贯性 | 当前每镜独立 text2img，风格靠 LLM 在每条 keyframePrompt 注入统一 style 描述维持 | 引入 style-lock（固定 seed / 参考首帧 img2img）强化人物/色调跨镜一致 |
| 4 | 拆镜可视化 | 拆镜 LLM 调用期间用骨架卡过渡（~10-40s）+ 预估耗时提示 + 旋转图标；非流式（Codex P2 提议改 SSE）| §6 兜底（动画加载+预估耗时）已满足；进一步可改 SSE 流式逐镜吐出降低等待感。后端处部署冻结，新增 SSE 端点需部署验证，暂缓 |
| 5 | 上传入口 | 输入仅 textarea 贴文（零摩擦：示例一键填充 + 风格可选） | 补文档/文件上传入口（对齐 zero-friction-input：能上传不手输） |

### 验证记录（2026-06-14）

- CDS 部署（commit 423c2b5b）后 Playwright 真实登录直连预览域名验收。
- 闭环证据：拆镜出 6 镜 → 关键帧逐张真实渲染（暖色电影感手冲咖啡，风格跨镜一致）→ 放大预览清晰。
- 截图：分镜生长中（骨架）/ 关键帧已渲染 / 放大预览。非「生成中」充数，符合 closed-loop-acceptance。

### 已知边界 / 待补（PR #858 review，2026-06-19）

- **OpenRouter 出图画幅 aspect_ratio 已透传（Codex P2，2026-06-20，已实现待部署验证）**：按 OpenRouter 官方 image-generation 文档，chat/completions 出图用 `image_config.aspect_ratio`（受支持集 1:1/16:9/9:16/...）控制形状。`OpenAIImageClient` 的 OpenRouter 分支已据请求 `size` 用 `DeriveOpenRouterAspectRatio` 推出最接近比例并注入 `image_config.aspect_ratio`（推不出则不加，避免未知字段）。`image_size`（分辨率档 1K/2K）暂留默认，规避成本/可用性意外。CDS 部署恢复后用非方形画幅复验首帧比例与图生视频一致。
- **OpenRouter 出图未透传画幅（size/aspect）·历史记录**（Codex + Bugbot 双标 P2/Medium）：分镜台选的 16:9 / 9:16 / 1:1 经 `createImageGenRun` 以 `size`（如 `1280x720`）下发，但 `OpenAIImageClient` 的 OpenRouter 分支（`chat/completions` + `modalities`）只发 `model/messages/modalities`，画幅没到 OpenRouter，关键帧可能按模型默认比例出图、与所选视频画幅不一致。
  - 未处理原因：OpenRouter 经 `chat/completions` 出图的画幅控制字段（Codex 称 `image_config`）需对照 OpenRouter 文档核实确切 schema；贸然加未知字段可能被严格 API 直接 400，反而打断整条出图链路。且本分支后端处于「CDS 部署冻结」（见 [debt.cds.md](./debt.cds.md)「CDS 后端部署冻结 · 分支 api 跑旧代码 · debt」），无法部署验证。
  - 待办：确认 OpenRouter 图片生成画幅字段格式 → 在 OpenRouter 分支 `orBody` 注入（带容错，未知字段不应 400 整条链路）→ CDS 部署恢复后 direct i2v 脚本复验画幅是否匹配。

- **OpenRouter 出图模态写死 ["image","text"]，image-only 模型可能不支持**（Codex P2，2026-06-19）：`OpenAIImageClient` 的 OpenRouter 分支 orBody 写死 `modalities: ["image","text"]`。Sourceful/Flux 这类「只出图」模型不支持 text 输出模态，可能在出任何图前就失败。
  - 未处理原因：需按模型能力派生 modalities（image-only → `["image"]`），但 `OpenAIImageClient` 当前拿不到「该模型是否 image-only」的能力信息；与上一条 image_config 同属「OpenRouter 出图请求体需按模型能力定制」，且后端处于部署冻结无法验证。
  - 待办：引入模型能力标记（image-only / image+text）→ 据此派生 modalities 与 image_config → CDS 部署恢复后用不同模型复验。

- **生图模型选择按 platformId 消歧未生效**（Codex P2，2026-06-20，暂缓）：分镜关键帧选模型时前端已存 `modelId`+`platformId` 并下发，run 也存了 PlatformId、worker 一路透传到 `OpenAIImageClient.GenerateAsync`，但 `GenerateAsync` 解析处（`ResolveModelAsync(appCallerCode, "generation", modelName, ct)`，约 L165）只按 modelName 解析、忽略 platformId。若两个 text2img 池在不同平台暴露同一 modelId，`ModelResolver` 会命中第一个匹配池 → 下拉里选的「另一个平台同名模型」不被尊重，关键帧可能跑到错误 provider/成本档。
  - 暂缓原因：根治需给核心解析链 `IModelResolver.ResolveAsync` / `ILlmGateway.ResolveModelAsync` / `ModelResolver` 匹配逻辑加 `expectedPlatformId` 形参并在匹配时优先选该平台——这是全系统所有 LLM 调用都过的中枢路径，blast-radius 大，且后端处于部署冻结无法验证。贸然改中枢解析器风险高于该边缘 config 的收益。
  - 待办（任一）：(a) 给 ResolveAsync 链加 expectedPlatformId 形参，GenerateAsync 把入参 platformId 传入解析；或 (b) 前端改送 pool code/configModelId，worker 走 ConfigModelId 路径锁定具体池。CDS 部署恢复后多平台同名模型复验。
- **离开页面/重新生成时已取消在途「动起来」视频 run**（Codex P2，2026-06-19，已修）：animateScene 提交 createVisualVideoRunReal 后若 genRef 已变（新板/卸载），调 cancelVisualVideoRunReal 取消刚创建的 visual-agent 视频 run（后端 VisualAgentVideoController 已有 CancelRun 端点，按 owner+appKey 鉴权），避免 worker 继续烧视频额度。属用户主动替换工作、非被动断开，不违反 server-authority。
  - 后端已闭环（2026-06-19，Codex P2）：VideoGenRunWorker.ProcessDirectVideoGenAsync 在领取后与提交 OpenRouter 之前两道 CancelRequested 闸（claim 仅过滤 Status==Queued，不看取消标志），命中即置终态不提交，杜绝「前端已取消但 worker 仍提交烧额度」的窗口。
  - 仍未覆盖：关键帧 ImageGenRun（下条）——其走 SSE、无同步返回的 runId，取消成本更高，留待分镜持久化重构。
- **离开页面时未取消在途关键帧 ImageGenRun**（Codex P2，2026-06-19）：卸载/重生成只 abort 前端 SSE，后端 `renderKeyframes` 创建的 `ImageGenRun` worker 仍继续出图，消耗 API 调用（配额已全局放开，主要是上游花费），且无恢复入口。
  - 暂缓原因：与 `server-authority.md`「客户端被动断开不得取消服务器任务、只有用户主动取消才中断」存在张力——runs 本就以 `ImageGenRun` 持久化、理论可恢复，问题是分镜台目前没有恢复 UI。补「主动取消端点 + 卸载时调用」还是「补恢复 UI 让 run 跑完可复用」是产品取舍，宜与 debt#2「分镜会话持久化」合并设计，不在本次 review 轮次内仓促加 auto-cancel（会与 server-authority 冲突）。
  - 待办：随 debt#2 把 storyboard 提升为一等 run 实体时一并决策（恢复 vs 主动取消端点）。

---

## 分层 PSD 导出（PR #1328，2026-08-05）

把生成图交给语义分层模型拆成 RGBA 图层、再在前端组装成可直接编辑的 PSD。以下是交付时明确的已知边界。

### 验收结论：产品链路跑不通，分层调用稳定超时

拿到可用的 MAP 账号后，这条链路第一次被真实调用过。结论从「未验证」变成「已验证为失败」——功能在部署环境里**没有跑通过**。

已验证成立的：直接调用上游分层模型返回正确层数；`psd-tools` 拆开产物确认图层、透明度与合成正确；三处判据缺陷各自的红绿闭环；CI 全绿。也就是说模型侧和 PSD 组装侧都没问题。

真实产品路径上观察到的：

| 调用 | 结果 | 耗时 |
| --- | --- | --- |
| 分层（4 层） | 网关 504 | 30.7 秒 |
| 分层（2 层） | 网关 504 | 30.7 秒 |
| 普通文生图（对照） | 业务错误「User not found」 | 2 秒 |

两次分层都恰好卡在 30.7 秒，是固定超时而非偶发。分层是同步端点，而模型本身要二三十秒，正好撞上边缘网关的超时上限。这解释了能力卡为什么一直停在「已安装，等待验证」——验证需要一次成功调用的日志，而每次调用都在拿到结果前被切断。此前台账里写「跑通一次即可证伪」，现在已经证伪：跑不通。

对照组暴露出第二个独立问题：同一个账号调普通生图两秒就返回「User not found」。按仓库既有规则，这个文案是自家访问控制层拿不到用户身份时的表现，不是上游模型的错误。两个现象行为不同（一个 30 秒超时、一个 2 秒被拒），说明它们不是同一个原因。

尚未分辨清楚的：分层这 30 秒究竟耗在上游调用上，还是耗在到达上游之前的图片处理环节。主系统侧的调用日志里查不到任何分层记录，而网关侧日志需要独立的控制台凭据才能看，当前没有。

**修复（2026-08-06 已落地，尚未真机验收）**：分层改走任务与工作者模式，与 HTTP 连接解耦——提交立即返回任务号，前端订阅进度并展示「已生成 N/M 个图层」，产物由工作者落库；流断了再查一次真实状态才下结论。分层任务不带上游平台与模型，只带网关发布的能力标识。

同批修掉一处自己埋的接线断点：分层判定原本算在「必须提供模型」这条校验之后，导致不带模型的分层请求会先被挡下，后面清空选择器字段的代码永远走不到——编译过、测试绿，只有真点一次才会发现整条链路没通。判定已提前到校验之前，并有源码守卫钉住这个顺序。

仍未证实的：这条链路没有在真实环境跑通过一次。超时是否真的消失、能力卡是否随之转成「已验证」，都要等一次真实分层调用才能下结论。

**需要的外部输入**：一个在访问控制层可见、能正常调用模型的主系统账号；一个网关控制台管理员账号（用于查网关侧日志与能力卡状态）。浏览器路径另有阻塞：工作环境的出站代理不放行浏览器流量，同一个进程里 node 侧请求栈拿到 200、渲染栈连接被重置，装入代理根证书后 TLS 层通了仍被重置，禁用校验与绕开代理都是明令禁止的，因此界面截图取证仍做不了。

**补法**：拿到一个带 `VisualAgentUse` 的 MAP 账号 + 一个 LLMGW 管理员账号，即可用 curl/node 覆盖除 UI 点击外的全链路（录 Key → 分层 → 在 node 里跑同一份 `ag-psd` 组装 → `psd-tools` 验证）；要出 UI 截图则需换一个放行浏览器流量的环境。在补上之前，本功能不得声称「已通过真视觉验收」。

### 最后一公里只在前端，测试覆盖不到

PSD 组装全在前端，用 `ag-psd` 加浏览器 Canvas 完成，后端没有对应实现。合成与文档结构那几个纯函数可以单测，但「把远端图层解码 → 画进 Canvas → 写出 PSD 字节」这一段依赖浏览器 API，vitest 覆盖不到，只能靠真人下载后用 Photoshop 或 GIMP 打开确认。若日后要自动化，需要在 node 侧引入图像解码库复刻这段取像素的逻辑。

### 快捷编辑的图层归属：同序号两版并存

对某个 AI 图层做快捷编辑，产物继承同一个图层序号，**不摘除原图层**——画布上同一序号会并存两版，导出时只取最新的一版。这是有意取舍：编辑还在跑或者失败时产物没有图片地址，会被导出侧滤掉，于是自动回落到原图层，不会导出一张空层。代价是画布上的图层卡片数会随编辑次数增长，用户看到的条数多于 PSD 里的层数。若日后要收敛，应在编辑成功回填时把旧层标记为历史版本并从画布折叠，而不是简单删除——删除会丢失回退能力。

### verified 状态需要一次真实成功调用才能证伪

LLMGW 图片分层能力卡的「已验证」判据是：请求日志里存在一条该能力的成功调用记录，且确实产出了图。此前这条查询按 `ActualModel` 字段过滤，而落库的字段叫 `Model`——查一个不存在的字段不会报错，只会永远 0 命中，**修复前它不可能转成已验证**。修复已随本 PR 上线，并有一条反射断言钉住字段名必须真实存在于日志实体上。但「现在停在等待验证，到底是确实没人调用过，还是判据还有别的问题」，在没有一次成功调用记录之前分不出来。跑通一次分层即可证伪。

### 实现来源

- 前端 PSD 组装与分层请求：`prd-admin/src/lib/layeredPsd.ts`
- 图层归属与导出选层：`prd-admin/src/lib/semanticLayerFrame.ts`、`prd-admin/src/pages/ai-chat/AdvancedVisualAgentTab.tsx`
- 网关侧能力判定与守卫：`llmgw/console-api/Provisioning/ImageLayeringCapabilityRules.cs`、`prd-api/tests/PrdAgent.Api.Tests/Gateway/ImageLayeringCapabilityRulesTests.cs`
