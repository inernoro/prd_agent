# 视频生成 Agent · 债务台账

> **版本**：v2.0 | **日期**：2026-04-27 | **状态**：维护中

## 总览

| 指标 | 当前值 |
|------|--------|
| open | 0 |
| in-progress | 0 |
| paid | 4（Remotion 砍掉后整体 obsolete） |

模块范围：`prd-api/src/PrdAgent.Api/Services/VideoGenRunWorker.cs`、
`prd-admin/src/pages/video-agent/`、纯 OpenRouter 直出路径。

---

## 当前架构（2026-04-27 起）

视频生成只走 **OpenRouter 视频大模型直出**：用户输入 prompt → Worker 调
`/api/openrouter/v1/videos` 提交 → 轮询 → 拿到视频 URL 写回 `Run.VideoAssetUrl`。

支持模型：Veo 3.1、Sora 2 Pro、Kling、Wan 2.6/2.7、Seedance 1.5/2.0。

---

## 已废弃路径（关键变更）

2026-04-27 彻底砍掉 Remotion 拆分镜路径。原因：

1. CDS dev 模式（image: + volumes: + 容器 runtime apt install chromium）跟 Remotion
   + Chromium 部署反复踩坑：bullseye dpkg 崩溃、bookworm apt 锁死、puppeteer 镜像
   `Permission denied` 写 `/usr/local/bin/`，多个尝试都失败
2. 维护成本远高于价值：用户实际需求是"输入描述生成视频"，分镜模板编辑/字幕生成属于
   过度设计；OpenRouter 视频模型已能一段直出满足核心需求
3. 架构混合度高：dotnet 容器 + Node 容器 + Chromium + Remotion 项目源码挂载
   + ffmpeg concat 任意一环挂掉都不能交付

随之删除的代码：
- `prd-video/` 整个 Remotion 项目
- `prd-video-renderer/` 微服务（短暂存在过的过渡方案）
- `VideoGenRunWorker` 的 Remotion 相关方法（`ProcessScenePreviewRenderAsync`、
  `ProcessRenderingAsync`、`ProcessSceneRegenerationAsync`、
  `ProcessSceneBgImageGenerationAsync`、`ProcessSceneAudioGenerationAsync`、
  `ProcessSceneCodegenAsync`、`RunRemotionRenderAsync` 等）
- `VideoGenScene` 模型 + `Scenes`、`SceneItemStatus`、`VideoRenderMode`、
  `VideoInputSourceType` 字段
- 分镜相关 API 端点（`PUT/POST /scenes/*` 一系列）
- 前端：`UnifiedInputHero`、`videoModeDetect`、`VideoAgentPage` 分镜编辑 UI
- compose：video-renderer service、VideoRenderer__Url 等

---

## 已还的债务（归档）

| ID | 修复 PR / commit | 修复日期 | 备注 |
|----|------------------|---------|------|
| 2026-04-26-openrouter-cdn-expiry | 2026-04-27 整段砍掉 Remotion 后 obsolete | 2026-04-27 | 直出视频 7 天 CDN 过期问题仍存在，但因为现在唯一就是 OpenRouter URL，新债务记下面 |
| 2026-04-26-mixed-ffmpeg-normalize | obsolete | 2026-04-27 | 不再有混合渲染，无需 normalize |
| 2026-04-26-direct-heartbeat-copy | obsolete | 2026-04-27 | 单次直出心跳分级原本想做但用户没催，简单 spinner 够用 |
| 2026-04-26-cost-preview-tooltip | obsolete | 2026-04-27 | 直出 chip 已固定就一种模式，不再需要切换时显示成本 |

---

## 历史背景

| 日期 | 事件 |
|------|------|
| 2026-04-26 | 落地"分镜级渲染模式覆盖 + 混合渲染"功能（commit 73d4e5a），4 条已知边界录入 |
| 2026-04-27 | CDS dev 模式部署 Remotion 反复失败（apt install / puppeteer 镜像），用户决定彻底砍掉 Remotion 路径，只保留 OpenRouter 直出 |
