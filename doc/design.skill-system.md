# 技能体系设计：从提示词到技能的演进

> **版本**: v1.0
> **日期**: 2026-02-08
> **状态**: 设计草案
> **关联**: `design.multi-doc-and-citations.md` (多文档 + 引用重设计)

---

## 1. 为什么要从提示词过渡到技能

### 1.1 当前提示词体系的局限

现有系统的核心单元是 **PromptEntry**：

```
PromptEntry {
  promptKey: "legacy-prompt-1-pm"
  role: PM                         ← 锁死角色
  title: "项目背景与问题定义"
  promptTemplate: "请从以下维度..."   ← 一段纯文本
}
```

用户点击按钮 → 后端把 `promptTemplate` 注入 system prompt + user message → 调 LLM → 流式返回。

**本质问题**：

| 问题 | 说明 |
|------|------|
| **单步执行** | 一个提示词 = 一次 LLM 调用，无法编排多步任务 |
| **角色锁定** | PM/DEV/QA 各 6 个提示词，硬编码在角色上，不能跨角色复用 |
| **上下文盲目** | 提示词不知道需要哪些文档，总是注入整个 PRD（即将到来的多文档场景更加失控） |
| **无输出定义** | 提示词不声明输出是什么（Markdown 文档？清单？分析报告？），后端无法结构化处理 |
| **不可组合** | 提示词之间没有依赖关系，无法 "先做 A 再做 B" |
| **用户只能选，不能建** | 管理员配好 18 个提示词，用户只能点按钮，不能创建自己的工作流 |

### 1.2 技能是什么

**技能 = 提示词 + 上下文声明 + 输出定义 + 可选的多步编排**

```
提示词:  "帮我分析需求背景"          → 一段文字指令
技能:    "需求背景分析"              → 一个可执行的能力单元
         - 需要什么文档: PRD (必须)
         - 产出什么: 结构化分析报告
         - 谁能用: PM, DEV, QA
         - 怎么执行: 1 步 LLM 调用（简单技能）
                     或 N 步编排（复合技能）
```

**关键转变**：

```
旧心智模型:  用户 → 选提示词 → 问 AI
新心智模型:  用户 → 使用技能 → AI 执行任务 → 产出成果物
```

用户不再是"选一段提示词来指导 AI 回答"，而是"使用一个技能让 AI 帮我完成一项工作"。

### 1.3 技能与多文档的天然结合

多文档设计（`design.multi-doc-and-citations.md`）解决的是"群组可以绑定多个文档"。但一个关键问题没有回答：**AI 怎么知道当前任务需要哪些文档？**

现状：每次对话都把**全部文档**塞进上下文（token 浪费，噪声干扰）。

技能体系的回答：**每个技能声明自己需要哪些文档类型**。

```
技能: "生成测试用例"
  上下文需求:
    - PRD (必须)    → 注入
    - TECH (可选)   → 有就注入，没有跳过
    - TEST (排除)   → 这就是我要生成的，别注入旧的
```

这样 ChatService 在执行技能时，不是盲目注入全部文档，而是按技能声明精准选择。

---

## 2. 数据模型

### 2.1 核心模型: Skill

```csharp
/// <summary>技能定义</summary>
public class Skill
{
    public string Id { get; set; } = ObjectId.GenerateNewId().ToString();

    /// <summary>技能标识 (如 "prd-background-analysis")</summary>
    public string Key { get; set; } = string.Empty;

    /// <summary>显示名称</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>描述（给用户看的一句话说明）</summary>
    public string Description { get; set; } = string.Empty;

    /// <summary>图标 (lucide icon name)</summary>
    public string? Icon { get; set; }

    /// <summary>分类标签</summary>
    public string Category { get; set; } = "general";

    // ── 访问控制 ──

    /// <summary>允许使用的角色（空 = 所有角色可用）</summary>
    public List<string> AllowedRoles { get; set; } = new();

    // ── 上下文声明 ──

    /// <summary>技能需要的文档上下文</summary>
    public List<SkillContextSlot> ContextSlots { get; set; } = new();

    // ── 执行定义 ──

    /// <summary>执行步骤（单步技能只有 1 个 step）</summary>
    public List<SkillStep> Steps { get; set; } = new();

    // ── 输出定义 ──

    /// <summary>输出类型</summary>
    public SkillOutputType OutputType { get; set; } = SkillOutputType.Chat;

    // ── 元数据 ──

    public string? CreatedByUserId { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public int Version { get; set; } = 1;
    public bool IsBuiltIn { get; set; }

    // ── 市场相关 (IMarketplaceItem) ──

    public bool IsPublic { get; set; }
    public int ForkCount { get; set; }
    public string? ForkedFromId { get; set; }
}
```

### 2.2 上下文槽位: SkillContextSlot

```csharp
/// <summary>技能需要的文档上下文槽位</summary>
public class SkillContextSlot
{
    /// <summary>文档标签匹配 (如 "PRD", "TECH", "TEST")</summary>
    public string Label { get; set; } = "PRD";

    /// <summary>是否必须（群组没有此标签文档时，技能不可用）</summary>
    public bool Required { get; set; } = true;

    /// <summary>注入策略</summary>
    public ContextInjection Injection { get; set; } = ContextInjection.Full;

    /// <summary>
    /// 最大 token 预算（0 = 不限，由全局预算兜底）
    /// 某些技能只需要文档摘要，不需要全文
    /// </summary>
    public int MaxTokens { get; set; }
}

public enum ContextInjection
{
    Full,       // 注入完整文档
    Summary,    // 只注入标题 + 摘要（省 token）
    Headings,   // 只注入标题结构（最省 token）
    Exclude     // 显式排除（如"生成测试用例"时排除旧的 TEST 文档）
}
```

### 2.3 执行步骤: SkillStep

```csharp
/// <summary>技能执行步骤</summary>
public class SkillStep
{
    public int Order { get; set; }
    public string Name { get; set; } = string.Empty;

    /// <summary>步骤类型</summary>
    public StepKind Kind { get; set; } = StepKind.LlmCall;

    /// <summary>
    /// 系统提示词模板
    /// 支持变量: {role}, {documents}, {prev_output}
    /// </summary>
    public string SystemPromptTemplate { get; set; } = string.Empty;

    /// <summary>
    /// 用户消息模板（追加到用户实际输入后面）
    /// 支持变量: {user_input}, {prev_output}
    /// </summary>
    public string UserPromptTemplate { get; set; } = string.Empty;

    /// <summary>LLM 模型类型偏好 (如 "chat", "reasoning")</summary>
    public string? PreferredModelType { get; set; }
}

public enum StepKind
{
    LlmCall,     // 调用 LLM（最常见）
    DocGenerate, // 调用 LLM 并将输出保存为新文档
    // 未来可扩展: Validation, HttpCall, Transform 等
}
```

### 2.4 输出类型

```csharp
public enum SkillOutputType
{
    /// <summary>普通对话回复（与当前提示词行为一致）</summary>
    Chat,

    /// <summary>生成新文档并自动绑定到群组</summary>
    Document,

    /// <summary>结构化清单（如测试用例列表、缺陷清单）</summary>
    Checklist,

    /// <summary>对比分析报告（多文档对比场景）</summary>
    Analysis
}
```

### 2.5 与现有模型的关系

```
  PromptEntry (现有，废弃路径)
       │
       │  1:1 迁移
       ▼
     Skill (新)
       │
       ├── ContextSlots[]  → 关联 GroupDocument (多文档设计)
       │       ▲
       │       │ Label 匹配
       │       │
       │   GroupDocument.Label ("PRD"/"TECH"/"TEST")
       │
       ├── Steps[]  → 执行定义
       │
       └── OutputType  → Chat / Document / Checklist / Analysis
                              │
                              ▼
                        新文档 → GroupDocument (AiGenerated)
```

---

## 3. 技能分类与内置技能

### 3.1 分类体系

```
技能分类:
├── 📋 需求分析 (requirement-analysis)
│   ├── 需求背景分析
│   ├── 用户场景梳理
│   ├── 功能清单提取
│   └── 需求完整性检测 (Gap Detection 的技能化)
│
├── 🏗️ 技术设计 (technical-design)
│   ├── 技术方案概述
│   ├── 数据模型设计
│   ├── 接口清单生成
│   └── 架构风险评估
│
├── 🧪 测试规划 (test-planning)
│   ├── 测试用例生成 → OutputType: Document
│   ├── 边界条件分析
│   ├── 验收标准明细
│   └── 风险点汇总
│
├── 📄 文档生成 (doc-generation)
│   ├── 生成技术设计文档 → OutputType: Document
│   ├── 生成测试文档 → OutputType: Document
│   ├── 生成 API 文档 → OutputType: Document
│   └── 生成会议纪要 → OutputType: Document
│
├── 🔍 交叉分析 (cross-analysis) ← 多文档技能
│   ├── PRD vs 技术方案一致性检查
│   ├── 需求覆盖度分析 (PRD ↔ TEST)
│   ├── 多版本差异对比
│   └── 跨文档冲突检测
│
└── 🛠️ 通用 (general)
    ├── 自由提问 (默认技能，无 context 限制)
    └── 内容总结
```

### 3.2 内置技能示例

#### 示例 1: 单步技能（对应现有提示词）

```json
{
  "key": "requirement-background",
  "title": "需求背景分析",
  "description": "从商业价值和用户痛点角度分析 PRD 的项目背景",
  "category": "requirement-analysis",
  "icon": "FileSearch",
  "allowedRoles": [],
  "contextSlots": [
    { "label": "PRD", "required": true, "injection": "Full" }
  ],
  "steps": [
    {
      "order": 1,
      "name": "分析背景",
      "kind": "LlmCall",
      "systemPromptTemplate": "你是一位资深产品经理，擅长从商业角度分析需求文档...",
      "userPromptTemplate": "请分析这份 PRD 的项目背景，从以下维度展开：\n1. 核心业务问题...\n2. 目标用户群体...\n3. 商业价值主张..."
    }
  ],
  "outputType": "Chat",
  "isBuiltIn": true
}
```

**关键**：这就是现有 PromptEntry 的等价物，只是结构更丰富。迁移成本几乎为零。

#### 示例 2: 多文档技能（新能力）

```json
{
  "key": "prd-tech-consistency",
  "title": "需求-技术一致性检查",
  "description": "对比 PRD 和技术方案，找出遗漏和矛盾",
  "category": "cross-analysis",
  "icon": "GitCompare",
  "allowedRoles": [],
  "contextSlots": [
    { "label": "PRD", "required": true, "injection": "Full" },
    { "label": "TECH", "required": true, "injection": "Full" }
  ],
  "steps": [
    {
      "order": 1,
      "name": "一致性检查",
      "kind": "LlmCall",
      "systemPromptTemplate": "你是一位技术评审专家。你将收到两份文档：一份产品需求文档 (PRD) 和一份技术设计文档 (TECH)。请从以下维度进行对比分析...",
      "userPromptTemplate": "请对比分析这两份文档，输出：\n## 一致的部分\n## 矛盾点\n## PRD 有但技术方案遗漏的\n## 技术方案有但 PRD 未提及的"
    }
  ],
  "outputType": "Analysis",
  "isBuiltIn": true
}
```

**关键**：这个技能需要 PRD + TECH 两个文档。如果群组只绑了 PRD，此技能灰显不可用，提示"需要添加技术方案文档"。

#### 示例 3: 文档生成技能（多步 + 产出文档）

```json
{
  "key": "generate-test-doc",
  "title": "生成测试用例文档",
  "description": "基于 PRD 和技术方案生成完整的测试用例文档",
  "category": "doc-generation",
  "icon": "FlaskConical",
  "allowedRoles": [],
  "contextSlots": [
    { "label": "PRD", "required": true, "injection": "Full" },
    { "label": "TECH", "required": false, "injection": "Full" },
    { "label": "TEST", "required": false, "injection": "Exclude" }
  ],
  "steps": [
    {
      "order": 1,
      "name": "提取测试点",
      "kind": "LlmCall",
      "systemPromptTemplate": "你是一位 QA 专家...",
      "userPromptTemplate": "从 PRD 中提取所有可测试的功能点，每个功能点列出：功能名称、前置条件、预期行为、边界条件"
    },
    {
      "order": 2,
      "name": "生成测试文档",
      "kind": "DocGenerate",
      "systemPromptTemplate": "基于测试点列表，生成标准格式的测试用例文档...",
      "userPromptTemplate": "请将以下测试点展开为完整的测试用例文档，包含：\n- 测试用例编号\n- 测试场景\n- 操作步骤\n- 预期结果\n- 优先级\n\n测试点：\n{prev_output}"
    }
  ],
  "outputType": "Document",
  "isBuiltIn": true
}
```

**关键**：Step 2 的 `kind: DocGenerate` 表示这步的输出会自动保存为新文档并绑定到群组。用户执行完这个技能后，群组多了一份 TEST 文档。

---

## 4. 执行引擎设计

### 4.1 SkillExecutor

```csharp
public class SkillExecutor
{
    private readonly ILlmGateway _gateway;
    private readonly IDocumentService _documentService;
    private readonly IGroupService _groupService;

    /// <summary>执行技能</summary>
    public async IAsyncEnumerable<SkillEvent> ExecuteAsync(
        SkillExecutionContext ctx,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        var skill = ctx.Skill;
        var group = ctx.Group;

        // 1. 解析上下文：按技能声明选择文档
        var contextDocs = ResolveContext(skill.ContextSlots, group.Documents);

        // 检查必须的上下文是否满足
        var missing = skill.ContextSlots
            .Where(s => s.Required)
            .Where(s => !contextDocs.Any(d => d.Label == s.Label))
            .ToList();

        if (missing.Any())
        {
            yield return new SkillEvent.Error(
                $"缺少必要文档: {string.Join(", ", missing.Select(m => m.Label))}");
            yield break;
        }

        // 2. 逐步执行
        string? prevOutput = null;

        foreach (var step in skill.Steps.OrderBy(s => s.Order))
        {
            yield return new SkillEvent.StepStarted(step.Order, step.Name);

            // 组装 LLM 消息
            var messages = BuildMessages(step, ctx, contextDocs, prevOutput);

            // 执行 LLM 调用
            var output = new StringBuilder();
            var request = new GatewayRequest
            {
                AppCallerCode = $"prd-agent.skill.{skill.Key}::chat",
                ModelType = step.PreferredModelType ?? "chat",
                RequestBody = BuildRequestBody(messages)
            };

            await foreach (var chunk in _gateway.StreamAsync(request, CancellationToken.None))
            {
                output.Append(chunk.Content);
                yield return new SkillEvent.Delta(step.Order, chunk.Content);
            }

            prevOutput = output.ToString();

            // DocGenerate: 将输出保存为新文档
            if (step.Kind == StepKind.DocGenerate)
            {
                var doc = await _documentService.ParseAndSaveAsync(
                    prevOutput, $"{skill.Title} - {DateTime.UtcNow:yyyy-MM-dd}");

                await _groupService.AddDocumentAsync(group.Id, new GroupDocument
                {
                    DocumentId = doc.Id,
                    Label = InferLabel(skill),
                    Source = DocumentSource.AiGenerated,
                    TitleSnapshot = doc.Title,
                    TokenEstimate = doc.TokenEstimate,
                    BoundByUserId = ctx.UserId
                });

                yield return new SkillEvent.DocumentGenerated(doc.Id, doc.Title);
            }

            yield return new SkillEvent.StepCompleted(step.Order);
        }

        yield return new SkillEvent.Done();
    }

    /// <summary>按技能声明解析文档上下文</summary>
    private List<(GroupDocument Doc, ParsedPrd Content)> ResolveContext(
        List<SkillContextSlot> slots,
        List<GroupDocument> groupDocs)
    {
        var result = new List<(GroupDocument, ParsedPrd)>();

        foreach (var slot in slots.Where(s => s.Injection != ContextInjection.Exclude))
        {
            var gd = groupDocs.FirstOrDefault(d =>
                d.Label.Equals(slot.Label, StringComparison.OrdinalIgnoreCase));
            if (gd == null) continue;

            var doc = _documentService.GetByIdAsync(gd.DocumentId).Result;
            if (doc == null) continue;

            result.Add((gd, doc));
        }

        return result;
    }

    /// <summary>按注入策略构建文档内容</summary>
    private string BuildDocContent(ParsedPrd doc, ContextInjection injection)
    {
        return injection switch
        {
            ContextInjection.Full => doc.RawContent,
            ContextInjection.Summary => BuildSummary(doc),
            ContextInjection.Headings => BuildHeadingsOnly(doc),
            _ => string.Empty
        };
    }
}
```

### 4.2 与 ChatRunWorker 的集成

```csharp
// ChatRunWorker.cs 改造
private async Task ProcessRunAsync(ChatRun run)
{
    if (!string.IsNullOrEmpty(run.SkillId))
    {
        // 技能模式：通过 SkillExecutor 执行
        await ExecuteSkillRunAsync(run);
    }
    else if (!string.IsNullOrEmpty(run.PromptKey))
    {
        // 兼容模式：旧提示词流程（逐步废弃）
        await ExecuteLegacyPromptRunAsync(run);
    }
    else
    {
        // 自由对话：无技能/提示词，正常 Q&A
        await ExecuteFreeChat(run);
    }
}

private async Task ExecuteSkillRunAsync(ChatRun run)
{
    var skill = await _skillService.GetByIdAsync(run.SkillId);
    var group = await _groupService.GetByIdAsync(run.GroupId);

    var ctx = new SkillExecutionContext
    {
        Skill = skill,
        Group = group,
        UserInput = run.Content,
        UserId = run.UserId,
        SessionId = run.SessionId,
        Role = run.Role
    };

    // 流式执行，每个事件推送到 SSE
    await foreach (var evt in _skillExecutor.ExecuteAsync(ctx))
    {
        switch (evt)
        {
            case SkillEvent.Delta d:
                await PushSseAsync(run, "delta", d);
                break;
            case SkillEvent.StepStarted s:
                await PushSseAsync(run, "step_started", s);
                break;
            case SkillEvent.DocumentGenerated g:
                await PushSseAsync(run, "doc_generated", g);
                break;
            case SkillEvent.Done:
                await PushSseAsync(run, "done", null);
                break;
        }
    }
}
```

### 4.3 SSE 事件扩展

```typescript
// 前端 SSE 事件类型扩展
type SkillStreamEvent =
  | { type: 'step_started'; stepOrder: number; stepName: string }
  | { type: 'delta'; stepOrder: number; content: string }
  | { type: 'step_completed'; stepOrder: number }
  | { type: 'doc_generated'; documentId: string; title: string }
  | { type: 'done' }
  | { type: 'error'; message: string };
```

---

## 5. API 设计

### 5.1 技能管理

```
# 获取可用技能列表（按角色过滤）
GET /api/prd-agent/skills?role={role}&category={category}
Response: { skills: SkillSummary[] }

# 获取技能详情
GET /api/prd-agent/skills/{skillId}

# 创建技能（管理员）
POST /api/prd-agent/skills

# 更新技能
PUT /api/prd-agent/skills/{skillId}

# 删除技能
DELETE /api/prd-agent/skills/{skillId}
```

### 5.2 技能执行

```
# 创建技能执行 Run
POST /api/prd-agent/chat/runs
{
  "sessionId": "...",
  "content": "用户输入（可选）",
  "skillId": "generate-test-doc",      // 新字段
  "skillInputs": {                      // 技能参数（可选）
    "focusModules": ["登录", "注册"]
  }
  // 兼容: "promptKey": "legacy-prompt-1-pm"  旧字段仍可用
}
```

### 5.3 技能可用性查询

```
# 检查群组中哪些技能可用（基于已绑定的文档）
GET /api/prd-agent/groups/{groupId}/available-skills
Response: {
  available: [
    { skillId: "requirement-background", title: "需求背景分析", ready: true },
    { skillId: "generate-test-doc", title: "生成测试用例", ready: true },
    ...
  ],
  unavailable: [
    { skillId: "prd-tech-consistency", title: "需求-技术一致性检查",
      ready: false, missingDocs: ["TECH"] }
  ]
}
```

---

## 6. 前端交互设计

### 6.1 从提示词按钮到技能面板

**现状（提示词按钮）**：

```
┌─────────────────────────────────────────────┐
│  [项目背景] [用户场景] [解决方案] [功能清单] [迭代规划] [验收标准]  │
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │  输入消息...                        │    │
│  └─────────────────────────────────────┘    │
└─────────────────────────────────────────────┘
```

**新设计（技能选择器）**：

```
┌──────────────────────────────────────────────────────────┐
│  ┌─ 技能 ──────┐                                         │
│  │ 🔍 搜索技能  │                                         │
│  │              │                                         │
│  │ 📋 需求分析   │  ┌──────────────────────────────────┐  │
│  │  · 背景分析   │  │                                  │  │
│  │  · 场景梳理   │  │   需求背景分析                    │  │
│  │  · 功能提取   │  │                                  │  │
│  │  · 完整性检测 │  │   从商业价值和用户痛点角度        │  │
│  │              │  │   分析 PRD 的项目背景              │  │
│  │ 🏗️ 技术设计  │  │                                  │  │
│  │  · 方案概述   │  │   需要文档: PRD ✅                │  │
│  │  · 数据模型   │  │   输出类型: 对话回复              │  │
│  │              │  │                                  │  │
│  │ 🔍 交叉分析  │  │   [执行技能]                      │  │
│  │  · PRD↔TECH  │  │                                  │  │
│  │    ⚠️ 缺TECH │  └──────────────────────────────────┘  │
│  │              │                                         │
│  │ 📄 文档生成   │                                         │
│  │  · 测试文档 🆕│                                         │
│  │  · 技术文档   │                                         │
│  └──────────────┘                                         │
│                                                           │
│  ┌────────────────────────────────────────────────────┐   │
│  │  输入消息... (可附加技能上下文)                [发送] │   │
│  └────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

### 6.2 技能执行过程展示

多步技能执行时，显示进度：

```
┌──────────────────────────────────────────────┐
│  🤖 正在执行: 生成测试用例文档                  │
│                                              │
│  ✅ Step 1/2: 提取测试点                      │
│     已识别 24 个可测试功能点                    │
│                                              │
│  ⏳ Step 2/2: 生成测试文档                    │
│     ████████░░ 正在生成...                    │
│                                              │
│  预计产出: TEST 文档 (自动绑定到当前群组)       │
└──────────────────────────────────────────────┘
```

### 6.3 文档生成技能的闭环

```
用户点击 "生成测试用例文档"
    ↓
SkillExecutor Step 1: 提取测试点 (LLM)
    ↓  (流式回显中间结果)
SkillExecutor Step 2: 生成文档 (DocGenerate)
    ↓  (流式回显最终文档)
    ↓  (自动保存为新文档)
    ↓  (自动绑定到群组, label: "TEST")
    ↓
SSE: { type: "doc_generated", documentId: "xxx", title: "测试用例文档" }
    ↓
前端: 文档列表自动刷新，新增 TEST 文档
    ↓
后续对话: 技能"需求覆盖度分析" 现在可用了（因为同时有 PRD + TEST）
```

---

## 7. 提示词 → 技能迁移

### 7.1 迁移映射

现有 18 个 PromptEntry（PM/DEV/QA 各 6 个）转为内置技能：

| 现有 PromptKey | 新技能 Key | 角色变化 |
|---------------|-----------|---------|
| `legacy-prompt-1-pm` 项目背景 | `requirement-background` | PM → 全角色 |
| `legacy-prompt-2-pm` 用户场景 | `user-scenario-analysis` | PM → 全角色 |
| `legacy-prompt-3-pm` 解决方案 | `solution-overview` | PM → 全角色 |
| `legacy-prompt-4-pm` 功能清单 | `feature-extraction` | PM → 全角色 |
| `legacy-prompt-5-pm` 迭代规划 | `iteration-planning` | PM → PM, DEV |
| `legacy-prompt-6-pm` 验收标准 | `acceptance-criteria` | PM → 全角色 |
| `legacy-prompt-1-dev` 技术方案 | `tech-architecture` | DEV → DEV, QA |
| `legacy-prompt-2-dev` 数据模型 | `data-model-design` | DEV → DEV |
| `legacy-prompt-3-dev` 主流程 | `workflow-analysis` | DEV → 全角色 |
| `legacy-prompt-4-dev` 接口清单 | `api-specification` | DEV → DEV |
| `legacy-prompt-5-dev` 技术约束 | `tech-constraints` | DEV → DEV, QA |
| `legacy-prompt-6-dev` 开发要点 | `dev-breakdown` | DEV → DEV |
| `legacy-prompt-1-qa` 功能模块 | `test-coverage-map` | QA → QA |
| `legacy-prompt-2-qa` 业务流程 | `test-main-paths` | QA → 全角色 |
| `legacy-prompt-3-qa` 边界条件 | `boundary-analysis` | QA → QA, DEV |
| `legacy-prompt-4-qa` 异常场景 | `error-scenario-analysis` | QA → QA |
| `legacy-prompt-5-qa` 验收明细 | `acceptance-test-cases` | QA → QA |
| `legacy-prompt-6-qa` 测试风险 | `test-risk-assessment` | QA → QA, PM |

**关键变化**：很多技能不再锁死在一个角色上。"需求背景分析"对 PM/DEV/QA 都有价值。

### 7.2 向后兼容

```csharp
// ChatRunWorker: 双轨支持
if (run.SkillId != null)
{
    // 新路径: 技能执行
    await ExecuteSkillRunAsync(run);
}
else if (run.PromptKey != null)
{
    // 旧路径: 提示词兼容（内部转为等价技能执行）
    var skill = await _skillService.FindByLegacyPromptKeyAsync(run.PromptKey);
    if (skill != null)
    {
        run.SkillId = skill.Id;
        await ExecuteSkillRunAsync(run);
    }
    else
    {
        // 真的找不到对应技能，走旧逻辑
        await ExecuteLegacyPromptRunAsync(run);
    }
}
```

### 7.3 前端过渡

阶段 1：技能面板与提示词按钮并存
- 提示词按钮仍然可用（点击时内部转为 skillId）
- 新增技能面板入口

阶段 2：提示词按钮视觉迁移
- 提示词按钮换成技能卡片样式
- 仍在同一行展示（快捷入口）

阶段 3：完全切换
- 移除旧提示词按钮
- 技能面板成为唯一入口

---

## 8. 技能市场集成

技能天然适合海鲜市场（Marketplace）:

```typescript
// CONFIG_TYPE_REGISTRY 新增 skill 类型
skill: {
  key: 'skill',
  label: '技能',
  icon: Zap,
  color: {
    bg: 'rgba(168, 85, 247, 0.12)',
    text: 'rgba(168, 85, 247, 0.95)',
    border: 'rgba(168, 85, 247, 0.25)',
  },
  api: {
    listMarketplace: listSkillsMarketplace,
    publish: publishSkill,
    unpublish: unpublishSkill,
    fork: forkSkill,
  },
  getDisplayName: (item) => item.title,
  PreviewRenderer: SkillPreview,
}
```

```typescript
// SkillPreview 组件
const SkillPreview: FC<{ item: Skill }> = ({ item }) => (
  <div className="space-y-2">
    <div className="flex items-center gap-2">
      <Badge>{item.category}</Badge>
      <span className="text-xs text-muted">{item.steps.length} 步骤</span>
    </div>
    <p className="text-sm">{item.description}</p>
    <div className="flex gap-1">
      {item.contextSlots.map(s => (
        <Badge key={s.label} variant={s.required ? 'default' : 'outline'}>
          {s.label}
        </Badge>
      ))}
    </div>
  </div>
);
```

用户可以：
- 浏览公开技能
- Fork 别人的技能到自己的空间
- 修改后发布到市场

---

## 9. 实施路线

### Phase 1: 基础模型 + 迁移（3-4 天）

```
后端:
  - Skill 模型定义 (MongoDB: skills 集合)
  - SkillService: CRUD + 按角色查询
  - PromptEntry → Skill 迁移脚本
  - ChatRunWorker: skillId 字段支持 + 双轨分发
  - SkillExecutor: 单步执行（等价于现有提示词行为）
  - GET /api/prd-agent/skills 接口

前端:
  - 技能选择面板组件 (SkillPicker)
  - ChatInput 集成: 点击技能 → 发送 skillId
  - 提示词按钮保留（内部映射到 skillId）
```

**Phase 1 结束后**：用户体验上和现在几乎一样（还是点按钮），但底层已经是技能体系。

### Phase 2: 多文档感知 + 可用性（2-3 天）

```
依赖: design.multi-doc-and-citations.md Phase 1 (多文档数据层)

后端:
  - SkillContextSlot 解析逻辑
  - GET /groups/{id}/available-skills 接口
  - SkillExecutor: 按 ContextSlot 选择性注入文档

前端:
  - 技能可用性标记 (✅ 可用 / ⚠️ 缺文档)
  - 技能详情面板: 显示所需文档 + 已满足情况
  - "缺少文档"引导: 点击跳转到文档管理
```

### Phase 3: 多步执行 + 文档生成（3-4 天）

```
后端:
  - SkillExecutor: 多步执行 + prev_output 传递
  - StepKind.DocGenerate: 输出保存为文档 + 自动绑定
  - SSE 事件扩展: step_started / step_completed / doc_generated

前端:
  - 多步执行进度 UI
  - 文档生成完成后自动刷新文档列表
  - "新增技能"触发机制: 新文档解锁新技能的提示
```

### Phase 4: 市场 + 自定义（2-3 天）

```
后端:
  - Skill 实现 IForkable 接口
  - 市场 API: publish / unpublish / fork

前端:
  - CONFIG_TYPE_REGISTRY 注册 skill 类型
  - SkillPreview 渲染器
  - 技能编辑器 (SkillEditor): 管理员可创建/修改技能
```

---

## 10. MongoDB 集合变更

```
新增:
  skills              # 技能定义

修改:
  messages            # run 中新增 skillId 字段 (可选)

逐步废弃:
  prompts             # PromptEntry 数据迁移到 skills 后，仅保留兜底
  prompt_stages       # 废弃（如果存在独立集合的话）

不变:
  groups              # Documents[] 由多文档设计负责
  sessions            # 无变更
```

---

## 11. 对比总结

| 维度 | 提示词体系 | 技能体系 |
|------|-----------|---------|
| **核心单元** | PromptEntry (文本模板) | Skill (可执行能力) |
| **角色** | 锁定单角色 | 可跨角色 |
| **文档感知** | 无（盲注入全部） | 声明式（按需注入） |
| **执行模型** | 单次 LLM 调用 | 单步或多步编排 |
| **输出** | 纯文本流 | 文本 / 文档 / 清单 / 分析报告 |
| **可组合** | 不可以 | 步骤间 prev_output 传递 |
| **用户自定义** | 只有管理员能配 | 用户可 Fork + 修改 |
| **市场** | 无（LiteraryPrompt 有，但不通用） | 完整市场支持 |
| **多文档** | 不支持 | 天然支持（ContextSlot） |
| **向后兼容** | - | promptKey → skillId 自动映射 |
