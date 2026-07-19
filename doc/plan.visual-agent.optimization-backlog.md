# 视觉创作 优化清单 · 计划

> **版本**：v1.0 | **日期**：2026-07-19 | **状态**：规划中

## 管理摘要

- **解决什么问题**：BrandAI 迁移过程中对视觉创作做了两轮共 7 个子智能体的逐行考古（约 98 项功能规格），顺带暴露出源实现的一批陈年问题与可优化点。本清单把它们固化为可逐项执行的 backlog，避免「看见一个修一个」。
- **方案概述**：按 缺陷修复 / 体验优化 / 功能增强 / 工程健康 四类排列，每项带根因锚点与建议做法；多项可直接移植 BrandAI 已验证的实现。
- **业务价值**：视觉创作更稳、更顺手；未来第 N 次迁移时按 design.visual-agent.canvas-composer.md + 本清单直接开工。
- **影响范围**：prd-admin 视觉创作前端为主，少量 prd-api。
- **主要风险**：逐项独立、可分批合入；仅「展示层分离」涉及消息落库口径需回归。

## 〇、根因分析：为什么视觉创作「迁移也难、修复也难」（2026-07-19 复盘，SSOT）

用户三次反馈同一族问题（多图生图反复失败 / 重试后消息内容变异 / 展示层残渣），逐层排查后收敛为三个结构性根因——单点补丁治不住，必须按下面的口径成套治：

1. **双层文本没有物理分离（头号根因）**。消息实体只有一个 `content` 字符串，同时承担「用户可见文本」与「模型请求文本」：`@imgN` 标记、`【引用图片】`文字块、`(@size)(@model)` meta token 全部混排在同一字段里。任何显示/重试/复制功能都只能靠正则清洗还原，清洗规则每挪一寸就冒一个新 bug（气泡残留 `)`、引用行误杀、块头漏剥……）。**铁律：display 层与模型层各自独立字段/独立数据；新功能禁止再从 content 正则提取语义。** 终局方案是消息实体结构化（displayText + refs[] 落库，content 仅作兼容渲染），即上表 #2。
2. **重试/复制以「渲染文本」为源重建请求**。GEN_DONE/GEN_ERROR 元数据里的 `prompt` 曾优先存模型层 reqText（含引用块）甚至英文澄清稿——「重试」把它当新输入回炉，buildRequestText 再叠一层引用块，每重试一次气泡变异一次（2026-07-19 用户截图）。已修：`displayPrompt` 一律取 display 原文（reqText 兜底先过 parseVisualMessageDisplay 清洗），澄清稿只进模型层；「复制消息」走 chipTokenText 的 `[@image:#N:key:src]` token（结构化往返，粘回即还原 chip）。
3. **stub 环境缺 vision 出图闭环**。stub-vision 的 chat/completions 只回文本（`vision_ok=true text=...`），多图生图在 dev/灰度（模型池=stub）必然「生成完成但无图片数据」——真实的解析修复无法在灰度自证，同一错误画面反复出现，误导「是不是没修/修错项目」。已修：stub vision 非流式响应补 `message.images[]`（OpenRouter 形态，优先取请求内联图为底 + 提示词水印），dev/灰度自此有完整多图生图 E2E。
4. **迁移为何七轮返工**（工程侧根因）：源实现 9400 行单文件 + 上述双层文本耦合，任何「凭印象复刻」都必踩暗层语义；已立规「迁移前先出穷举清单」（上表 #14）。

## 一、缺陷修复（P0-P1）

| # | 问题 | 根因锚点 | 建议 |
|---|---|---|---|
| 1 | 多图生图报「Vision API 响应格式不支持」 | OpenAIImageClient.cs:1506+ 多图走 chat/completions Vision 分支，解析只认 message.content 字符串 | 本分支已修（VisionChatCompletionImageExtractor + 20 例 xunit，分支 claude/visual-creation-migration-5wrsz9 提交 93b7322）；需建 PR 让 ci.yml 跑测试后合入 |
| 2 | 用户可见消息混入文件名/引用块 | imageRefResolver.ts:169 buildRequestText 把「【引用图片（按顺序）】- @imgN: 文件名」拼进 prompt，display || reqText 回退落库为用户消息 | 移植 BrandAI 的展示层/模型层物理分离：可见文本只存用户原文 + chip 位置标记，模型层用 [图N]；两侧独立字段 |
| 3 | 右上角本页教程 pill 遮挡对话面板头部 | VisualAgentFullscreenPage.tsx 编辑器分支 fixed top-5 right-5 z-50 压住 420px 浮动面板（right-3 top-3 z-30） | 本轮已修：桌面端左移 md:right-[436px]，移动端不变 |
| 4 | 画布保存 last-writer-wins 丢更新 | 客户端 PUT 整份 payload 无版本比对（ImageMasterController SaveWorkspaceCanvas 已知取舍）；1200ms 防抖窗口内刷新时在途 PUT 迟到，被新页面加载态保存覆盖 | 移植 BrandAI 修法：fetch keepalive:true + pagehide/beforeunload flush 未触发的防抖保存（BrandAI 灰度实测踩中并修复） |
| 5 | 元素 onClick 选择路径为死代码 | AdvancedVisualAgentTab.tsx:6165-6219 onClick 因 pointerdown 内 preventDefault 永不触发，仅注释说明保留 | 删除或改为注释常量，降低双路径漂移风险（曾在迁移中造成语义误读） |

## 二、体验优化（P1-P2）

| # | 优化 | 现状 | 建议 |
|---|---|---|---|
| 6 | chip 复制粘贴文本 token 化 | 已落地（2026-07-19，分支 claude/visual-creation-migration-5wrsz9）：`lib/chipTokenText.ts` 纯函数 + `RichComposer/index.tsx` 注册 COPY/CUT/PASTE 命令，7 例 vitest | 复制/剪切得 [@image:#N:canvasKey:src] 混合文本；粘贴时 canvasKey 命中当前 imageOptions 才还原就绪 chip（refId/src 以当前集合为准），未命中保持纯文本防幻觉引用 |
| 7 | 工具菜单 V/H 快捷键假提示 | 工具切换菜单显示 V/H 快捷键角标但代码未绑定按键（7402-7519） | 绑定 V=Select、H=Hand（画布聚焦且非输入控件时），或删掉角标不做假暗示 |
| 8 | 上传上限与画布 60 项上限无前置提示 | 超 20 张截断、画布 merged.slice(-60) 静默丢最旧 | 触顶时 toast 明示（对齐「预期管理」规则） |
| 9 | 单文件 9400 行维护性 | AdvancedVisualAgentTab.tsx 承载画布+输入+生命周期全部逻辑 | 按 design.visual-agent.canvas-composer.md 四层拆文件；行为不变，仅重排 |

## 三、功能增强（P2，从 BrandAI 迁移反向汲取）

| # | 增强 | 说明 |
|---|---|---|
| 10 | 对话出图 promptMode=direct 概念 | BrandAI 侧品牌模板曾把 11 字指令稀释成约 3000 字 prompt（文不对题）。视觉创作虽无品牌折叠，但 buildRequestText 的引用块/风格附加同样有稀释面——建议给「纯指令模式」开关，prompt 即用户原文+图引用 |
| 11 | 同图多引用显式化 | 现两阶段 replace 语义下同图重复引用可行但不显式；对齐 token 模型后可在句中多处引用同一张图（[图1] 拿着 [图1]） |
| 12 | 画布持久化对账可视化 | reconcile/watchdog 修复占位是静默的；给一个「已从服务端恢复 N 个卡死占位」的轻提示，减少「图怎么自己变了」的惊讶 |

## 四、工程健康

| # | 项 | 说明 |
|---|---|---|
| 13 | 原理文档随代码更新 | design.visual-agent.canvas-composer.md 是 2026-07 快照；大改 AdvancedVisualAgentTab 时同步更新，PR 模板勾选 |
| 14 | 迁移前先出清单 | 任何跨项目迁移先跑穷举盘点（子智能体并行读码 → 逐项规格清单 → 对照打勾），禁止凭印象复刻——BrandAI 迁移七轮返工的直接教训 |

## 关联文档

- doc/design.visual-agent.canvas-composer.md — 视觉创作原理（本清单的锚点来源）
- BrandAI 仓库 docs/13_视觉创作对齐清单.md — 逐项对齐状态（约 98 项）
