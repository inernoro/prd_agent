---
name: llm-visibility
description: LLM 交互过程可视化审计。扫描代码中所有 LLM 调用点，检查是否符合「禁止空白等待」原则，生成合规报告并提供修复建议。触发词："可视化审计"、"llm visibility"、"/visibility"。
---

# LLM Visibility — 交互过程可视化审计与组件指南

确保所有涉及 LLM 调用的功能向用户展示交互过程，禁止静止等待超过 2 秒。

## 触发词

- "可视化审计"
- "llm visibility"
- "/visibility"
- "检查等待体验"

## 核心原则

> 用户在等待 AI 响应时，屏幕上必须有持续变化的内容。静止的"加载中…"超过 2 秒即为体验缺陷。

### 五项强制要求

| # | 要求 | 说明 |
|---|------|------|
| 1 | **流式输出** | LLM 响应必须使用 SSE 流式推送，前端逐字/逐块渲染（打字效果） |
| 2 | **进度反馈** | 批量 LLM 任务必须推送进度事件（如"正在分析第 3/45 个缺陷…"） |
| 3 | **思考过程** | 如果 LLM 支持 thinking，应展示思考过程 |
| 4 | **阶段提示** | 长任务拆分阶段，每个阶段开始时推送状态（准备中 → 分析中 → 生成中 → 完成） |
| 5 | **兜底方案** | 如无法流式输出，至少显示动画加载状态 + 预估耗时提示 |

## 基础组件库

### 已有组件

| 组件 | 路径 | 用途 |
|------|------|------|
| `useSseStream` | `prd-admin/src/lib/useSseStream.ts` | 通用 SSE 流式 hook（连接管理、认证、状态追踪） |
| `SsePhaseBar` | `prd-admin/src/components/sse/SsePhaseBar.tsx` | 阶段状态栏（连接中/分析中/完成/失败） |
| `SseTypingBlock` | `prd-admin/src/components/sse/SseTypingBlock.tsx` | LLM 打字效果区块（原始流式输出展示） |
| `SseStreamPanel` | `prd-admin/src/components/sse/SseStreamPanel.tsx` | 组合面板（PhaseBar + TypingBlock + 业务内容） |
| `readSseStream` | `prd-admin/src/lib/sse.ts` | 底层 SSE 解析函数（所有组件的基础） |

### 后端 SSE 事件协议

所有 LLM 流式端点应遵循统一事件协议：

```
event: phase
data: { "phase": "preparing", "message": "准备评分 45 个缺陷…" }

event: typing
data: { "text": "根据缺陷描述分析" }

event: item
data: { "id": "xxx", "score": 8, "reason": "..." }

event: done
data: { "total": 45, "message": "评分完成" }

event: error
data: { "message": "AI 评分出错" }
```

## 审计流程

当触发此技能时，按以下步骤执行：

### Step 1: 扫描 LLM 调用点

搜索后端代码中所有 `_gateway.SendAsync` 和 `_gateway.StreamAsync` 调用：

```bash
# 非流式调用（潜在违规点）
grep -rn "SendAsync\|\.SendAsync" prd-api/src/ --include="*.cs"

# 流式调用（已合规）
grep -rn "StreamAsync\|\.StreamAsync" prd-api/src/ --include="*.cs"
```

### Step 2: 分类每个调用点

对每个调用点判断：

| 类型 | 判定条件 | 合规性 |
|------|----------|--------|
| **用户触发的同步调用** | 用户点击按钮后等待结果 | ❌ 必须改为流式 |
| **用户触发的流式调用** | 已用 SSE 推送中间结果 | ✅ 合规 |
| **后台异步调用** | Worker/定时任务，用户不等待 | ✅ 豁免 |
| **极快调用（<2s）** | Intent 检测、短文本分类等 | ⚠️ 建议加 loading 动画 |

### Step 3: 检查前端消费方

对每个流式端点，检查前端是否使用了合规组件：

```bash
# 检查是否使用了 useSseStream 或 readSseStream
grep -rn "useSseStream\|readSseStream" prd-admin/src/ --include="*.tsx"

# 检查是否有裸 fetch + 手动解析（建议迁移到 useSseStream）
grep -rn "text/event-stream" prd-admin/src/ --include="*.tsx"
```

### Step 4: 生成合规报告

输出表格格式：

```
| 调用点 | 文件:行 | 类型 | 前端展示 | 合规 | 建议 |
|--------|---------|------|----------|------|------|
| 缺陷评分 | DefectAgentController:2450 | 流式 | SseStreamPanel | ✅ | - |
| 提示词优化 | PromptsController:120 | 流式 | 自定义 Dialog | ⚠️ | 迁移到 useSseStream |
| 缺陷提取 | DefectAgentAdapter:45 | SendAsync | 无 | ❌ | 改为流式 + SseStreamPanel |
```

## 新功能接入指南

### 后端：添加 SSE 流式端点

```csharp
[HttpGet("xxx/stream")]
[Produces("text/event-stream")]
public async Task StreamXxx(string id, CancellationToken cancellationToken)
{
    Response.ContentType = "text/event-stream";
    Response.Headers.CacheControl = "no-cache";
    Response.Headers.Connection = "keep-alive";

    // 1. 推送阶段
    await WriteSseEventAsync("phase", new { phase = "preparing", message = "准备中…" });

    // 2. 流式调用 LLM
    await foreach (var chunk in _gateway.StreamAsync(request, CancellationToken.None))
    {
        if (chunk.Type == GatewayChunkType.Text)
        {
            // 推送打字效果
            try { await WriteSseEventAsync("typing", new { text = chunk.Content }); }
            catch (ObjectDisposedException) { } // 客户端断开，继续处理
        }
    }

    // 3. 推送结果
    await WriteSseEventAsync("item", result);
    await WriteSseEventAsync("done", new { total = 1 });
}
```

### 前端：使用 useSseStream + SseStreamPanel

```tsx
import { useSseStream } from '@/lib/useSseStream';
import { SseStreamPanel } from '@/components/sse';

function MyPanel() {
  const [items, setItems] = useState([]);

  const sse = useSseStream<MyItem>({
    url: `/api/xxx/stream`,
    onItem: (item) => setItems((prev) => [...prev, item]),
    onError: (msg) => toast.error(msg),
  });

  return (
    <SseStreamPanel
      phase={sse.phase}
      phaseMessage={sse.phaseMessage}
      typing={sse.typing}
      isDone={sse.isDone}
      hasData={items.length > 0}
    >
      <MyResultTable items={items} />
    </SseStreamPanel>
  );
}
```

## 已合规的模块

| 模块 | 流式端点 | 前端组件 | 展示方式 |
|------|----------|----------|----------|
| AI 对话 | `/sessions/{id}/messages` | AiChatPage | Chat 气泡 + Markdown |
| 工作流对话 | `/workflow/chat` | WorkflowChatPanel | Chat 气泡 + 卡片 |
| 工作流执行 | `/workflow/executions/{id}/stream` | ExecutionDetailPanel | 日志时间线 + LLM 面板 |
| 提示词优化 | `/prompts/optimize/stream` | PromptStagesPage | 左右对比 |
| 模型对战 | `/arena/runs/{id}/stream` | ArenaPage | 并列面板 + TTFT |
| 缺陷 AI 评分 | `/defect-agent/shares/{id}/scores/stream` | SharesListPanel | SseStreamPanel + 评分表 |
| 图片生成 | `/image-gen/runs/{id}/stream` | ImageGenPanel | 进度 + 产物 |

## 反模式（禁止）

```tsx
// ❌ 裸调用 + 空白等待
const res = await fetch('/api/xxx');
setResult(await res.json());

// ❌ 静态加载提示
{loading && <p>加载中...</p>}

// ❌ 只有 spinner，无文字变化
{loading && <Loader2 className="animate-spin" />}
```

## 合规模式（推荐）

```tsx
// ✅ 使用 useSseStream + SseStreamPanel
const sse = useSseStream({ url: '...', onItem: ... });
<SseStreamPanel phase={sse.phase} phaseMessage={sse.phaseMessage} typing={sse.typing} ...>
  <ResultContent />
</SseStreamPanel>

// ✅ 最低限度兜底（极快调用场景）
{loading && (
  <div className="flex items-center gap-2">
    <Loader2 className="animate-spin" />
    <span>AI 正在处理，预计 1-2 秒…</span>
  </div>
)}
```
