# 简化工作流创建 — 实现计划

## 需求概述

当前工作流创建页面需要手动拖拽舱、配置参数，门槛较高。目标：

1. **右侧聊天窗口**：在工作流编辑页右侧增加 AI 对话面板，用户"说话就能配置工作流"
2. **内部创建接口 + Skill 集成**：新增后端 API，让 AI 能程序化创建/修改工作流；同时集成 Skill，使大模型能解析 Python 代码并转换为工作流配置

## 核心用户场景

以 TAPD 数据抓取为例（`chenJiaYing11/tapd` Python 仓库）：
1. 用户在聊天窗口说："帮我把这段 Python 代码转成工作流，它通过 Cookie 认证抓取 TAPD 缺陷数据"
2. AI 分析代码：识别出 3 步流水线 → Cookie 认证 HTTP 请求 → 数据提取 → Excel 导出
3. AI 调用内部 API 自动创建工作流：ManualTrigger → HttpRequest(TAPD搜索) → HttpRequest(缺陷详情) → DataExtractor → FormatConverter(CSV)
4. 用户在编辑页看到已生成的工作流，可微调
5. 执行失败时，AI 分析错误日志，自动建议调整配置

---

## 阶段一：后端 — 内部工作流创建/修改 API

### 1.1 新增端点

在 `WorkflowAgentController.cs` 中新增以下端点：

```
POST /api/workflow-agent/workflows/from-chat
```

**请求体：**
```json
{
  "workflowId": "可选，为空则创建新工作流",
  "instruction": "用户的自然语言指令",
  "codeSnippet": "可选，Python/JS 等代码片段",
  "codeUrl": "可选，GitHub URL",
  "currentNodes": "可选，当前工作流节点（用于修改场景）"
}
```

**处理逻辑：**
1. 构造 System Prompt，包含：
   - 所有可用舱类型的 Schema（从 `CapsuleTypeRegistry.All` 动态生成）
   - 当前工作流状态（如有）
   - 输出格式约定（JSON schema for nodes + edges + variables）
2. 通过 `ILlmGateway` 调用 LLM（AppCallerCode: `workflow-agent.chat::chat`）
3. 解析 LLM 返回的 JSON，校验舱类型合法性
4. 创建或更新工作流
5. SSE 流式返回对话内容 + 最终工作流 JSON

**响应（SSE 流）：**
```
event: message
data: {"type":"thinking","content":"分析代码结构..."}

event: message
data: {"type":"thinking","content":"识别到 3 个步骤：Cookie 认证、缺陷搜索、数据提取"}

event: message
data: {"type":"workflow_generated","workflow":{...完整 Workflow JSON...}}

event: message
data: {"type":"done","content":"工作流已生成，包含 5 个舱"}
```

### 1.2 错误分析端点

```
POST /api/workflow-agent/executions/{executionId}/analyze
```

**功能：** 将执行失败的日志 + 节点配置发送给 LLM，获取诊断建议和修复方案

**请求体：**
```json
{
  "instruction": "可选，用户补充说明"
}
```

**处理逻辑：**
1. 加载执行详情（失败节点的 logs、errorMessage、config）
2. 构造 LLM prompt：含错误上下文 + 舱配置 Schema
3. LLM 返回：错误原因 + 建议的配置修改（JSON patch）
4. SSE 流式返回分析结果

### 1.3 对话历史

新增 MongoDB 集合 `workflow_chat_messages`：

```csharp
public class WorkflowChatMessage
{
    public string Id { get; set; }
    public string WorkflowId { get; set; }  // 关联的工作流（可为空，表示新建场景）
    public string Role { get; set; }         // "user" | "assistant"
    public string Content { get; set; }      // 消息内容
    public string? GeneratedWorkflowJson { get; set; } // assistant 消息附带的工作流 JSON
    public string? GeneratedPatch { get; set; }        // 修改建议 patch
    public string UserId { get; set; }
    public DateTime CreatedAt { get; set; }
    public long Seq { get; set; }            // 用于 afterSeq 分页
}
```

---

## 阶段二：前端 — 工作流聊天面板

### 2.1 组件结构

```
src/pages/workflow-agent/
├── WorkflowChatPanel.tsx          # 右侧聊天面板主组件
├── components/
│   ├── WorkflowChatMessage.tsx    # 消息渲染（支持 Markdown + 工作流预览）
│   └── WorkflowApplyButton.tsx    # "应用到工作流" 按钮
```

### 2.2 WorkflowChatPanel 设计

**布局：** 右侧抽屉/面板，宽度 400px，可折叠

**UI 结构：**
```
┌──────────────────────────┐
│ 🤖 工作流助手        [×] │
├──────────────────────────┤
│                          │
│  [消息历史区域]          │
│                          │
│  User: 帮我抓取TAPD数据  │
│                          │
│  AI: 我来帮你创建工作流   │
│  ┌────────────────────┐  │
│  │ 生成的工作流预览    │  │
│  │ ManualTrigger → ..  │  │
│  │ [应用到编辑器]      │  │
│  └────────────────────┘  │
│                          │
├──────────────────────────┤
│ [输入框]          [发送] │
│ [📎 粘贴代码/URL]        │
└──────────────────────────┘
```

**核心逻辑：**
1. 用户输入指令 → POST `/api/workflow-agent/workflows/from-chat`
2. SSE 接收 AI 回复，实时渲染 Markdown
3. 收到 `workflow_generated` 事件 → 显示工作流预览卡片
4. 用户点"应用到编辑器" → 更新 WorkflowEditorPage 的节点列表
5. 执行失败时，面板自动提示"分析失败原因"按钮

### 2.3 集成到 WorkflowEditorPage

在 `WorkflowEditorPage.tsx` 中：
- 右上角增加"AI 助手"按钮，点击展开/收起聊天面板
- 页面布局从 `左侧舱目录 | 右侧节点列表` 变为 `左侧舱目录 | 中间节点列表 | 右侧聊天面板（可选）`
- 聊天面板通过回调函数 `onApplyWorkflow(nodes, edges, variables)` 将 AI 生成的配置应用到编辑器

---

## 阶段三：Skill 集成 — Python 代码转工作流

### 3.1 Skill 定义

在 Claude Code 的 skill 系统中注册新技能 `workflow-from-code`：

**触发词：** "转工作流"、"代码变工作流"、"convert to workflow"、"python to workflow"

**Skill 职责：**
1. 读取用户提供的 Python/JS 代码或 GitHub URL
2. 分析代码中的：
   - HTTP 请求（URL、Method、Headers、Body）→ 映射为 `http-request` 或 `smart-http` 舱
   - 数据处理逻辑 → 映射为 `data-extractor` / `data-merger` / `format-converter` 舱
   - LLM 调用 → 映射为 `llm-analyzer` 舱
   - 文件操作 → 映射为 `file-exporter` 舱
   - 条件判断 → 映射为 `condition` 舱
3. 调用内部 API `/api/workflow-agent/workflows/from-chat` 创建工作流
4. 返回创建结果 + 工作流 URL

### 3.2 LLM System Prompt 设计（核心）

```
你是工作流配置助手。你的任务是将用户的自然语言描述或代码片段转换为工作流配置。

## 可用舱类型
{动态注入 CapsuleTypeRegistry.All 的完整 Schema}

## 输出格式
你必须返回以下 JSON 结构：
{
  "name": "工作流名称",
  "description": "描述",
  "nodes": [
    {
      "nodeId": "node-1",
      "name": "步骤名称",
      "nodeType": "http-request",  // 必须是可用舱类型
      "config": { ... },           // 按舱的 ConfigSchema 填写
      "outputSlots": [...]
    }
  ],
  "edges": [
    { "sourceNodeId": "node-1", "sourceSlotId": "...", "targetNodeId": "node-2", "targetSlotId": "..." }
  ],
  "variables": [
    { "key": "tapd_cookie", "defaultValue": "", "description": "TAPD 认证 Cookie" }
  ]
}

## 代码转换规则
1. requests.get/post → http-request 舱
2. 循环分页 → smart-http 舱（自动分页）
3. json 解析/提取 → data-extractor 舱（JSONPath）
4. pandas 处理 → format-converter 舱
5. 文件写入 → file-exporter 舱
6. 条件判断 → condition 舱
7. Cookie/Token → 提取为工作流变量

## 错误分析规则
当工作流执行失败时：
1. 检查 HTTP 状态码 → 认证过期？URL 错误？
2. 检查数据格式 → JSONPath 是否匹配响应结构？
3. 检查依赖关系 → 上游数据是否正确传递？
4. 给出具体修复建议（修改哪个舱的哪个配置字段）
```

---

## 阶段四：TAPD 场景端到端验证

以 `chenJiaYing11/tapd` 仓库代码为测试用例：

### 4.1 预期生成的工作流

```
ManualTrigger
  ↓
HttpRequest (搜索缺陷列表)
  - URL: https://www.tapd.cn/api/search_filter/search_filter/search
  - Method: POST
  - Headers: User-Agent, Cookie(变量引用)
  - Body: workspace_ids, search_data, obj_type=bug
  ↓
DataExtractor (提取缺陷 ID 列表)
  - JSONPath: $.data.list[*].id
  ↓
HttpRequest (批量获取缺陷详情) — 循环或 SmartHttp
  - URL: https://www.tapd.cn/api/aggregation/workitem_aggregation/common_get_info
  - Method: POST
  - Body: workspace_id, entity_id={id}, entity_type=bug
  ↓
DataExtractor (提取关键字段)
  - JSONPath: 提取 24 个字段
  ↓
FormatConverter (JSON → CSV)
  ↓
FileExporter (导出 Excel/CSV)
```

### 4.2 验证清单
- [ ] AI 能正确识别 Python 代码中的 HTTP 请求
- [ ] 自动提取 Cookie 为工作流变量
- [ ] 正确映射分页逻辑到 smart-http
- [ ] 执行后能获取真实 TAPD 数据
- [ ] 失败时 AI 能诊断原因并建议修复

---

## 实现优先级与步骤

| 步骤 | 内容 | 涉及文件 | 预估复杂度 |
|------|------|----------|-----------|
| **Step 1** | 后端：`/workflows/from-chat` SSE 端点 + LLM prompt | `WorkflowAgentController.cs` | 中 |
| **Step 2** | 后端：`WorkflowChatMessage` 模型 + 对话历史 CRUD | `WorkflowModels.cs`, `MongoDbContext.cs` | 低 |
| **Step 3** | 后端：`/executions/{id}/analyze` 错误分析端点 | `WorkflowAgentController.cs` | 低 |
| **Step 4** | 前端：`WorkflowChatPanel` 组件 + SSE 流式渲染 | 新增 `WorkflowChatPanel.tsx` | 中 |
| **Step 5** | 前端：集成到 `WorkflowEditorPage`，"应用到编辑器"逻辑 | `WorkflowEditorPage.tsx` | 中 |
| **Step 6** | 前端：API service + contracts 类型定义 | `workflowAgent.ts` (两处) | 低 |
| **Step 7** | Skill：`workflow-from-code` 技能注册 | 新增 skill 配置 | 低 |
| **Step 8** | 端到端：TAPD 场景测试 + prompt 调优 | prompt 模板优化 | 中 |

---

## 技术要点

1. **LLM 调用**：必须通过 `ILlmGateway`，AppCallerCode = `workflow-agent.chat::chat`
2. **SSE 流**：复用 `readSseStream()` 前端工具函数，支持 `afterSeq` 重连
3. **Server Authority**：LLM 调用使用 `CancellationToken.None`，客户端断开不中断处理
4. **舱 Schema 注入**：动态从 `CapsuleTypeRegistry.All` 生成 prompt，确保 LLM 始终知道最新舱类型
5. **安全**：Cookie/Token 等敏感信息通过 `workflow_secrets` 存储，不在对话历史中明文保存
