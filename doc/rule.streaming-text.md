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
import { StreamingText, MapCursor } from '@/components/streaming';

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

// 自定义 cursor: 'bar' (默认竖条) | 'dot' (圆点) | 任意 ReactNode (SVG/icon)
<StreamingText text={accumulated} streaming cursorContent="dot" />
<StreamingText text={accumulated} streaming cursorContent={<MapCursor size={14} />} />
```

### Cursor 定制

- 默认 `bar` (2px 竖条 + blink), 系统统一基线, 不主动改不动它
- `dot` 预设: 0.55em 圆点, 适合"完成中"语义弱化场景
- 业务需要品牌识别 (如长内容生成) 用 `<MapCursor />` —— MAP 字母 + 发光, 是系统流式 cursor 的官方品牌选项
- 任意 ReactNode 也可: `cursorContent={<Sparkles size={12} />}` 等

---

## 把一次性 AI 端点升级为流式 (Migration 手册)

任意"前端 fetch → 后端 await 完整结果 → 后端返回一次性 content"的 AI 业务, 可以在 ~30 分钟内升级为"流式 SSE + Blur focus 词级动画 + 预览弹窗"的标准体验。流程:

### 后端 (新增 SSE 端点, 保留旧端点向后兼容)

1. **写一个 Service** (照抄 `Services/DefectAgent/DefectPolishService.cs`):
   - 接收业务参数 + `PrReviewModelInfoHolder` + `CancellationToken`
   - 返回 `IAsyncEnumerable<LlmStreamDelta>`
   - 调 `ILlmGateway.StreamAsync(..., CancellationToken.None)` (server-authority)
   - 在 Start chunk 写 holder, Thinking/Text chunk yield delta
2. **注册到 DI** (Program.cs `AddScoped<MyPolishService>()`)
3. **在 `AppCallerRegistry`** 加一条 `Stream` 常量 (kebab-case, 见 `.claude/rules/app-caller-registry.md`)
4. **Controller 加一个端点**, 调用 `AiStreamingHelpers.WriteSseStreamAsync`:

```csharp
[HttpPost("xxx/polish/stream")]
[Produces("text/event-stream")]
public async Task PolishStream([FromBody] PolishRequest req)
{
    using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
        RequestId: Guid.NewGuid().ToString("N"),
        UserId: GetUserId(),
        RequestType: "chat",
        AppCallerCode: AppCallerRegistry.MyAgent.Polish.Stream,
        /* 其它字段 null */));

    await AiStreamingHelpers.WriteSseStreamAsync(
        Response,
        label: "AI 润色",
        streamFactory: holder => _polishService.StreamPolishAsync(req, holder, HttpContext.RequestAborted),
        logger: _logger);
}
```

`AiStreamingHelpers` 已经处理: SSE header / 心跳 phase / model 事件 / thinking 事件 / typing 事件 / done 事件 / error 事件 / writeLock。

### 前端 (替换 fetch 调用为 hook + modal)

1. **删除旧 `polishXxx` 一次性 API 调用**
2. **声明 hook**:

```tsx
const polishStream = useAiPreviewStream({
  url: '/api/xxx/polish/stream',
  onApply: (final) => setOriginalText(final),
});
```

3. **触发按钮直接调 start()**:

```tsx
<button onClick={() => polishStream.start({ ...bodyFields })} disabled={polishStream.open}>
  AI 润色
</button>
```

4. **挂载 modal 一次**:

```tsx
<AiPreviewModal
  open={polishStream.open}
  text={polishStream.text}
  thinking={polishStream.thinking}
  streaming={polishStream.streaming}
  phaseMessage={polishStream.phaseMessage}
  error={polishStream.error}
  model={polishStream.model}
  title="AI 润色预览"
  subtitle="点击应用替换原文"
  onApply={polishStream.apply}
  onRegenerate={() => polishStream.regenerate()}
  onCancel={polishStream.cancel}
/>
```

### 旧端点的向后兼容

旧 `POST /xxx/polish` 一次性端点**保留 6 个月**（PR 描述里注明 deprecate 日期）。理由:
- 外部 Agent 可能在调用 (无法及时迁移)
- 自动化测试可能依赖

6 个月后 (本规则首次发布日 +6 个月) 由发布版本统一删旧端点。

### 参考实现 (已落地)

- `DefectAgentController.PolishDefectStream` + `DefectPolishService` (新版)
- `ReportAgentController.PolishDailyLogItem` (老版手写 SSE, 后续 P5 收编到 helper)
- `DailyLogPolishPopover` (已收编, 从 234 行降到 65 行的薄壳)

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
