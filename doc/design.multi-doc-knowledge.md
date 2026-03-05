# 多文档知识库与文档类型系统 — 设计文档

> **版本**: v1.0
> **日期**: 2026-03-05
> **状态**: 已实现
> **涉及端**: 后端 / 桌面端 / 管理后台

---

## 1. 设计思想

### 1.1 核心理念：主文档是"锚"，辅助文档是"上下文"

PRD Agent 的对话围绕**一份核心文档**展开，但实际工作场景中，AI 需要参考多份文档才能给出高质量回答。设计目标是：

- **主文档（Primary Document）**: 对话的焦点和锚点，AI 的回答围绕它展开
- **辅助文档（Supplementary Documents）**: 提供参考上下文，帮助 AI 交叉验证和补充信息
- **文档类型（Document Type）**: 告诉 AI 每份文档的"角色"，未来可用于调整引用权重

### 1.2 设计原则

| 原则 | 说明 |
|------|------|
| **主文档即身份** | 主文档不是"第一个上传的文档"，而是一个**主动设定**。它决定对话方向 |
| **类型即角色** | 文档类型不是文件格式，而是在当前会话中的**角色标记** |
| **向后兼容** | 旧 session 无 `DocumentIds` 字段时，自动回退到 `DocumentId` 单文档模式 |
| **会话级绑定** | 同一文档在不同会话中可以有不同类型（同一份技术文档在 A 会话是"主文档"，在 B 会话是"参考资料"） |

### 1.3 为什么文档类型存在 Session 而非 Document

```
文档（ParsedPrd）    = 内容实体，不含上下文信息
会话（Session）      = 使用上下文，包含"如何使用这些文档"
```

同一份 API 文档在"PRD 评审"会话中是参考资料，在"技术方案评审"会话中可能是主文档。类型是**使用方式**，不是**内在属性**。

---

## 2. 数据模型

### 2.1 Session 模型扩展

```
Session {
  DocumentId: string          // 主文档 ID（向后兼容）
  DocumentIds: string[]       // 多文档 ID 列表
  DocumentMetas: [{           // 文档元数据（新增）
    DocumentId: string
    DocumentType: string      // "product" | "technical" | "design" | "reference"
  }]
}
```

### 2.2 文档类型枚举

| 类型 | 标签 | 默认场景 | 未来权重建议 |
|------|------|----------|-------------|
| `product` | 产品文档 | 主文档默认类型 | 权重最高，AI 回答必须围绕 |
| `technical` | 技术文档 | 技术方案、API 文档 | 高权重，用于可行性判断 |
| `design` | 设计文档 | UI/UX 设计规范 | 中等权重 |
| `reference` | 参考资料 | 追加文档默认类型 | 低权重，补充参考 |

### 2.3 向后兼容策略

```
旧 session（无 DocumentIds）:
  GetAllDocumentIds() → [DocumentId]
  GetDocumentType("xxx") → "product"（因为 DocumentId == "xxx"）

旧 session（有 DocumentIds 但无 DocumentMetas）:
  GetDocumentType("主文档ID") → "product"（默认）
  GetDocumentType("其他ID")   → "reference"（默认）

新 session（有 DocumentMetas）:
  GetDocumentType(id) → 从 DocumentMetas 查找，找到返回实际值
```

---

## 3. 核心实现原理

### 3.1 上下文组装流程（当前）

```
用户发送消息
  │
  ▼
ChatService.SendMessageAsync()
  │
  ├─ session.GetAllDocumentIds() → 获取所有文档 ID
  ├─ foreach docId → documentService.GetByIdAsync() → 加载文档内容
  │
  ▼
PromptManager.BuildMultiPrdContextMessage(documents)
  │
  ├─ 单文档: 直接插入 RawContent
  └─ 多文档: 用 <PRD index="N" title="XXX"> 标签包裹
      │
      ▼
  [[CONTEXT:PRD_BUNDLE]]
  <PRD index="1" title="海鲜市场 (Configuration Marketplace)">
  {完整 Markdown 内容}
  </PRD>
  <PRD index="2" title="AI与Cursor实战分享 - 考核题目">
  {完整 Markdown 内容}
  </PRD>
  [[/CONTEXT:PRD_BUNDLE]]
```

**关键文件路径**:

| 文件 | 职责 |
|------|------|
| `PrdAgent.Core/Services/ChatService.cs:103-211` | 文档加载 + 消息组装 |
| `PrdAgent.Infrastructure/Prompts/PromptManager.cs:101-125` | 多文档 → PRD_BUNDLE |
| `PrdAgent.Core/Services/DocCitationExtractor.cs:26-95` | 引用提取（仅主文档） |
| `PrdAgent.Core/Models/Session.cs:26-44` | 文档列表 + 类型查询 |

### 3.2 动态披露过程

"动态披露"指的是：不是把所有文档一股脑扔给 LLM，而是根据场景逐步展开上下文。

**当前实现（静态全量）**:
```
所有文档 → 全部注入 → LLM 自行判断引用哪部分
```

**未来演进方向（动态披露）**:
```
用户提问
  │
  ├─ 意图识别：这个问题关联哪些文档？
  │   └─ 基于 documentType + 关键词匹配 + 章节相关性
  │
  ├─ 一级披露：只注入主文档 + 最相关的辅助文档
  │
  ├─ LLM 回答中引用了未注入的文档？
  │   └─ 二级披露：追加注入被引用的文档章节
  │
  └─ 最终回答 + 跨文档引用标注
```

### 3.3 与技能系统的交互

技能（Skill）通过 `contextScope` 控制上下文注入范围：

| contextScope | 行为 | 多文档影响 |
|-------------|------|-----------|
| `all` | 注入对话历史 + 所有文档 | 全部文档进入上下文 |
| `current` | 注入当前对话上下文 | 全部文档 + 对话历史 |
| `prd` | 仅注入文档，不含对话 | 全部文档，无对话历史 |
| `none` | 不注入任何上下文 | 无文档注入 |

**一键创建技能**（SkillManagerModal）中，用户可选择 contextScope。当选择 `prd` 时，技能执行会自动获取会话中的所有文档作为上下文，无需手动指定。

---

## 4. 风险比对矩阵

### 4.1 单文档 vs 多文档

| 维度 | 单文档 | 多文档 | 风险/限制 |
|------|--------|--------|----------|
| **Token 消耗** | 一份文档的 tokens | 所有文档 tokens 叠加 | 多文档可能超出模型上下文窗口。当前无截断策略 |
| **引用准确性** | 高（来源明确） | 中（可能混淆来源） | 当前引用提取仅基于主文档，辅助文档的内容被引用但无法标注来源 |
| **回答焦点** | 始终围绕唯一文档 | 可能偏离主文档 | LLM 可能过度关注辅助文档内容，偏离主题 |
| **上下文质量** | 100% 相关 | 部分可能不相关 | 无关文档会稀释有效上下文 |
| **性能** | 快 | 文档数 × 获取时间 | 每个文档需单独 API 调用获取内容 |
| **主文档切换** | 不适用 | 支持（通过更换 DocumentId） | 切换主文档会影响引用提取和默认类型 |
| **数据一致性** | 简单 | DocumentIds + DocumentMetas 需同步 | AddDocument/RemoveDocument 时需同步维护两个列表 |

### 4.2 文档类型的局限性与扩展性

| 维度 | 当前状态 | 局限性 | 扩展方向 |
|------|----------|--------|----------|
| **类型枚举** | 4 种固定类型 | 无法自定义 | 可改为后端配置 + 前端动态渲染 |
| **权重影响** | 仅 UI 标记，不影响 LLM | 类型信息未传递给 LLM | 在 PromptManager 中根据类型设置 `<PRD weight="high">` |
| **引用提取** | 仅主文档 | 辅助文档的引用丢失 | DocCitationExtractor 改为遍历所有文档 |
| **类型继承** | 无 | 文档被 fork 后类型不继承 | fork 时可选择是否继承类型设置 |
| **类型统计** | 无 | 无法分析哪类文档最常用 | 可在 llmrequestlogs 中记录文档类型分布 |

### 4.3 已知风险清单

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| Token 超限 | 中（3+ 大文档） | 高（LLM 报错或截断） | 需实现 token budget 分配策略 |
| 引用来源混淆 | 高（多文档时） | 中（用户看到引用但不知来自哪个文档） | DocCitationExtractor 扩展为多文档提取 |
| 旧数据迁移 | 低 | 低 | GetDocumentType() 有完整 fallback 逻辑 |
| 并发修改 | 低 | 中 | DocumentMetas 的 add/remove 操作已在 service 层做原子操作 |

---

## 5. 路径追踪

### 5.1 全栈数据流

```
[用户操作] 知识库管理页 → 选择文档类型下拉框 → 选 "技术文档"
     │
     ▼
[Desktop Frontend] handleChangeDocumentType(docId, "technical")
     │ invoke('update_document_type', { sessionId, documentId, documentType: "technical" })
     │
     ▼
[Rust Tauri] update_document_type command
     │ client.patch("/sessions/{sessionId}/documents/{documentId}/type", { documentType: "technical" })
     │
     ▼
[.NET Controller] SessionsController.UpdateDocumentType()
     │ validate → canAccess → sessionService.UpdateDocumentTypeAsync()
     │
     ▼
[SessionService] UpdateDocumentTypeAsync()
     │ session.DocumentMetas.Find(m => m.DocumentId == docId).DocumentType = "technical"
     │ → UpsertAsync(session) → MongoDB
     │
     ▼
[Response] SessionResponse { documentMetas: [...], ... }
     │
     ▼
[Desktop Frontend] setDocuments(docs.map(d => ({ ...d, documentType: metaMap.get(d.id) })))
     │
     ▼
[UI 更新] 知识库页 下拉框显示 "技术文档" ✓ 侧栏显示类型标签 ✓
```

### 5.2 文件索引（按修改层级）

| 层级 | 文件 | 变更类型 | 关键行 |
|------|------|----------|--------|
| **Core Model** | `PrdAgent.Core/Models/Session.cs` | 新增 `DocumentMetas` + `GetDocumentType()` + `SessionDocumentMeta` 类 | L22-70 |
| **Interface** | `PrdAgent.Core/Interfaces/ISessionService.cs` | 新增 `UpdateDocumentTypeAsync()` | L34-35 |
| **Core Service** | `PrdAgent.Core/Services/SessionService.cs` | 实现 AddDocument/RemoveDocument/UpdateType with metas | L119-185 |
| **Infra Service** | `PrdAgent.Infrastructure/Services/MongoSessionService.cs` | MongoDB 实现 | L151-215 |
| **Request DTO** | `PrdAgent.Api/Models/Requests/DocumentRequests.cs` | `AddDocumentToSessionRequest.DocumentType` + `UpdateDocumentTypeRequest` | L30-51 |
| **Response DTO** | `PrdAgent.Api/Models/Responses/SessionResponses.cs` | `SessionDocumentMetaDto` | L44-48 |
| **Response DTO** | `PrdAgent.Api/Models/Responses/GroupResponses.cs` | `OpenGroupSessionResponse.DocumentMetas` | L68 |
| **Controller** | `PrdAgent.Api/Controllers/SessionsController.cs` | PATCH endpoint + BuildDocumentMetas() | L416-460 |
| **Controller** | `PrdAgent.Api/Controllers/GroupsController.cs` | 补充 DocumentMetas 到 OpenGroupSession | L289-298 |
| **Rust Model** | `src-tauri/src/models/mod.rs` | `SessionDocumentMeta` + SessionInfo/OpenGroupSessionResponse 扩展 | L54-74, L137-146 |
| **Rust Command** | `src-tauri/src/commands/document.rs` | `update_document_type` + `add_document_to_session` 扩展 | L62-97 |
| **Rust Client** | `src-tauri/src/services/api_client.rs` | `patch()` 方法 | L584-665 |
| **Rust Registry** | `src-tauri/src/lib.rs` | 注册 `update_document_type` | L181 |
| **TS Types** | `prd-desktop/src/types/index.ts` | `DocumentType` + `DocumentMeta` + `DOCUMENT_TYPE_LABELS` | L48-68 |
| **TS Lib** | `prd-desktop/src/lib/openGroupSession.ts` | 从 response 提取 metas 合并到 Document | L30, L43-53 |
| **Desktop UI** | `prd-desktop/src/components/Layout/Sidebar.tsx` | 补充文档预览眼睛 + 类型标签 | L738-772 |
| **Desktop UI** | `prd-desktop/src/components/KnowledgeBase/KnowledgeBasePage.tsx` | 预览 + 类型选择器 | 全文重写 |
| **Admin UI** | `prd-admin/src/pages/AiChatPage.tsx` | 类型标签 + metas 映射 | L22-30, L438, L1260 |
| **Admin API** | `prd-admin/src/services/real/aiChat.ts` | `updateDocumentType()` | L36-42 |

---

## 6. 上下文结合最佳实践

### 6.1 当前最佳用法

| 场景 | 主文档 (product) | 辅助文档 | 效果 |
|------|-----------------|----------|------|
| PRD 评审 | 产品需求文档 | 技术方案(technical) + 竞品分析(reference) | AI 围绕需求评审，引用技术方案验证可行性 |
| 技术评审 | 技术设计文档(technical) | PRD(product) + 架构规范(reference) | AI 围绕技术方案，对照 PRD 检查需求覆盖 |
| 缺陷分析 | 缺陷报告(product) | PRD + API 文档(technical) | AI 基于缺陷描述，参考 PRD 判断是否符合预期 |
| 测试设计 | 测试计划(product) | PRD + 技术文档(technical) | AI 基于计划生成用例，参考需求和接口 |

### 6.2 未来扩展：基于类型的上下文优化

```
阶段 1（当前）: 全量注入 + UI 类型标记
  └─ 所有文档平等注入，类型仅用于 UI 展示

阶段 2（Token 预算分配）:
  └─ product: 50% token 预算
     technical: 30% token 预算
     design: 10% token 预算
     reference: 10% token 预算
  └─ 超出预算的文档做摘要/截断

阶段 3（动态披露）:
  └─ 首次只注入主文档 + 问题最相关章节
  └─ LLM 需要更多上下文时，追加注入
  └─ 减少 token 浪费，提高回答精度

阶段 4（与技能融合）:
  └─ 技能定义中可指定"文档类型过滤"
  └─ 例如："代码审查"技能只注入 technical 类型文档
  └─ "需求分析"技能只注入 product 类型文档
```

### 6.3 与技能创建的结合

用户在 SkillManagerModal 创建技能时：

```
当前（contextScope 级别）:
  prd   → 注入所有文档
  all   → 注入所有文档 + 对话历史
  none  → 不注入

未来（documentType 级别）:
  技能可配置 "documentTypeFilter": ["product", "technical"]
  → 只注入指定类型的文档
  → 减少不必要的上下文，提高技能精度
```

---

## 7. API 端点参考

### 7.1 新增端点

```http
PATCH /api/v1/sessions/{sessionId}/documents/{documentId}/type
Content-Type: application/json

{
  "documentType": "technical"  // product | technical | design | reference
}

Response: SessionResponse (含更新后的 documentMetas)
```

### 7.2 修改的端点

```http
POST /api/v1/sessions/{sessionId}/documents
Content-Type: application/json

{
  "content": "# Markdown 内容...",
  "documentType": "reference"   // 可选，默认 "reference"
}

Response: SessionResponse (含 documentMetas)
```

### 7.3 增强的响应

所有返回 `SessionResponse` 或 `OpenGroupSessionResponse` 的端点现在都包含：

```json
{
  "documentIds": ["id1", "id2", "id3"],
  "documentMetas": [
    { "documentId": "id1", "documentType": "product" },
    { "documentId": "id2", "documentType": "technical" },
    { "documentId": "id3", "documentType": "reference" }
  ]
}
```

---

## 8. MongoDB 字段变更

### sessions 集合

| 字段 | 类型 | 新增/修改 | 说明 |
|------|------|----------|------|
| `DocumentMetas` | `Array<{ DocumentId: string, DocumentType: string }>` | 新增 | 各文档的类型元数据 |

**索引影响**: 无需新增索引，DocumentMetas 仅随 session 整体读写。

**迁移**: 无需数据迁移。`GetDocumentType()` 在 DocumentMetas 为空时自动 fallback。
