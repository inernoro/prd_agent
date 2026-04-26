# 视频生成 Agent · 债务台账

> **版本**：v1.0 | **日期**：2026-04-26 | **状态**：维护中

## 总览

| 指标 | 当前值 |
|------|--------|
| open | 4 |
| in-progress | 0 |
| paid | 0 |
| 总计 | 4 |

模块范围：`prd-api/src/PrdAgent.Api/Services/VideoGenRunWorker.cs`、`prd-admin/src/pages/video-agent/`、`prd-video/`、`OpenRouterVideoClient` 全链路。

---

## 债务列表

| ID | 严重度 | 创建日期 | 描述 | 触发条件 | 状态 | 备注 |
|----|--------|---------|------|---------|------|------|
| 2026-04-26-openrouter-cdn-expiry | medium | 2026-04-26 | 单镜直出完成后直接把 OpenRouter 返回的视频 URL 落到 `Scenes.{idx}.ImageUrl`，没下载到 COS。OpenRouter CDN 7 天后过期，老任务回看会 404 | 用户反馈"以前生成的视频打不开了"，或者要做归档/导出能力时 | open | 改 `ProcessSceneDirectVideoAsync` 完成分支：`HttpClient` 拉 mp4 二进制 → `_assetStorage.SaveAsync(domain=video-gen, type=video)` → 用返回的 COS URL 写库。和 Remotion 路径对齐 |
| 2026-04-26-mixed-ffmpeg-normalize | medium | 2026-04-26 | 混合渲染场景下分镜分辨率/帧率/codec 不一致就 ffmpeg concat 会撕裂：Remotion 默认 1920x1080@30fps H.264；OpenRouter 不同模型可能 1280x720@24fps、1080p@30fps、各家 codec 不同 | 用户开始混用模式后导出整段视频，发现拼接处闪烁/黑屏/比例错乱 | open | 在 `ProcessRenderingAsync`（最终拼接处，需要 grep 确认方法名）concat 前加一道 ffmpeg `-vf scale=...,fps=30,format=yuv420p` normalize；统一目标 1920x1080@30。或在 `VideoGenRun` 加 `TargetResolution / TargetFps` 字段供任务级配置 |
| 2026-04-26-direct-heartbeat-copy | low | 2026-04-26 | 单镜直出耗时 3-5 分钟期间前端只显示 MapSpinner + "渲染中…"，没有分级心跳文案（0-15s 静默 / 15-40s 提示模型/进度 / 40s+ 提示可中止）。违反 CLAUDE.md 规则 #6「禁止空白等待」第 2 阶段提示要求 | 用户开始抱怨"卡住了不知道还要多久" | open | `ProcessSceneDirectVideoAsync` 的轮询循环已经在发 `scene.direct.progress` SSE 事件，前端 SSE 处理改成按 elapsed 切换文案；同时把当前模型名 + jobId 做次要显示。参考 `PrReviewController.StreamLlmWithHeartbeatAsync` 的分级实现 |
| 2026-04-26-cost-preview-tooltip | low | 2026-04-26 | 切到「✨ 直通大模型」chip 时没显示预估单镜成本（$0.04/s × duration）。已经完成的镜次能看到实付，但选档时是黑盒 | 用户开始关心整体预算时（典型场景：要给一个长文章生成视频，9 个分镜每个直出 = 一笔不小的钱） | open | `services/contracts/videoAgent.ts` 的 `VIDEO_MODEL_TIERS` 已经记了模型 desc（含 ~$/秒），可以解析出单价；UI chip 上 hover 显示「单镜 ~$X / 整段预估 ~$Y」即可。或在直出参数面板顶部固定显示一个估算条 |

---

## 已还的债务（归档）

> 修复后从上面表格挪到这里，保留以便复盘

| ID | 修复 PR / commit | 修复日期 | 备注 |
|----|------------------|---------|------|

---

## 历史背景

| 日期 | 事件 |
|------|------|
| 2026-04-26 | 落地"分镜级渲染模式覆盖 + 混合渲染"功能（commit 73d4e5a），交付时主动声明 4 条已知边界，本台账作为方案 A 的首个落地实例创建 |
