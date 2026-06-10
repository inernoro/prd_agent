# design.knowledge-agent-architecture

> 状态：active | 所属：prd-api + prd-admin | 最后更新：2026-06-07

---

## 管理摘要

CDS Agent 的工作区基础设施模型已从「GitHub 仓库为主」调整为「文件夹/知识库为主」。GitHub 仓库从原先的必填项降级为可选钩子，仅用于 PR 审查、Webhook 通知等 Git 侧场景。这一调整使得绝大多数用户（不依赖 GitHub 的分析、代码审阅、运维巡检场景）无需配置任何 Git 远端，即可向 CDS Agent 提供有意义的上下文。

核心变化一句话：**会话的工作区来源从 `gitRepository + gitRef` 字段，迁移到 `workspaceKbId`（指向 `document_stores` 集合中的某个文件夹/知识库）**。

---

## 背景

### 原模型问题

旧的「代码模式」输入区以 GitHub 仓库 URL 为首位，隐含了以下假设：

- 用户有 GitHub 仓库
- 用户愿意把仓库地址暴露给 CDS Agent
- CDS Agent 能直接 clone 并操作代码

这三个假设在绝大多数实际场景下都不成立（企业私有代码库、无 VCS 的任务、文档分析场景等）。结果是首位输入框对多数用户没有意义，真正的上下文（文档、知识、配置说明）没有入口。

### 新模型目标

- 以文件夹/知识库（`document_stores` 集合）为工作区主要来源
- GitHub 仓库保留为可选，仅用于 PR 钩子等 Git 场景
- 前端表单结构清晰：主选「知识库」，次选「GitHub 仓库（可选）」

---

## 核心决策

### D1：工作区来源字段

| 字段 | 类型 | 语义 | 优先级 |
|------|------|------|--------|
| `workspaceKbId` | `string?` | 文件夹/知识库 ID，指向 `document_stores` 集合 | 主选（优先） |
| `gitRepository` | `string?` | GitHub 仓库 URL | 可选（降级为钩子） |
| `gitRef` | `string?` | 分支名（默认 main） | 可选（随 gitRepository） |

两个字段可以同时存在：既指定了知识库，又指定了 GitHub 仓库——Agent 运行时优先从知识库拉取文档上下文，GitHub 仓库用于触发 PR / Webhook 操作。

### D2：GitHub 降级为钩子

GitHub 仓库在以下场景仍有意义：

- PR 审查：Agent 读取 PR diff，评论代码
- Webhook 触发：某个 Git 事件触发 Agent 工作流
- Ref 锁定：Agent 需要精确操作某个分支版本

这些场景是「触发/操作」而非「上下文来源」。文档/知识才是上下文来源。

### D3：文件注入到 CDS 沙箱（当前受阻）

知识库文件注入到 CDS 边车沙箱的能力**当前受阻（gated）**，原因如下：

| 能力层 | 状态 | 说明 |
|--------|------|------|
| MAP 侧接缝（POST /api/infra-agent-sessions/{id}/inject-files） | 已实现 | 接口骨架存在，可接收文件路径参数 |
| CDS files 端点复用 | 已实现 | `POST /projects/:id/branches/:bid/files` 可写入沙箱文件系统 |
| 知识库文件下载 + 传输 | 未实现 | 需要从 `document_entries` 拉取内容并传输到 CDS 边车 |
| 边车内文件可见性 | 未验证 | 注入的文件能否被 Agent 运行时实际读取，尚未端到端验证 |

**当前阶段（v1）**：`workspaceKbId` 字段仅存入 `infra_agent_sessions` 文档，供 Agent prompt 渲染时读取知识库元信息（库名、描述、标签）。文件内容的实际注入依赖后续工程（见下方债务节）。

---

## 数据模型

### InfraAgentSession 新增字段

```
document: infra_agent_sessions
新增字段: workspaceKbId: string?
  - 关联: document_stores._id
  - 语义: 本次会话使用的主工作区（文件夹/知识库）
  - 可为空: GitHub 仓库作为唯一工作区来源时为 null
```

现有字段保持不变：`gitRepository`, `gitRef`, `workspaceRoot` 继续存在，不做废弃。

### 官方 / 自建边界表（遵从 agent-runtime-sdk-boundary.md）

| 层 | 实现方式 | 说明 |
|----|----------|------|
| 模型 / API 客户端 | 官方 `anthropic` Python SDK（边车内） | 边车调用 Anthropic Messages API |
| Agent 循环 | 自建（CDS 边车 agent_loop） | MAP 不接管 Agent 循环，由边车负责 |
| 传输协议 | 自建 SSE（边车 → MAP → 前端） | 非 Claude Code SDK 官方传输层 |
| 工具执行 | 自建（边车 tool_use 转发 + MAP 审批） | MAP 自建审批队列，不走官方 tool_call |
| 审批 / 审计 | 自建（InfraAgentApprovalQueue） | 用户在 MAP 确认后边车继续 |
| 工作区 / 仓库工具 | 自建（CDS files API + inject-files 接缝） | 非 Claude Code SDK 官方工作区 |
| 运行时池 / 沙箱 | 自建（CDS branch + docker exec） | MAP 不接管沙箱生命周期 |

**结论**：本系统是「CDS 边车 + MAP 自建 Agent 运行时」，不是「官方 Claude Code SDK 集成」。文档中禁止出现「完整官方 SDK 集成」等描述。

---

## 接口设计

### 前端新增字段（draft state）

```typescript
// CdsAgentPage.tsx draft
{
  workspaceKbId: string;  // 知识库 ID，空字符串表示未选择
  gitRepository: string;  // GitHub 仓库 URL（可选，钩子用）
  gitRef: string;         // 分支（随 gitRepository）
}
```

### 后端 DTO（待实现，见债务节）

```csharp
// InfraAgentSessionService.CreateSession 输入需新增：
public record CreateInfraAgentSessionInput(
    string ConnectionId,
    string? WorkspaceKbId,   // 新增
    string? GitRepository,
    string? GitRef,
    // ... 其他现有字段
);
```

### 前端 UI 层级

```
代码模式输入区
├── [主选] 工作区文件夹/知识库（select 下拉，从 GET /api/document-stores 拉取）
└── [可选] GitHub 仓库 URL（input，带分支输入框）
    └── 标签: 「可选：GitHub 仓库（PR/钩子用）」
```

---

## 关联文档

- `design.cds-agent-runtime-architecture.md` — CDS Agent 整体运行时架构
- `doc/debt.cds-agent-workspace.md` — 工作区注入工程债务台账（待创建）
- `.claude/rules/agent-runtime-sdk-boundary.md` — SDK 边界声明规则
- `.claude/rules/no-rootless-tree.md` — 禁止声明未实现的能力

---

## 风险与债务

### 当前已知边界

1. **文件注入未端到端打通**：`workspaceKbId` 目前仅存库，Agent prompt 只能拿到知识库元信息（名称/描述），不能直接读取文件内容。要实现完整的「知识库文件注入沙箱」需要：
   - `InfraAgentSessionService` 中在创建/启动会话时查询 `document_stores` + `document_entries`
   - 下载文件内容（Blob 或文本）
   - 调用 CDS files API 写入边车沙箱
   - 在 Agent system prompt 中告知文件路径

2. **知识库权限隔离未审计**：`workspaceKbId` 传入时，后端需确认当前用户有权读取该知识库（与 `GET /api/document-stores/:id` 的权限校验对齐）。当前 DTO 扩展时需补充此检查。

3. **大文件知识库注入性能**：知识库条目数百篇时，全量注入会导致沙箱启动延迟。后续需要支持「按需注入」或「摘要注入」。

4. **GitHub 钩子场景未测试**：降级后的 GitHub 字段作为「钩子」的语义，在 PR 审查流程中是否正确传递，需要专项验证。
