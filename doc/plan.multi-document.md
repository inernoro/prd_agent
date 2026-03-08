# PRD Agent 多文档系统设计方案

> 状态：方案评审中 | 创建：2026-03-01

## 现状分析

当前 PRD Agent 是**一个会话 (Session) 绑定一个文档 (DocumentId)** 的单文档模型：

```
Session.DocumentId → ParsedPrd (单个文档)
                  ↓
ChatService → 取 session.DocumentId → 获取单个文档 → 注入 LLM 上下文
```

关键依赖链：
- `Session.DocumentId` (string) → 只能绑定一个文档
- `ChatService.SendMessageAsync` → `_documentService.GetByIdAsync(session.DocumentId)` → 单个 `document.RawContent`
- `PromptManager.BuildPrdContextMessage(document.RawContent)` → 将单个文档包装为 `[[CONTEXT:PRD]]`
- `Group.PrdDocumentId` (string) → 群组也只绑定一个文档
- 前端 `sessionStore.document` → 单个 `Document` 对象

---

## 方案对比（按变更量从小到大）

### 方案 A：Session 层多文档引用 ⭐ 推荐

**核心思路**：在 Session 上新增 `DocumentIds: string[]`，保持 `DocumentId` 兼容，ChatService 合并多个文档内容注入 LLM。

**变更范围**：
| 层级 | 文件 | 变更 |
|------|------|------|
| Model | `Session.cs` | 新增 `List<string>? DocumentIds` |
| Service | `ChatService.cs` | `GetByIdAsync(session.DocumentId)` → 循环获取多个文档，合并 PRD 上下文 |
| Service | `PromptManager.cs` | 新增 `BuildMultiPrdContextMessage(docs[])` |
| Controller | `DocumentsController.cs` | Upload 端点支持传入 `sessionId`（追加文档到现有会话） |
| Controller | `SessionsController.cs` | 响应中返回 `documentIds` |
| Desktop Store | `sessionStore.ts` | `document` → `documents: Document[]` |
| Desktop UI | 会话信息区 | 显示多个文档标题，支持增删 |

**估计变更文件数**：~8-10 个
**优点**：改动最小、完全向后兼容（`DocumentId` 保留为主文档）
**缺点**：多文档合并后可能超 Token 限制，需要截断策略

---

### 方案 B：文档组 (DocumentBundle) 抽象

**核心思路**：新建 `DocumentBundle` 集合，将多个 `ParsedPrd` 聚合为一个 Bundle。Session/Group 绑定 BundleId 而非 DocumentId。

**变更范围**：
| 层级 | 文件 | 变更 |
|------|------|------|
| Model | 新增 `DocumentBundle.cs` | `{ BundleId, DocumentIds[], Title, CreatedAt }` |
| Repository | 新增 `IDocumentBundleRepository` | CRUD |
| Service | 新增 `DocumentBundleService` | 聚合文档内容 |
| Model | `Session.cs` | `DocumentId` → `DocumentBundleId`（或并存） |
| Model | `Group.cs` | `PrdDocumentId` → `PrdBundleId`（或并存） |
| Controller | 新增 Bundle 管理端点 | 创建/编辑/查看 Bundle |
| Service | `ChatService.cs` | 通过 BundleService 获取合并文档 |
| 前端 | Bundle 管理 UI | 完整的 Bundle CRUD 界面 |

**估计变更文件数**：~15-20 个
**优点**：概念清晰，Bundle 可复用
**缺点**：引入新集合和抽象层，变更量大

---

### 方案 C：上传时合并为单文档

**核心思路**：前端在上传时将多个文件合并为一个 Markdown 文档（用分隔符分开），后端无改动。

**变更范围**：
| 层级 | 文件 | 变更 |
|------|------|------|
| 前端 | `AiChatPage.tsx` | 多文件选择 → 合并为单个 content |
| 前端 | Desktop 上传组件 | 同上 |

**估计变更文件数**：~2-3 个
**优点**：后端零改动
**缺点**：丢失文档边界信息，无法单独管理/增删文档，不可回溯

---

## 推荐：方案 A（Session 层多文档引用）

选择理由：
1. **变更量最小**：核心改动集中在 Session 模型 + ChatService + PromptManager
2. **完全向后兼容**：`DocumentId` 保留为主文档（首个文档），旧逻辑不受影响
3. **渐进式**：先实现基本的多文档注入，后续可按需扩展文档管理 UI
4. **前端改动可控**：只需在上传流程增加"追加文档"入口

### 详细实现计划

#### Phase 1：后端模型 + 服务层（核心）

1. **Session.cs** — 新增字段
```csharp
/// <summary>关联的文档ID列表（多文档支持）</summary>
public List<string> DocumentIds { get; set; } = new();
```
`DocumentId` 保留为 computed getter（取 `DocumentIds[0]`），兼容所有现有引用。

2. **ChatService.cs** — 合并多文档上下文
```csharp
// 替换单文档获取
var documents = new List<ParsedPrd>();
foreach (var docId in session.DocumentIds)
{
    var doc = await _documentService.GetByIdAsync(docId);
    if (doc != null) documents.Add(doc);
}
if (documents.Count == 0) { /* error */ }

// 合并注入
var prdContext = _promptManager.BuildMultiPrdContextMessage(documents);
```

3. **PromptManager.cs** — 新增多文档包装
```csharp
public string BuildMultiPrdContextMessage(List<ParsedPrd> documents)
{
    if (documents.Count == 1)
        return BuildPrdContextMessage(documents[0].RawContent);

    var sb = new StringBuilder();
    sb.AppendLine("[[CONTEXT:PRD_BUNDLE]]");
    for (int i = 0; i < documents.Count; i++)
    {
        sb.AppendLine($"<PRD index=\"{i+1}\" title=\"{documents[i].Title}\">");
        sb.AppendLine(documents[i].RawContent);
        sb.AppendLine("</PRD>");
    }
    sb.AppendLine("[[/CONTEXT:PRD_BUNDLE]]");
    return sb.ToString();
}
```

#### Phase 2：API 层

4. **DocumentsController.cs** — 新增"追加文档到会话"端点
```
POST /api/v1/sessions/{sessionId}/documents
Body: { content: string, title?: string }
→ 解析文档，追加到 session.DocumentIds
```

5. **SessionsController.cs** — 响应中包含 `documentIds`

#### Phase 3：前端适配

6. **sessionStore.ts** — `document` → `documents: Document[]`
7. **上传组件** — 支持"追加文档"按钮
8. **会话信息区** — 显示多个文档标签，支持移除

---

## Token 预算控制

多文档合并后的 Token 控制策略：

| 策略 | 说明 |
|------|------|
| 总量校验 | 上传时检查 `sum(doc.TokenEstimate)` 是否超限 |
| 摘要降级 | 超限时对非主文档使用章节标题摘要替代全文 |
| 用户提示 | 前端显示当前 Token 使用进度条 |
