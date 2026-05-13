---
type: rule
title: 流式文本动效统一规范
status: active
owner: prd-admin
created: 2026-05-13
---

# 流式文本动效统一规范

> prd-admin 任何 LLM 流式文本输出必须通过 `<StreamingText />` 渲染，禁止再自行实现 typing/光标/markdown 逐 chunk 重渲染。

---

## 来源

设计稿 `Streaming text — 10 patterns` (Claude Design, 2026-05-13)，本规范在系统内统一采用其中的 **Blur focus** 模式作为默认值：每个词在出现时执行 `opacity: 0 → 1` + `filter: blur(7px) → 0` 的 0.55s 过渡。

## 强制规则

1. **唯一入口**：`@/components/streaming` 导出的 `StreamingText` 是 prd-admin 流式文本的唯一渲染组件。新接入禁止：
   - 自己写 `<span class="caret">` 闪烁光标
   - 用 `dangerouslySetInnerHTML` 累积 token
   - 每个 chunk 都 `<ReactMarkdown>{full}</ReactMarkdown>`（reflow blink）
2. **默认 mode = `blur`**：除非有明确视觉需求，不要切换 mode。可选 mode：`blur` / `wordFade` / `rise` / `typewriter`。
3. **markdown 流式策略**：流式期间渲染为纯文本词级动画（避免 markdown reflow），`streaming=false` 时通过 `renderMarkdown` 输出最终 markdown 视图。
4. **无障碍**：基础设施已内置 `prefers-reduced-motion` 响应，业务侧无需处理。
5. **思考块禁裸文本**（批次二新增）：推理模型（DeepSeek/QwQ/r1 等）的 thinking 阶段往往占整个等待时间的 80%+，正文反而 1s 内闪过。**任何 thinking 块的渲染必须走 `<StreamingText>`，禁止直接 `{thinking}` 裸文本**，否则用户感知到的就是"全程没动画"。本规则覆盖：ThinkingBlock 组件、推理日志展示、AI 思考过程 popover 等所有形态。

### 反例 vs 正例

```tsx
// ❌ 裸文本，无动画，推理模型 30-60s 静止
<pre>{thinking}</pre>

// ❌ 自写闪烁光标，没接基础设施
<pre>{thinking}<span className="animate-pulse">|</span></pre>

// ✅ 词级 Blur focus 动画 + 自动光标
<pre><StreamingText text={thinking} streaming={!done} /></pre>
```

## 使用方式

```tsx
import { StreamingText } from '@/components/streaming';

// 纯文本流
<StreamingText text={accumulated} streaming={isStreaming} />

// markdown 流（流式期间纯文本动画，完成后渲染 markdown）
<StreamingText
  text={accumulated}
  streaming={isStreaming}
  markdown
  renderMarkdown={(c) => <MyMarkdown>{c}</MyMarkdown>}
/>

// 强制使用其他 mode
<StreamingText text={accumulated} streaming={isStreaming} mode="wordFade" />
```

## 验证

实验场：`/_dev/streaming-text-lab` —— 4 种 mode 并排对照 + 长文本场景演示。

## 接入清单

- 批次一 (MVP, 已完成):
  - `pages/arena/ArenaPage.tsx` 大模型竞技场实时回答（含 ThinkingBlock）
  - `pages/workflow-agent/WorkflowChatPanel.tsx` 工作流 AI 对话面板
  - `pages/pr-review/SummaryPanel.tsx` PR 摘要面板（含 ThinkingBlock）

- 批次二 (已完成):
  - `pages/pr-review/AlignmentPanel.tsx` PR 对齐度检查（正文 + ThinkingBlock）
  - `pages/report-agent/components/DailyLogPolishPopover.tsx` 日志 AI 润色（正文 + 思考过程）
  - `pages/ai-toolbox/components/ToolDetail.tsx` 百宝箱工具对话正文
  - `pages/literary-agent/ArticleIllustrationEditorPage.tsx` 文学创作图文配图 思考过程
  - `pages/ai-toolbox/components/QuickCreateWizard.tsx` 工具快建 AI 引导
  - `components/sse/SseTypingBlock.tsx` 内部委托 StreamingText（保留 tailChars 监控语义）
- 批次二 (中等): AlignmentPanel, WorkflowChatPanel, DailyLogPolishPopover, QuickCreateWizard, SseTypingBlock 内部
- 批次三 (收尾): WeeklyPoster TypingPanel, SseStreamPanel 文档对齐

## 相关

- `prd-admin/src/components/streaming/StreamingText.tsx` 实现
- `prd-admin/src/components/streaming/streaming.css` 动效定义
- CLAUDE.md 规则 #6 「LLM 交互过程可视化」 —— 本规范是其在文本层面的具体落实
