# 工作流引擎 v2：流程控制舱 + SSE 实时推送 设计文档

> **文档版本**: v1.0
> **创建日期**: 2026-02-15
> **基于**: `design.workflow-engine.md` v1.0
> **状态**: 已实现
> **appKey**: `workflow-agent`

---

## 1. 设计思想

### 1.1 为什么需要流程控制

v1.0 的工作流引擎只有「触发 → 处理 → 输出」三类节点，所有节点按拓扑序**无条件串行**推进。这意味着：

- 无法根据数据内容决定走哪个分支（例如「有数据 → 生成报告」vs「无数据 → 发告警」）
- 无法在节点之间插入等待（例如等待外部系统同步完成）
- DAG 退化为线性管道，无法表达分叉/汇合等复杂拓扑

引入**流程控制类舱**，使工作流引擎从「管道」进化为「DAG + 条件分支」，支持真正的自动化决策。

### 1.2 为什么需要 SSE 实时推送

v1.0 前端通过**轮询**获取执行状态（每 2.5 秒调一次 GET /executions/{id}）。用户体验上的问题：

1. **感知延迟**：节点完成到前端显示有 0~2.5 秒的随机延迟
2. **状态跳变**：如果多个快节点在一个轮询窗口内完成，用户看到的是「瞬间全部完成」而非逐个推进
3. **资源浪费**：即使没有状态变化也持续请求后端

SSE（Server-Sent Events）解决了这三个问题：
- **即时推送**：节点状态变化后 < 400ms 即到达前端
- **逐步可见**：每个节点的 started → completed 独立推送，用户能看到逐节点推进
- **按需通信**：无事件时仅发送 keepalive 注释，不产生业务请求

### 1.3 为什么选择 SSE 而非 WebSocket

| 维度 | SSE | WebSocket |
|------|-----|-----------|
| 方向 | 单向（服务端→客户端）| 双向 |
| 协议 | 标准 HTTP | 升级协议 ws:// |
| 认证 | Bearer Token（自定义 fetch） | 需要在握手阶段传递 |
| 断线重连 | 内置 `Last-Event-ID` 自动续传 | 需自行实现 |
| 复杂度 | 低 | 高 |

工作流执行状态推送是纯单向场景（服务端→客户端），SSE 是最佳选择。本项目通过 `fetch` + `readSseStream`（而非原生 `EventSource`）实现，以支持 `Authorization` 头。

---

## 2. 用户故事

### US-1：延时控制

> 作为工作流编排者，我希望在两个节点之间插入一个等待步骤，以便外部系统有足够时间完成数据同步，再继续后续处理。

**验收标准**：
- 配置 `seconds: 3` → 流水线在此节点暂停 3 秒后继续
- 上游数据**透传**到下游（延时舱不修改数据）
- 前端实时显示「执行中」状态 3 秒

### US-2：条件分支

> 作为工作流编排者，我希望根据上游数据的某个字段值决定走「处理分支」还是「告警分支」，而不是两个分支都执行。

**验收标准**：
- 配置 `field: "0.name", operator: "not-empty"` → 如果数据中第一条记录的 name 字段非空则走 TRUE
- TRUE 分支连接到格式转换节点，FALSE 分支连接到通知节点
- 未激活的分支所有下游节点显示为「已跳过」
- 条件求值结果（TRUE / FALSE）记录在节点日志中

### US-3：实时状态推送

> 作为运营人员，我希望点击「执行」后能看到节点逐个点亮、逐个完成，而不是等很久后一次性全部亮起。

**验收标准**：
- 点击执行后，前端通过 SSE 流实时接收事件
- 每个节点 `running → completed / failed` 的状态变化在 < 1 秒内显示
- 如果 SSE 连接失败，自动回退到 2 秒间隔轮询

### US-4：可测试 Demo 流水线

> 作为新用户，我希望有一个开箱即用的 Demo 流水线，无需配置任何凭证就能体验完整的「数据获取 → 条件分支 → 格式转换」流程。

**验收标准**：
- 使用 `jsonplaceholder.typicode.com` 公共 API，无需任何密钥
- 5 个节点覆盖：HTTP 请求、延时、条件判断、格式转换、站内通知
- 点击一次即可运行，实时观察节点逐步推进

---

## 3. 架构设计

### 3.1 新增舱分类：流程控制（Control）

原有三分类扩展为四分类：

```
┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐
│ Trigger  │ → │Processor│ → │ Control │ → │ Output  │
│ (触发)   │   │ (处理)   │   │(流程控制)│   │ (输出)   │
│ ⚡       │   │ ⚙️       │   │ 🔀       │   │ 📤       │
└─────────┘   └─────────┘   └─────────┘   └─────────┘
```

| 舱类型 | typeKey | 分类 | 功能 |
|--------|---------|------|------|
| 延时 | `delay` | control | 等待 N 秒后继续，透传数据 |
| 条件判断 | `condition` | control | if/else 分支路由 |

### 3.2 条件舱的 Slot 路由机制

条件舱是整个设计的核心创新点。它通过 **输出 SlotId** 控制分支路由：

```
输入数据 ──→ [条件判断舱]
              │ 求值: field="status" operator="==" value="ok"
              │
              ├── SlotId="cond-true"  ──→ [格式转换] ──→ [文件导出]
              │   (条件成立)
              │
              └── SlotId="cond-false" ──→ [通知发送]
                  (条件不成立)
```

**关键原理**：

1. 条件舱执行后，**只输出一个 Artifact**，其 `SlotId` 为 `cond-true` 或 `cond-false`
2. DAG 引擎检查每条出边的 `SourceSlotId` 是否在「活跃 SlotId 集合」中
3. 匹配的边 → 激活下游节点（减少入度）
4. 不匹配的边 → 递归标记下游为 `skipped`

这与 WorkflowEdge 的数据模型天然契合：

```
WorkflowEdge {
  sourceNodeId: "n3",       // 条件舱
  sourceSlotId: "cond-true", // ← 匹配条件舱的输出 slot
  targetNodeId: "n4",       // 格式转换（TRUE 分支）
  targetSlotId: "n4-in",
}
```

### 3.3 SSE 事件流架构

```
┌──────────────────┐     ┌──────────────┐     ┌───────────────┐
│ WorkflowRunWorker │ ──→ │ IRunEventStore│ ──→ │  SSE Endpoint │
│ (后台执行器)       │     │  (Redis)     │     │  (Controller) │
│                    │     │              │     │               │
│ EmitEventAsync()  │     │ AppendEvent  │     │ GetEventsAsync│
│  → node-started   │     │ (TTL=30min)  │     │ → 400ms 轮询  │
│  → node-completed │     │              │     │ → flush SSE   │
│  → execution-done │     │              │     │               │
└──────────────────┘     └──────────────┘     └───────┬───────┘
                                                       │
                                                       │ text/event-stream
                                                       ▼
                                              ┌───────────────┐
                                              │   前端 React    │
                                              │ fetch + readSse│
                                              │ handleSseEvent │
                                              │ → setLatestExec│
                                              └───────────────┘
```

**事件类型**：

| 事件名 | 触发时机 | Payload |
|--------|---------|---------|
| `execution-started` | 执行开始 | `{ executionId, status, totalNodes }` |
| `node-started` | 节点开始执行 | `{ nodeId, nodeName, nodeType, attemptCount }` |
| `node-completed` | 节点执行完成 | `{ nodeId, nodeName, nodeType, durationMs, artifactCount }` |
| `node-failed` | 节点执行失败 | `{ nodeId, nodeName, nodeType, errorMessage, durationMs }` |
| `execution-completed` | 全部执行完成 | `{ executionId, status, durationMs, completedNodes, failedNodes, skippedNodes }` |

### 3.4 Demo 流水线拓扑

```
🌐 HTTP Request (jsonplaceholder.typicode.com/users)
        │
        ▼
   ⏳ Delay (3s)
        │
        ▼
   🔀 Condition (0.name not-empty?)
      ├── TRUE ──→ 🔄 FormatConverter (JSON → CSV)
      │
      └── FALSE ──→ 🔔 NotificationSender (空数据告警)
```

5 个节点、4 条边。条件舱的出边分别连接 `cond-true` 和 `cond-false` 两个 SlotId。

---

## 4. 实现细节

### 4.1 延时舱 (delay)

**文件**: `prd-api/src/PrdAgent.Api/Services/CapsuleExecutor.cs` → `ExecuteDelayAsync`

```
配置:
  seconds: number (1~300, 默认 3)
  message: string (可选，等待提示)

行为:
  1. Clamp seconds 到 [1, 300]
  2. Task.Delay(seconds, CancellationToken.None)  ← 服务器权威性
  3. 透传上游 inputArtifacts 的内容
  4. 输出 artifact SlotId = 节点的第一个 OutputSlot
```

**设计决策**：延时舱使用 `CancellationToken.None`，遵循服务器权威性原则 —— 客户端断线不应中断服务端等待。

### 4.2 条件判断舱 (condition)

**文件**: `prd-api/src/PrdAgent.Api/Services/CapsuleExecutor.cs` → `ExecuteCondition`

```
配置:
  field: string    — 判断字段路径（支持 . 嵌套，如 data.count）
  operator: string — 运算符 (==, !=, >, >=, <, <=, contains, empty, not-empty)
  value: string    — 比较值（empty/not-empty 时可留空）

行为:
  1. 从 inputArtifacts 提取第一个有内容的产物文本
  2. JSON.parse → 按 field.split('.') 逐级访问
  3. EvaluateCondition(fieldValue, operator, compareValue)
  4. 如果 result=true → 输出 Artifact.SlotId = "cond-true"
     如果 result=false → 输出 Artifact.SlotId = "cond-false"
  5. 输入数据原样透传到激活分支

求值规则:
  empty     → string.IsNullOrWhiteSpace(fieldValue)
  not-empty → !string.IsNullOrWhiteSpace(fieldValue)
  ==        → 忽略大小写相等
  !=        → 忽略大小写不等
  contains  → 忽略大小写包含
  > >= < <= → double.TryParse 后数值比较
```

### 4.3 DAG 引擎中的条件分支处理

**文件**: `prd-api/src/PrdAgent.Api/Services/WorkflowRunWorker.cs` → `ProcessExecutionAsync` line 237-264

当 BFS 推进到条件舱且执行成功后，不使用标准的「激活所有下游」逻辑，而是：

```csharp
if (nodeDef.NodeType == CapsuleTypes.Condition)
{
    // 1. 条件舱的输出 Artifact 携带 SlotId (cond-true 或 cond-false)
    var activeSlotIds = nodeExec.OutputArtifacts.Select(a => a.SlotId).ToHashSet();

    // 2. 遍历条件舱的所有出边
    foreach (var edge in outEdges)
    {
        if (activeSlotIds.Contains(edge.SourceSlotId))
        {
            // 激活的分支：标准入度递减 → 就绪则入队
            inDegree[childId]--;
            if (inDegree[childId] <= 0) ready.Enqueue(childId);
        }
        else
        {
            // 未激活的分支：递归标记所有下游为 skipped
            SkipDownstream(childId, downstream, nodeExecutions);
        }
    }
}
else
{
    // 普通节点：激活所有下游
    foreach (var childId in children) { ... }
}
```

**SkipDownstream 算法**：BFS 遍历未激活分支的所有可达节点，将 `status=pending` 的节点标记为 `skipped`，并设置 `errorMessage = "上游节点失败，已跳过"`。

### 4.4 SSE 后端实现

**文件**: `prd-api/src/PrdAgent.Api/Controllers/Api/WorkflowAgentController.cs` → `StreamExecution`

```
端点: GET /api/workflow-agent/executions/{executionId}/stream?afterSeq=0
Content-Type: text/event-stream
认证: Bearer Token

行为:
  1. 设置 SSE 响应头 (text/event-stream, no-cache, keep-alive)
  2. 支持 Last-Event-ID 头 → afterSeq 断线续传
  3. 循环:
     a. 每 10 秒发送 `: keepalive\n\n` 注释
     b. 从 IRunEventStore 批量获取 afterSeq 之后的事件
     c. 逐条写出 SSE 格式: id: {seq}\nevent: {name}\ndata: {json}\n\n
     d. 收到 execution-completed 事件后关闭流
  4. 无事件时每 400ms 轮询一次 EventStore
```

**事件存储**: 复用 `IRunEventStore.AppendEventAsync`，kind 为 `"workflow"`，TTL 30 分钟。

### 4.5 SSE 前端实现

**文件**: `prd-admin/src/pages/workflow-agent/WorkflowAgentPage.tsx` → `startSse` / `handleSseEvent`

```typescript
// 不使用原生 EventSource（不支持自定义 Auth 头），改用 fetch + readSseStream
const res = await fetch(url, {
  headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
  signal: ac.signal,
});
await readSseStream(res, (evt) => {
  handleSseEvent(evt.event, JSON.parse(evt.data), execId);
}, ac.signal);
```

**事件处理**：

| 事件 | 前端行为 |
|------|---------|
| `node-started` | 更新节点状态为 `running`，触发进度条动画 |
| `node-completed` | 更新节点状态为 `completed`，拉取该节点的日志和产物 |
| `node-failed` | 更新节点状态为 `failed`，拉取错误详情 |
| `execution-completed` | 标记执行终态，刷新完整数据，关闭 SSE 连接 |

**降级策略**: 如果 `fetch` 返回非 200 或连接异常，自动调用 `fallbackPolling(execId)`，每 2 秒轮询一次 `GET /executions/{id}`。

---

## 5. 文件清单

### 后端修改

| 文件 | 变更 |
|------|------|
| `PrdAgent.Core/Models/WorkflowModels.cs` | `CapsuleTypes` 新增 `Delay` 和 `Condition` 常量 |
| `PrdAgent.Core/Models/CapsuleTypeRegistry.cs` | 新增 `CapsuleCategory.Control`、`Delay` 和 `Condition` 元数据定义（ConfigSchema + Slots） |
| `PrdAgent.Api/Services/CapsuleExecutor.cs` | 新增 `ExecuteDelayAsync`、`ExecuteCondition`、`EvaluateCondition`、`EvaluateNumericCondition` |
| `PrdAgent.Api/Services/WorkflowRunWorker.cs` | 注入 `IRunEventStore`；新增 `EmitEventAsync`；条件舱 Slot 路由分支逻辑 |
| `PrdAgent.Api/Controllers/Api/WorkflowAgentController.cs` | 注入 `IRunEventStore`；新增 SSE 流端点 `GET /executions/{id}/stream`；capsule-types API 返回 control 分类 |

### 前端修改

| 文件 | 变更 |
|------|------|
| `prd-admin/src/pages/workflow-agent/capsuleRegistry.tsx` | 新增 `control` 分类；注册 `delay`、`condition` 舱类型；更新 Icon/Emoji 映射 |
| `prd-admin/src/pages/workflow-agent/WorkflowAgentPage.tsx` | 替换 TAPD 模板为可测试 Demo；SSE 实时推送替代轮询；降级轮询策略 |
| `prd-admin/src/services/api.ts` | 新增 `stream` 端点 URL 生成函数 |

---

## 6. 数据模型补充

### 6.1 条件舱的 OutputSlots

条件舱是唯一拥有**两个输出槽**的舱类型：

```json
{
  "outputSlots": [
    { "slotId": "cond-true",  "name": "true",  "dataType": "json", "description": "条件成立时输出" },
    { "slotId": "cond-false", "name": "false", "dataType": "json", "description": "条件不成立时输出" }
  ]
}
```

### 6.2 延时舱的配置

```json
{
  "config": {
    "seconds": "3",               // 等待秒数 (1~300)
    "message": "等待数据同步…"      // 可选提示
  }
}
```

### 6.3 条件舱的配置

```json
{
  "config": {
    "field": "0.name",            // 支持嵌套: data.items.0.status
    "operator": "not-empty",       // ==, !=, >, >=, <, <=, contains, empty, not-empty
    "value": ""                    // empty/not-empty 时可留空
  }
}
```

### 6.4 SSE 事件存储

复用现有 `IRunEventStore` 接口，使用 `kind = "workflow"` 区分：

```
EventStore key pattern: workflow:{executionId}
TTL: 30 分钟
Sequence: 递增整数（用于断线续传）
```

---

## 7. 扩展指南

### 7.1 新增流程控制舱

如果未来需要新增控制舱（如循环、并行网关、等待事件等），按以下步骤：

**第 1 步：定义常量和元数据**

```csharp
// WorkflowModels.cs
public const string Loop = "loop";

// CapsuleTypeRegistry.cs
public static readonly CapsuleTypeMeta Loop = new()
{
    TypeKey = CapsuleTypes.Loop,
    Name = "循环",
    Category = CapsuleCategory.Control,
    ConfigSchema = new() { /* 循环次数、条件等 */ },
    DefaultInputSlots = new() { /* ... */ },
    DefaultOutputSlots = new() { /* loop-body, loop-done */ },
};
```

**第 2 步：实现执行逻辑**

```csharp
// CapsuleExecutor.cs
CapsuleTypes.Loop => ExecuteLoop(node, inputArtifacts),
```

**第 3 步：如果有特殊路由逻辑，修改 WorkflowRunWorker**

条件舱的路由是 `if (nodeDef.NodeType == CapsuleTypes.Condition)` 特判。如果新舱也需要选择性激活下游，需在 BFS 推进阶段添加对应逻辑。

**第 4 步：前端注册**

```typescript
// capsuleRegistry.tsx
'loop': {
  typeKey: 'loop',
  name: '循环',
  Icon: Repeat,
  emoji: '🔁',
  category: 'control',
  accentHue: 120,
  testable: true,
},
```

### 7.2 新增 SSE 事件类型

在 `WorkflowRunWorker.EmitEventAsync` 调用处添加：

```csharp
await EmitEventAsync(executionId, "my-new-event", new
{
    nodeId,
    customField = "value",
});
```

前端 `handleSseEvent` 中添加对应处理：

```typescript
else if (eventName === 'my-new-event') {
  // 更新 UI 状态
}
```

### 7.3 条件舱运算符扩展

在 `CapsuleExecutor.EvaluateCondition` 的 switch 中添加新运算符：

```csharp
"regex" => fieldValue != null && Regex.IsMatch(fieldValue, compareValue),
"startsWith" => fieldValue?.StartsWith(compareValue, StringComparison.OrdinalIgnoreCase) == true,
```

同时在 `CapsuleTypeRegistry.Condition.ConfigSchema` 的 operator Options 中添加对应选项。

---

## 8. 验证方案

### 8.1 手动验证步骤

1. **进入工作流页面**：确认看到「数据自动化流水线」标题
2. **点击「开始执行」**：
   - 步骤 ① HTTP 请求：状态应从「等待」→「执行中」→「完成」，产物为 JSON 用户列表
   - 步骤 ② 延时等待：状态「执行中」持续约 3 秒
   - 步骤 ③ 条件判断：因 jsonplaceholder 返回非空数据，走 TRUE 分支
   - 步骤 ④ 格式转换：将 JSON 转为 CSV，产物应包含表头行
   - 步骤 ⑤ 空数据通知：显示「已跳过」（因为走了 TRUE 分支）
3. **验证 SSE**：打开 DevTools → Network → 查看 `/stream` 请求，确认收到 `node-started`、`node-completed`、`execution-completed` 事件
4. **验证降级**：在 DevTools 中阻断 `/stream` 端点，确认 2 秒后自动切换到轮询

### 8.2 边界场景

| 场景 | 预期行为 |
|------|---------|
| API 返回空数组 `[]` | 条件判断走 FALSE 分支，通知舱执行 |
| 延时配置 0 秒 | 自动 Clamp 到 1 秒 |
| 延时配置 999 秒 | 自动 Clamp 到 300 秒 |
| 条件字段路径不存在 | fieldValue = null，empty 运算符返回 true |
| JSON 解析失败 | fieldValue = null，not-empty 返回 false |
| SSE 连接中途断开 | 前端自动回退到 fallbackPolling |
| 客户端关闭页面 | 服务端继续执行完成（服务器权威性） |

---

## 9. 与 v1.0 设计的关系

本文档是 `design.workflow-engine.md` v1.0 的**增量扩展**，不替换原有设计。

| 维度 | v1.0 设计 | v2.0 新增 |
|------|----------|----------|
| 舱分类 | 触发、处理、输出 | + 流程控制 |
| DAG 推进 | 无条件串行 | + 条件分支路由 |
| 前端状态 | 轮询 | SSE + 降级轮询 |
| Demo | TAPD 依赖外部凭证 | 公共 API 零配置 |
| 事件推送 | 未实现 | IRunEventStore + SSE endpoint |

---

## 10. 术语表

| 术语 | 含义 |
|------|------|
| **舱 (Capsule)** | 工作流的最小处理单元，等同于节点 (Node) |
| **SlotId** | 输入/输出插槽的唯一标识，用于精确连线和路由 |
| **条件路由** | 条件舱根据求值结果选择性激活下游分支的机制 |
| **SkipDownstream** | 递归标记未激活分支的所有可达节点为 `skipped` 状态 |
| **SSE (Server-Sent Events)** | HTTP 标准的服务端推送协议，单向流式文本事件 |
| **afterSeq** | SSE 断线续传的序列号，支持 `Last-Event-ID` 重连 |
| **服务器权威性** | 核心处理使用 `CancellationToken.None`，不受客户端断连影响 |
| **降级轮询 (fallbackPolling)** | SSE 不可用时自动切换到 2 秒间隔的 REST 轮询 |
