# 视觉创作 画布与对话输入 · 设计

> **版本**：v1.0 | **日期**：2026-07-19 | **状态**：已落地

## 管理摘要

- **解决什么问题**：视觉创作编辑器（AdvancedVisualAgentTab，约 9400 行）承载了画布、两阶段图片引用、富文本混排输入、上传生命周期与服务端持久化等大量隐性设计，此前无文档——每次跨项目迁移（如 BrandAI）都要重新读码考古，成本高且必漏。本文把这些原理固化为唯一事实源。
- **方案概述**：按「画布交互 / 两阶段引用与输入区 / 图片生命周期与持久化 / prompt 组装」四层拆解，每层给出状态机、关键数值与源码行号锚点。
- **业务价值**：后续任何迁移、重构、验收，先读本文再动手；配套的逐项功能清单（约 98 项，含触发方式与行为规格）由并行子智能体盘点产出，见 BrandAI 仓库 docs/13 对齐清单与本仓库优化 backlog。
- **影响范围**：仅文档；不改代码行为。
- **主要风险**：本文是快照（对应 2026-07 代码）；后续大改需同步更新，否则回到考古状态。

## 一、画布交互层

核心档案：prd-admin/src/pages/ai-chat/AdvancedVisualAgentTab.tsx。

- **选择模型**：单击图片 = 替换选中 + 自动分配 refId + 向输入框插入灰色待选 chip（6089-6164、4904-4915）；Shift/Ctrl/Cmd = 追加多选（多选序号角标 6604-6635）；空白拖拽 = 框选（5867-5927）；点空白/Esc = 清选中并清待选 chip（5871-5878）。shape/text/generator 只选中不插 chip。
- **手势**：遵守 .claude/rules/gesture-unification.md 标准 A——两指滑动平移、捏合或 Ctrl/Cmd+滚轮以指针为锚缩放（曲线 exp(-deltaY*0.003)，单次 clamp [0.93,1.07]，总量 [0.05,3]）；Space 临时手型；触屏双指捏合独占手势（3546-3642）。高频路径走 ref+rAF 直改 transform，不 setState。
- **变换**：拖拽死区桌面 3px/移动 10px；resize 仅单选、图片锁比例（Shift 解锁）、锁比例缩小需在对角线 25 度锥形内防手抖（1841-1966）；方向键 1px/Shift 10px 微调。
- **图层与删除**：数组顺序即 z 序（canvasLayerUtils）；Cmd+]/[/Shift 变体四操作 + 右键菜单同项；删除带危险确认弹窗、乐观移除 + 失败回滚（2443-2482）。
- **视图**：顶部悬浮条（缩放/适配/100%/自动排列 arrangeGrid 近方形网格 gap 20）；Shift+0/1/2 视图快捷键。
- **选中可视化**：贴合 object-fit:contain 实图区域（computeObjectFitContainRect）；双描边（外黑 rgba(0,0,0,0.45) 宽 max(2,4/zoom)、内蓝 rgba(96,165,250,0.95) 宽 max(2,2.5/zoom)）；hover 淡蓝边框 rgba(147,197,253,0.55) + 光晕；待选灰罩 rgba(156,163,175,0.25) + 居中对勾。

## 二、两阶段引用与输入区

- **状态机**：无 → 待选（灰 chip + 画布灰罩 + 「待确认 N 张/清除」徽标 + placeholder 变「点击此处确认选择，或继续输入...」）→ 确认（点输入区容器 / 发送 / markChipsReady，chip 转蓝）→ 发送或清除。普通点选 = replace（清其它待选）；修饰键 = 累加；点空白 = clearSelectionWithChips。SSOT 是 TwoPhaseRichComposer 的 pendingChipKeys（TPC:94），单向同步回主组件。
- **输入器**：Lexical RichComposer；chip 是 ImageChipNode（20px 高、14x14 缩略图、13px 标签、灰/蓝两态）；@ 提及（ImageMentionPlugin，@/@img 触发下拉插 chip）；IME 合成期 Enter 不发送；粘贴图片转上传进画布而非输入框。
- **发送**：getStructuredContent 产出 text（chip 序列化为 @imgN）+ imageRefs；sendText 统一守门（500ms 防重）→ resolveImageRefs → buildRequestText → GenJob 队列并发出图。**注意：buildRequestText 会把引用块（【引用图片（按顺序）】- @imgN: 文件名）拼进模型 prompt——展示层与模型层未完全分离，见 backlog。**
- **底栏**：尺寸选择器（分辨率档 + 比例网格 + 自适应）、模型 chip、调色板、设置、队列入口、圆形发送（h-7 w-7）。

## 三、图片生命周期与服务端持久化

- **上传（体感关键）**：统一入口 onUploadImages（按钮/拖放/画布粘贴/输入框粘贴全汇入，4952-5255）：先 compressImageForCanvas 压缩（最长边大于 2560 或大于 8MB 才压）→ FileReader dataURL **立即落画布**（syncStatus:'pending' 波纹角标）→ 后台上传资产 → 回填 assetId/公网 URL → synced；失败标 failed（「未持久化」红角标 + 消息区告警）。单选一张图且只传一张时默认**替换**该图。
- **持久化**：一 workspace 一份画布 JSON（image_master_canvases，PayloadJson V1：image/generator/shape/text 四种元素，字节不入库只存 assetId+URL，上限 200 元素）；1200ms 防抖自动保存 + 拿到 runId 立即落盘 + 服务端直写（占位 upsert / worker 回填，OCC 重试）；恢复时按 assetId 反查最新 URL、对账卡死占位（reconcile + 15s watchdog）。视口按用户存 workspace（viewportByUserId）。详见本文档撰写前的两轮子智能体调研（BrandAI 会话存档）。
- **贴图操作**：单选图片上方 ImageQuickActionBar（世界坐标跟随 + scale(var(--invZoom))）、下方 ImageQuickEditInput 快捷编辑；右键菜单承载下载/复制/预览/导出/图层。

## 四、prompt 组装

sendText → resolveImageRefs（chipRefs/选中/inline 图统一解析）→ buildRequestText 组装最终请求文本（imageRefResolver.ts:169）。用户不打字时有 display || reqText 回退——**曾导致文件名/引用块落进用户可见消息（BrandAI 迁移时以「展示层/模型层物理分离」规避，本仓库该隐患仍在**，见 backlog）。

## 关联文档

- .claude/rules/gesture-unification.md — 手势统一标准（标准 A 参考实现即本页）
- doc/plan.visual-agent.optimization-backlog.md — 本次考古沉淀的优化清单
- BrandAI 仓库 docs/12、docs/13 — 迁移计划与逐项对齐清单（约 98 项规格）

## 风险

- 文档为 2026-07 快照；AdvancedVisualAgentTab 大改后需同步，否则失效。
