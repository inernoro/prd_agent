# AI 百宝箱 — 未完成项 & 下一步规划 & 共创方案

> **文档版本**: v1.0
> **创建日期**: 2026-02-09
> **基于**: design.ai-toolbox-mvp.md (Phase 0~1.5 已完成), design.ai-toolbox.md (v1.0 愿景)

---

## 一、当前完成度全景

### 已完成 (Phase 0 ~ 1.5)

| 功能 | 状态 | 关键代码 |
|------|------|----------|
| 统一对话入口 + 意图识别 | ✅ | `AiToolboxController.cs`, `IntentClassifier.cs` |
| 4 Agent 适配器 (PRD/Visual/Literary/Defect) | ✅ | `Adapters/*.cs` |
| 单 Agent 执行 + Run/Worker | ✅ | `ToolboxRunWorker.cs` |
| 双 Agent 串行编排 | ✅ | `SimpleOrchestrator.cs` |
| SSE 实时事件流 | ✅ | `RedisToolboxEventStore.cs` |
| 前端主页面 (工具网格 + 卡片) | ✅ | `AiToolboxPage.tsx`, `ToolCard.tsx` |
| 创建/编辑智能体 UI | ✅ | `ToolEditor.tsx` (完整表单) |
| 工具详情页 + 对话 UI | ✅ | `ToolDetail.tsx` |
| 基础能力测试面板 | ✅ | `BasicCapabilities.tsx` |
| 海鲜市场 (3 种类型) | ✅ | `CONFIG_TYPE_REGISTRY`, `ForkService.cs` |

---

### 未完成项清单

按 **紧迫度** 和 **价值** 排序：

#### P0 — 阻塞核心体验（必须先做）

| # | 未完成项 | 现状 | 差什么 | 影响 |
|---|---------|------|--------|------|
| 1 | **普通版 Agent 对话 API 未对接** | `ToolDetail.tsx:120-131` 用 `setTimeout` 模拟响应，`generateMockResponse()` 返回硬编码文本 | 需要对接后端 `POST /api/ai-toolbox/chat` 接口，走真实 LLM Gateway 调用 | 代码审查员、翻译、摘要师、数据分析师 4 个普通版 Agent 完全不可用 |
| 2 | **基础能力面板全部是 Mock** | `BasicCapabilities.tsx:182-193` 用字符逐个追加模拟流式，`getMockResponse()` 返回硬编码文本 | 需要对接 LLM Gateway，按 capability key 路由到真实模型 | 图片生成、文本生成、推理、联网搜索、代码解释器、文档解析、MCP 工具 — 全部假的 |
| 3 | **自定义 Agent CRUD 后端** | 前端 `ToolEditor.tsx` 表单已完整，`toolboxStore.ts` 调用了 `createToolboxItem/updateToolboxItem/deleteToolboxItem` | 后端 API 需要实现持久化（MongoDB 集合 `toolbox_items`），当前可能返回 404 | 用户创建的智能体无法保存 |

#### P1 — 高价值功能（MVP 后优先）

| # | 未完成项 | 现状 | 差什么 | 影响 |
|---|---------|------|--------|------|
| 4 | **附件上传到对话** | `ToolDetail.tsx` 有完整的文件选择 UI（文件 + 图片），但 `handleSend` 未上传文件 | 需要对接附件上传 API，将 attachmentIds 关联到消息 | 文档解析、图片理解等能力依赖文件上传 |
| 5 | **自定义 Agent 高级字段持久化** | `ToolEditor.tsx` 有 welcomeMessage、conversationStarters、enabledTools、temperature、enableMemory 字段 | 后端 Model 和 API 需支持这些字段 | 创建的智能体只保存了基础字段，高级配置丢失 |
| 6 | **Agent 并行执行** | `SimpleOrchestrator` 只支持串行 | 需要新建 `ParallelOrchestrator`，支持多 Agent 同时执行 + 结果合并 | 复杂工作流效率低（如同时生图 + 写文章） |
| 7 | **知识库集成** | `ToolEditor.tsx` 有知识库上传 UI 占位，后端无实现 | 需要文档切片 + 向量化 + 检索增强（RAG）| 自定义 Agent 无法基于私有知识回答 |

#### P2 — 共创生态（让大家参与）

| # | 未完成项 | 现状 | 差什么 | 影响 |
|---|---------|------|--------|------|
| 8 | **智能体发布到海鲜市场** | 海鲜市场支持 prompt/refImage/watermark，不支持 toolbox_item | 需要让 `ToolboxItem` 实现 `IForkable`，注册到 `CONFIG_TYPE_REGISTRY` | 用户无法分享自己创建的智能体 |
| 9 | **智能体 Fork/下载** | `ForkService.cs` 通用能力已就绪 | 需要为 toolbox_item 配置白名单字段 | 无法一键复制别人的智能体 |
| 10 | **使用量统计 + 排行** | `ToolboxItem.usageCount` 字段已定义 | 后端需要在每次 run 时 +1，市场按 usageCount 排序 | 无法发现热门智能体 |

#### P3 — 远期规划（Phase 3-5）

| # | 未完成项 | Phase | 说明 |
|---|---------|-------|------|
| 11 | PPT/PDF 导出 | Phase 3 | 需要集成 export 库 |
| 12 | 可视化工作流编辑器 | Phase 4 | 需要 React Flow |
| 13 | 插件系统 | Phase 5 | 需要安全沙箱 |

---

## 二、推荐的下一步执行顺序

### Sprint 1: 打通核心体验 (P0)

**目标**: 让所有 Agent 和基础能力都能真实运行

```
Week 1-2
├── Task 1.1: 普通版 Agent 对话对接 (2d)
│   ├── ToolDetail.tsx: handleSend → 调用 POST /api/ai-toolbox/chat
│   ├── 替换 generateMockResponse() 为真实 SSE 流
│   └── 支持 agentKey 路由到对应 Agent
│
├── Task 1.2: 基础能力 API 对接 (3d)
│   ├── 新建后端 POST /api/ai-toolbox/capabilities/{key}/chat
│   ├── 按 capability key 路由到 LLM Gateway
│   ├── BasicCapabilities.tsx: 替换 Mock 为真实调用
│   └── 各 capability 的 AppCallerCode 注册
│
└── Task 1.3: 自定义 Agent CRUD 后端 (2d)
    ├── 新建 MongoDB 集合 toolbox_items
    ├── AiToolboxController 增加 CRUD 端点
    ├── ToolboxItem Model 定义 (含所有编辑器字段)
    └── 确保前端 saveItem/deleteItem 能成功
```

### Sprint 2: 增强使用体验 (P1)

**目标**: 补全高价值功能，让产品真正可用

```
Week 3-4
├── Task 2.1: 附件上传对接 (2d)
│   ├── 复用现有 attachments 上传机制
│   ├── ToolDetail/BasicCapabilities 对接上传
│   └── 消息中关联 attachmentIds
│
├── Task 2.2: 自定义 Agent 执行 (2d)
│   ├── 自定义 Agent 走统一对话 API
│   ├── 将 systemPrompt + enabledTools 注入 LLM 调用
│   └── temperature 等参数生效
│
└── Task 2.3: 并行 Agent 编排 (3d)
    ├── ParallelOrchestrator 实现
    ├── 结果合并策略 (concat / merge)
    └── 前端 ExecutionPlan 支持并行展示
```

### Sprint 3: 开放共创 (P2)

**目标**: 让团队成员共享智能体，形成生态

```
Week 5-6
├── Task 3.1: 智能体上架海鲜市场 (3d)
│   ├── ToolboxItem 实现 IMarketplaceItem + IForkable
│   ├── CONFIG_TYPE_REGISTRY 新增 'agent' 类型
│   ├── MarketplaceCard 支持 Agent 预览
│   └── API: publish/unpublish/fork 端点
│
├── Task 3.2: 使用量统计 (1d)
│   ├── 每次 run 时 increment usageCount
│   ├── 市场支持按 usageCount 排序
│   └── ToolCard 展示使用热度
│
└── Task 3.3: 收藏 + 推荐 (2d)
    ├── 用户收藏功能 (user_preferences)
    ├── 首页推荐位 ("热门智能体")
    └── 分类筛选支持 'favorite' 标签
```

---

## 三、共创方案 — 让大家一起参与

### 3.1 共创模式设计

```
┌──────────────────────────────────────────────────────────────┐
│                      共创生态闭环                              │
│                                                              │
│   创建 ──→ 调试 ──→ 发布 ──→ 他人 Fork ──→ 改进 ──→ 再发布   │
│    │                  │                      │               │
│    └── ToolEditor ──→ ToolDetail ──→ 海鲜市场 ──→ Fork ──→  │
│                                              ↓               │
│                                         二次创作              │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 共创参与门槛（低 → 高）

| 层级 | 参与方式 | 门槛 | 示例 |
|------|---------|------|------|
| L1 使用者 | 直接使用别人创建的智能体 | 零门槛 | 打开百宝箱 → 选个工具 → 用 |
| L2 Fork 者 | Fork 别人的智能体，微调 Prompt | 会写 Prompt | Fork "代码审查员" → 改成 "Go 代码审查员" |
| L3 创建者 | 从零创建自定义智能体 | 理解 Prompt 工程 | 创建 "用户故事生成器" |
| L4 能力扩展者 | 接入新的 MCP 工具 | 技术能力 | 接入 Jira MCP → 创建 "Sprint 规划师" |
| L5 Agent 开发者 | 开发新的内置 Agent | 全栈开发 | 开发 Report Agent → 自动生成周报 |

### 3.3 推动共创的具体措施

#### 措施 1: "百宝箱创意征集" 活动

- 收集团队成员的 Prompt 创意（不需要代码能力）
- 形式：共享文档 / 飞书表格，填写：
  - 智能体名称
  - 一句话描述
  - 系统提示词（Prompt）
  - 示例输入/输出
- 由开发者批量创建为内置工具

#### 措施 2: Prompt 模板库

提供结构化的 Prompt 模板，降低创建门槛：

```markdown
# 角色
你是一位 [专业领域] 专家。

## 技能
- [技能1]
- [技能2]

## 工作流程
1. [步骤1]
2. [步骤2]

## 限制
- [限制1]
- [限制2]

## 输出格式
[期望的输出格式]
```

#### 措施 3: "AI 优化" 按钮

`ToolEditor.tsx` 已有 "AI 优化" 按钮（L228），对接后可以：
- 用户写一句话描述 → AI 自动生成结构化 Prompt
- 大幅降低 Prompt 编写门槛

#### 措施 4: 智能体排行榜

在海鲜市场中展示：
- 热门智能体 TOP 10（按 usageCount）
- 最新上架
- Fork 最多
- 分类浏览（写作类 / 分析类 / 工具类 / ...）

#### 措施 5: 内置 Agent 扩展计划

当前内置了 8 个 Agent（4 定制版 + 4 普通版），建议优先扩展：

| 优先级 | 新 Agent | 场景 | 实现复杂度 |
|--------|---------|------|-----------|
| P0 | 会议纪要助手 | 输入会议录音/文字 → 生成结构化纪要 | 低（纯 Prompt） |
| P0 | 周报生成器 | 输入本周工作 → 生成周报 | 低（纯 Prompt） |
| P1 | SQL 助手 | 自然语言 → SQL 查询 | 中（需要 schema 上下文） |
| P1 | API 文档生成器 | 输入代码/接口 → 生成 API 文档 | 中（需要代码解析） |
| P2 | Sprint 规划师 | 需求列表 → 排期建议 | 高（需要项目管理上下文） |
| P2 | 竞品分析师 | 输入产品名 → 竞品对比报告 | 高（需要联网搜索） |

---

## 四、技术实现要点

### 4.1 自定义 Agent 数据模型

```csharp
// 新增 MongoDB 集合: toolbox_items
public class ToolboxItem : IMarketplaceItem, IForkable
{
    public string Id { get; set; }
    public string Name { get; set; }
    public string Description { get; set; }
    public string Icon { get; set; }           // Lucide 图标名
    public string Type { get; set; }            // "custom"
    public string Category { get; set; }        // "custom"
    public string[] Tags { get; set; }

    // 核心配置
    public string SystemPrompt { get; set; }    // 系统提示词
    public string WelcomeMessage { get; set; }  // 开场白
    public string[] ConversationStarters { get; set; } // 引导问题
    public string[] EnabledTools { get; set; }  // 启用的能力工具
    public double Temperature { get; set; }     // 创造性参数
    public bool EnableMemory { get; set; }      // 长期记忆

    // 统计
    public int UsageCount { get; set; }

    // 归属
    public string CreatedByUserId { get; set; }
    public string CreatedByName { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }

    // IMarketplaceItem
    public string OwnerUserId { get; set; }
    public bool IsPublic { get; set; }
    public int ForkCount { get; set; }
    public string? ForkedFromId { get; set; }
    public string? ForkedFromOwnerName { get; set; }
    public string? ForkedFromOwnerAvatar { get; set; }

    // IForkable
    public string[] GetCopyableFields() => new[]
    {
        "Name", "Description", "Icon", "Tags",
        "SystemPrompt", "WelcomeMessage", "ConversationStarters",
        "EnabledTools", "Temperature", "EnableMemory"
    };

    public string GetConfigType() => "agent";
    public string GetDisplayName() => Name;
    public void OnForked() => Name = $"{Name} (副本)";
}
```

### 4.2 海鲜市场类型注册

```typescript
// prd-admin/src/lib/marketplaceTypes.tsx 新增
agent: {
  key: 'agent',
  label: '智能体',
  icon: Bot,
  color: {
    bg: 'rgba(99, 102, 241, 0.12)',
    text: 'rgba(99, 102, 241, 0.95)',
    border: 'rgba(99, 102, 241, 0.25)',
  },
  api: {
    listMarketplace: listAgentsMarketplace,
    publish: publishAgent,
    unpublish: unpublishAgent,
    fork: forkAgent,
  },
  getDisplayName: (item) => item.name,
  PreviewRenderer: AgentPreview,  // 展示图标 + 描述 + 标签
},
```

### 4.3 普通版 Agent 对话调用链

```
ToolDetail.tsx handleSend()
  → POST /api/ai-toolbox/chat
    body: { message, agentKey, attachmentIds? }
  → AiToolboxController.Chat()
    → 对于自定义 Agent:
        构建 messages = [{ role: "system", content: item.SystemPrompt }, ...]
        调用 ILlmGateway.StreamAsync(request)
    → 对于内置普通版 Agent:
        使用预定义的 systemPrompt
        调用对应的 AgentAdapter 或直接调 LLM Gateway
  → SSE 流式返回
  → ToolDetail.tsx 实时渲染
```

---

## 五、总结

| 维度 | 当前状态 | 目标状态 | 所需工作量 |
|------|---------|---------|-----------|
| 核心体验 | 4/8 Agent 可用，基础能力全 Mock | 全部 Agent 真实运行 | ~1 周 |
| 自定义创建 | 前端完整，后端空缺 | 端到端可用 | ~3 天 |
| 共创生态 | 海鲜市场仅 3 类型 | 智能体可发布/Fork | ~1 周 |
| 高级功能 | 未开始 | 按 Phase 2-5 逐步推进 | 长期 |

**一句话**: MVP 骨架已搭好，差的是"接真实 API"和"打通共创链路"两件事。先把 Mock 全换成真实调用，再开放市场让团队共创。
