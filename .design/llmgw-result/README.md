# 网关产物屏改稿画板

Quickstart 签发完密钥之后那一屏（`llmgw/web/src/pages/QuickstartPage.tsx` 的 `.lg-qs-artifacts`）。
画布：https://claude.ai/code/artifact/600a34dd-81af-46b4-b0c4-e0318186d689 —— 以 `canvas.json` 为准，
这里只记「画了几张、落地到哪、哪些地方实现刻意不同」。

## 画板清单（9 张）

| 画板 | 讲什么 |
|---|---|
| `Main.dc.html` | 接入信息页签主稿：摘要条合并、密钥独占一行、页签降级成分段控件 |
| `KeyHero.dc.html` | 一次性密钥主区的标注版（为什么它要提到页签之上常驻） |
| `Curl.dc.html` | cURL 页签：上输入 / 下输出 + 请求片段 |
| `TestIO.dc.html` | 试跑区三态：还没跑 / 正在接收 / 已返回 |
| `Prompt.dc.html` | 提示词页签 |
| `AccessLight.dc.html` / `CurlLight.dc.html` | 浅色核对（嵌套底一律 `--bg-base`） |
| `AccessMobile.dc.html` | 390 宽 |
| `Spec.dc.html` | 改稿对照表：八处改动逐条「现状 → 改法」 |

## 落地状态

2026-08-28 全部落地并跑过 `/复刻` 并排比对（设计稿与实现同视口、同主题渲染，逐屏比对）。
守卫：`e2e/llmgw-quickstart-states.mjs`（输入输出同宽、空态占位、流式三点与耗时、
requestId 深链、「再跑一次」、输入内容进 cURL 与真实请求体）。

## 偏差台账

| 项 | 处置 | 理由 |
|---|---|---|
| 输入框可上下拖拽调高（`resize: vertical`） | 有理由保留 | 画板画的是静态一屏，长提示词需要能展开；不影响与输出块的同宽同圆角 |
| cURL 页签整屏可纵向滚动 | 有理由保留 | 试跑区多出 88+88 之后，1440x900 内要么压扁这一对、要么把片段压成两行。判据改成「输入、输出与两个按钮必须在首屏内」，片段可落到折线以下；接入信息页仍是零滚动 |
| 浅色档输入框底 `--bg-input`（#ffffff） | 已改画板 | 画板原先画成 `#f1f5f9`，与仓库真实 token 不符——改画板对齐实现，而不是让实现偏离全站输入框 |
