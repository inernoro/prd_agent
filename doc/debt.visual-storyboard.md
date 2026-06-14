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
