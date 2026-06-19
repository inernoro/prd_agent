# debt.visual-storyboard — 视觉分镜台工程债务台账

> 状态：active | 模块：prd-admin `/visual-storyboard` + prd-api ImageGenController storyboard-script
> 首版：2026-06-14（storyboard-first MVP，复用视觉创作生图引擎渲染关键帧）

## 背景

视频智能体原实现简陋（storyboard 半成品：拆镜后无润色、无拼接、串行、裸轮询）。
本次按「分镜优先（复用图片引擎）」方向重做为「视觉分镜台」：想法/文章 → LLM 拆镜 →
每镜关键帧图复用成熟的 image-gen run + SSE + 重试链路实时渲染 → 逐镜精修。
出视频（image-to-video）作为可插拔上层，本期不依赖视频模型额度（用户确认无可用额度）。

## 已知边界（后续可补）

| # | 边界 | 现状 | 后续 |
|---|------|------|------|
| 1 | image-to-video（「动起来」） | 每镜/整片按钮已接线但**显式禁用**，tooltip 说明「需配置视频模型池」 | 配置「视频生成」模型池后：末帧 carry-forward 做参考帧 + 逐镜 image-to-video + ffmpeg 拼接成片 |
| 2 | 分镜会话持久化 | 分镜组合（scenes 列表 + 关键帧映射）目前驻留前端，刷新后丢失；关键帧图本身经 image-gen 落 COS | V2：把 storyboard 作为一等 run 实体存库（参考 ImageGenRun），支持列表/恢复/分享（违反 frontend-architecture「前端无业务状态」，列为优先债） |
| 3 | 关键帧并发与连贯性 | 当前每镜独立 text2img，风格靠 LLM 在每条 keyframePrompt 注入统一 style 描述维持 | 引入 style-lock（固定 seed / 参考首帧 img2img）强化人物/色调跨镜一致 |
| 4 | 拆镜可视化 | 拆镜 LLM 调用期间用骨架卡过渡（~10-40s）；非流式 | 可改 SSE 流式逐镜吐出，进一步降低等待感 |
| 5 | 上传入口 | 输入仅 textarea 贴文（零摩擦：示例一键填充 + 风格可选） | 补文档/文件上传入口（对齐 zero-friction-input：能上传不手输） |

## 验证记录（2026-06-14）

- CDS 部署（commit 423c2b5b）后 Playwright 真实登录直连预览域名验收。
- 闭环证据：拆镜出 6 镜 → 关键帧逐张真实渲染（暖色电影感手冲咖啡，风格跨镜一致）→ 放大预览清晰。
- 截图：分镜生长中（骨架）/ 关键帧已渲染 / 放大预览。非「生成中」充数，符合 closed-loop-acceptance。

## 已知边界 / 待补（PR #858 review，2026-06-19）

- **OpenRouter 出图未透传画幅（size/aspect）**（Codex + Bugbot 双标 P2/Medium）：分镜台选的 16:9 / 9:16 / 1:1 经 `createImageGenRun` 以 `size`（如 `1280x720`）下发，但 `OpenAIImageClient` 的 OpenRouter 分支（`chat/completions` + `modalities`）只发 `model/messages/modalities`，画幅没到 OpenRouter，关键帧可能按模型默认比例出图、与所选视频画幅不一致。
  - 未处理原因：OpenRouter 经 `chat/completions` 出图的画幅控制字段（Codex 称 `image_config`）需对照 OpenRouter 文档核实确切 schema；贸然加未知字段可能被严格 API 直接 400，反而打断整条出图链路。且本分支后端处于「CDS 部署冻结」（见 `debt.cds-backend-deploy-freeze`），无法部署验证。
  - 待办：确认 OpenRouter 图片生成画幅字段格式 → 在 OpenRouter 分支 `orBody` 注入（带容错，未知字段不应 400 整条链路）→ CDS 部署恢复后 direct i2v 脚本复验画幅是否匹配。

- **OpenRouter 出图模态写死 ["image","text"]，image-only 模型可能不支持**（Codex P2，2026-06-19）：`OpenAIImageClient` 的 OpenRouter 分支 orBody 写死 `modalities: ["image","text"]`。Sourceful/Flux 这类「只出图」模型不支持 text 输出模态，可能在出任何图前就失败。
  - 未处理原因：需按模型能力派生 modalities（image-only → `["image"]`），但 `OpenAIImageClient` 当前拿不到「该模型是否 image-only」的能力信息；与上一条 image_config 同属「OpenRouter 出图请求体需按模型能力定制」，且后端处于部署冻结无法验证。
  - 待办：引入模型能力标记（image-only / image+text）→ 据此派生 modalities 与 image_config → CDS 部署恢复后用不同模型复验。

- **离开页面/重新生成时已取消在途「动起来」视频 run**（Codex P2，2026-06-19，已修）：animateScene 提交 createVisualVideoRunReal 后若 genRef 已变（新板/卸载），调 cancelVisualVideoRunReal 取消刚创建的 visual-agent 视频 run（后端 VisualAgentVideoController 已有 CancelRun 端点，按 owner+appKey 鉴权），避免 worker 继续烧视频额度。属用户主动替换工作、非被动断开，不违反 server-authority。
  - 仍未覆盖：关键帧 ImageGenRun（下条）——其走 SSE、无同步返回的 runId，取消成本更高，留待分镜持久化重构。
- **离开页面时未取消在途关键帧 ImageGenRun**（Codex P2，2026-06-19）：卸载/重生成只 abort 前端 SSE，后端 `renderKeyframes` 创建的 `ImageGenRun` worker 仍继续出图，消耗 API 调用（配额已全局放开，主要是上游花费），且无恢复入口。
  - 暂缓原因：与 `server-authority.md`「客户端被动断开不得取消服务器任务、只有用户主动取消才中断」存在张力——runs 本就以 `ImageGenRun` 持久化、理论可恢复，问题是分镜台目前没有恢复 UI。补「主动取消端点 + 卸载时调用」还是「补恢复 UI 让 run 跑完可复用」是产品取舍，宜与 debt#2「分镜会话持久化」合并设计，不在本次 review 轮次内仓促加 auto-cancel（会与 server-authority 冲突）。
  - 待办：随 debt#2 把 storyboard 提升为一等 run 实体时一并决策（恢复 vs 主动取消端点）。
