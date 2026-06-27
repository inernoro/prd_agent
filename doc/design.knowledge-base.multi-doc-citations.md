# 多文档上下文 + 引用系统重 · 设计

> **版本**：v1.0 | **日期**：2026-02-06 | **状态**：规划中
>
> **关联**：`design.im-architecture-v2.md` (WebSocket + 多槽位方案)

## 一、管理摘要

- **解决什么问题**：对话系统只能绑定单个 PRD 文档，且引用基于关键词匹配不准确、不持久化，历史消息引用丢失
- **方案概述**：支持群组绑定多文档（含 Token 预算管理），引用系统改为 LLM 原生标注 + 后端验证 + 持久化存储
- **业务价值**：多文档上下文让 AI 回答更全面准确，引用持久化让历史消息的引用永久可见且可信度更高
- **影响范围**：prd-api ChatService/GroupService、prd-admin 对话页面、prd-desktop 文档面板
- **预计风险**：中 — 涉及核心对话链路改造，需数据迁移和兜底机制保障兼容

---

## 目录

1. [多文档上下文注入](#1-多文档上下文注入)
2. [引用系统重设计](#2-引用系统重设计)
3. [数据模型变更](#3-数据模型变更)
4. [实施计划](#4-实施计划)

---

## 1. 多文档上下文注入

### 1.1 当前瓶颈

5 个单文档锁定点：

```
Group.PrdDocumentId        → string (单值)
Session.DocumentId         → string (单值)
ChatService line 104       → GetByIdAsync(session.DocumentId) 取 1 个文档
ChatService line 202       → BuildPrdContextMessage(document.RawContent) 注入 1 个文档
GroupService.BindPrdAsync  → 替换而非追加
```

ChatService 中 LLM 消息组装：

```
messages[0] = system prompt (角色指令)
messages[1] = "[[CONTEXT:PRD]]\n<PRD>\n{整个文档 RawContent}\n</PRD>\n[[/CONTEXT:PRD]]"  ← 只有 1 个文档
messages[2..N] = 聊天历史 (最多 20 条)
messages[N+1] = 当前用户输入
```

### 1.2 新数据模型

```csharp
// ━━━ Group.cs ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
public class Group
{
    // 废弃（保留字段但不再使用，迁移时自动转入 Documents[0]）
    [Obsolete("Use Documents instead")]
    public string PrdDocumentId { get; set; } = string.Empty;

    // 新增：多文档绑定列表
    public List<GroupDocument> Documents { get; set; } = new();
}

/// <summary>群组文档绑定记录</summary>
public class GroupDocument
{
    public string DocumentId { get; set; } = string.Empty;

    /// <summary>文档来源类型</summary>
    public DocumentSource Source { get; set; } = DocumentSource.Upload;

    /// <summary>在上下文中的角色标签 (用于 LLM 上下文标记)</summary>
    public string Label { get; set; } = "PRD";

    /// <summary>文档标题快照</summary>
    public string? TitleSnapshot { get; set; }

    /// <summary>Token 估算</summary>
    public int? TokenEstimate { get; set; }

    /// <summary>字符数</summary>
    public int? CharCount { get; set; }

    /// <summary>绑定时间</summary>
    public DateTime BoundAt { get; set; } = DateTime.UtcNow;

    /// <summary>绑定人</summary>
    public string? BoundByUserId { get; set; }

    /// <summary>排序权重（越小越靠前注入）</summary>
    public int Order { get; set; }
}

public enum DocumentSource
{
    Upload,       // 用户上传
    AiGenerated,  // AI 生成
    Forked,       // 从市场 Fork
    Linked        // 引用其他群组的文档
}
```

### 1.3 LLM 上下文注入策略

```csharp
// ━━━ ChatService.cs 改造 ━━━━━━━━━━━━━━━━━━━━
// 从:
//   var document = await _documentService.GetByIdAsync(session.DocumentId);
//   messages.Add(BuildPrdContextMessage(document.RawContent));
//
// 改为:

// 1. 获取群组的全部文档绑定
var group = await _groupService.GetByIdAsync(session.GroupId);
var groupDocs = group.Documents.OrderBy(d => d.Order).ToList();

// 2. Token 预算管理
var tokenBudget = _modelConfig.MaxContextTokens - systemPromptTokens - historyTokens - userMessageTokens - reserveTokens;

// 3. 按优先级注入文档
var contextMessages = new List<LLMMessage>();
var totalTokens = 0;

foreach (var gd in groupDocs)
{
    if (totalTokens >= tokenBudget) break;

    var doc = await _documentService.GetByIdAsync(gd.DocumentId);
    if (doc == null) continue;

    var docTokens = doc.TokenEstimate;
    if (totalTokens + docTokens > tokenBudget)
    {
        // 超出预算：尝试截断或跳过
        // 策略：大文档截断到可用预算，小文档跳过
        if (docTokens > tokenBudget * 0.5)
        {
            doc = TruncateDocument(doc, tokenBudget - totalTokens);
            docTokens = tokenBudget - totalTokens;
        }
        else
        {
            continue; // 跳过这个小文档，看后面是否有更小的能塞下
        }
    }

    contextMessages.Add(new LLMMessage
    {
        Role = "user",
        Content = BuildMultiDocContextMessage(doc.RawContent, gd.Label, gd.TitleSnapshot)
    });
    totalTokens += docTokens;
}
```

**多文档上下文标记格式**：

```csharp
public string BuildMultiDocContextMessage(string content, string label, string? title)
{
    // 每个文档用独立的 CONTEXT 标签区分
    // label 用于告诉 LLM 这个文档的角色
    var header = string.IsNullOrEmpty(title) ? label : $"{label}: {title}";
    return $"[[CONTEXT:{label}]]\n<document title=\"{header}\">\n{content}\n</document>\n[[/CONTEXT:{label}]]";
}
```

LLM 收到的消息结构变为：

```
messages[0] = system prompt (角色指令 + 引用格式说明)
messages[1] = [[CONTEXT:PRD]] <document title="PRD: 用户登录模块需求规格说明"> ... </document>
messages[2] = [[CONTEXT:TECH]] <document title="TECH: 后端技术方案 v2.1"> ... </document>
messages[3] = [[CONTEXT:TEST]] <document title="TEST: 登录模块测试用例集"> ... </document>
messages[4..N] = 聊天历史
messages[N+1] = 当前用户输入
```

### 1.4 前端交互设计

```
┌─────────────────────────────────────────────────────┐
│  群组: 用户登录模块                          [+ 文档] │
│                                                     │
│  📄 PRD: 用户登录模块需求规格说明   12,340 tokens  ✕  │
│  📄 TECH: 后端技术方案 v2.1        8,200 tokens   ✕  │
│  📄 TEST: 登录模块测试用例集        5,100 tokens   ✕  │
│  🤖 AI: 接口对比分析报告 (AI生成)    3,200 tokens   ✕  │
│                                                     │
│  Token 用量: 28,840 / 128,000 ██████░░░░ 23%       │
│                                                     │
│  ──── 对话区域 ────────────────────────────────────  │
│  ...                                                │
└─────────────────────────────────────────────────────┘
```

**核心交互**：

| 操作 | 行为 |
|------|------|
| `[+ 文档]` | 打开文档选择器：上传新文件 / 从已有文档列表选择 / AI 生成 |
| 拖拽排序 | 调整文档注入优先级（Order 字段） |
| ✕ 按钮 | 解绑文档（不删除文档本身） |
| Token 进度条 | 实时显示所有文档 + 历史消息的 token 占用 |
| 文档标签 | 点击展开预览面板 |

**AI 生成文档流**：

```
用户: "帮我基于 PRD 生成一份测试用例文档"
  → AI 生成 Markdown 内容
  → 后端: DocumentService.ParseAsync(content) → 保存到 MongoDB
  → 后端: GroupService.AddDocumentAsync(groupId, documentId, label: "TEST", source: AiGenerated)
  → 前端: 文档列表自动刷新，新文档出现
  → 后续对话自动包含新文档上下文
```

### 1.5 API 设计

```csharp
// ━━━ 文档绑定管理 (GroupsController) ━━━━━━━━━━

// 添加文档到群组
[HttpPost("{groupId}/documents")]
public async Task<IActionResult> AddDocument(string groupId, AddGroupDocumentRequest request)
// request: { documentId, label?, order? }
// 或: { content, fileName, label? } → 自动上传 + 绑定

// 移除文档
[HttpDelete("{groupId}/documents/{documentId}")]
public async Task<IActionResult> RemoveDocument(string groupId, string documentId)

// 调整顺序/标签
[HttpPatch("{groupId}/documents/{documentId}")]
public async Task<IActionResult> UpdateDocument(string groupId, string documentId, UpdateGroupDocumentRequest request)
// request: { label?, order? }

// 查看群组文档列表
[HttpGet("{groupId}/documents")]
public async Task<IActionResult> ListDocuments(string groupId)
// response: { documents: GroupDocument[], totalTokens, tokenBudget }
```

### 1.6 数据迁移

```csharp
// 一次性迁移脚本：将旧 PrdDocumentId 转为 Documents[0]
db.groups.find({ PrdDocumentId: { $ne: "" }, Documents: { $size: 0 } }).forEach(g => {
    db.groups.updateOne({ _id: g._id }, {
        $set: {
            Documents: [{
                DocumentId: g.PrdDocumentId,
                Source: "Upload",
                Label: "PRD",
                TitleSnapshot: g.PrdTitleSnapshot,
                TokenEstimate: g.PrdTokenEstimateSnapshot,
                CharCount: g.PrdCharCountSnapshot,
                BoundAt: g.CreatedAt,
                BoundByUserId: g.OwnerId,
                Order: 0
            }]
        }
    });
});
```

---

## 2. 引用系统重设计

### 2.1 当前问题根因

**问题 1：引用不准确**

当前 `DocCitationExtractor`（411 行）是纯关键词匹配：
- CJK 整块匹配（无分词），英文 3+ 字母匹配
- `string.Contains` 逐段检查，无 TF-IDF、无语义理解
- 常见词（"系统"、"用户"、"功能"）匹配大量无关段落
- 打分公式 `min(6, keyword.Length) * 1.0` 过于简单

**问题 2：消息多时后面的引用不显示**

当前引用是**纯瞬态事件，不持久化**：
- `ChatService.cs:524` 注释："citation evidence... NOT persisted to DB"
- `citations` 事件的 `seq = 0`，不参与 afterSeq 回放
- `ChatContainer.tsx:102` 中 `findIndex` 找不到消息则静默丢弃
- 从 MongoDB 加载的历史消息**永远没有引用**
- 竞态：`citations` 事件可能先于 `messageUpdated` 到达

### 2.2 新引用架构：LLM 原生引用 + 持久化

**核心转变**：从"后端关键词匹配猜测引用"转为"LLM 直接生成结构化引用 + 后端验证 + 持久化"

```
当前流程:
  LLM → 生成纯文本回复 → 后端用关键词匹配猜引用 → 推送 SSE → 前端展示
  问题: 猜测不准，不持久化

新流程:
  LLM → 生成带引用标记的回复 → 后端解析 + 验证 + 持久化 → 推送 → 前端展示
  保障: LLM 自己标注引用源，后端验证准确性，存入 DB
```

### 2.3 System Prompt 引用指令

在系统提示词中添加引用格式要求：

```markdown
## 引用格式要求

当你引用参考文档中的内容时，必须使用以下标注格式：

【引用格式】：在引用的句子末尾添加 `[[cite:文档标签:章节标题]]`

示例：
- 用户登录需要支持手机号和邮箱两种方式 [[cite:PRD:3.1 登录功能]]
- 接口响应时间应控制在 200ms 以内 [[cite:TECH:4.2 性能要求]]
- 需要覆盖异常密码输入的测试场景 [[cite:TEST:TC-005 异常测试]]

规则：
1. 只引用确实来自文档的内容，不要虚构引用
2. 章节标题使用文档中的实际标题，不要缩写或改写
3. 每段引用内容标注一次即可，不需要重复标注相同来源
4. 如果综合了多个章节的信息，可以标注多个引用：
   [[cite:PRD:3.1 登录功能]][[cite:PRD:3.2 注册功能]]
5. 你的分析和推理不需要标注引用，只有直接引用文档事实时才标注
```

### 2.4 后端引用解析 + 验证 + 持久化

```csharp
// ━━━ 新增: CitationParser.cs ━━━━━━━━━━━━━━━━━━

public static class CitationParser
{
    // 解析 LLM 回复中的 [[cite:LABEL:HEADING]] 标记
    private static readonly Regex CitePattern = new(
        @"\[\[cite:(?<label>[^:]+):(?<heading>[^\]]+)\]\]",
        RegexOptions.Compiled);

    public static CitationParseResult Parse(
        string assistantText,
        List<GroupDocument> groupDocs,
        Dictionary<string, ParsedPrd> documents)
    {
        var matches = CitePattern.Matches(assistantText);
        var citations = new List<DocCitation>();
        var cleanText = assistantText; // 用于前端展示的清洁文本

        foreach (Match m in matches)
        {
            var label = m.Groups["label"].Value;
            var heading = m.Groups["heading"].Value.Trim();

            // 1. 找到对应的文档
            var gd = groupDocs.FirstOrDefault(d =>
                d.Label.Equals(label, StringComparison.OrdinalIgnoreCase));
            if (gd == null) continue;

            // 2. 在文档中验证章节存在
            if (!documents.TryGetValue(gd.DocumentId, out var doc)) continue;
            var section = FindSection(doc, heading);
            if (section == null) continue;

            // 3. 生成精确引用
            citations.Add(new DocCitation
            {
                DocumentId = gd.DocumentId,
                DocumentLabel = gd.Label,
                HeadingTitle = section.Title,
                HeadingId = GithubSlugger.Slug(section.Title),
                Excerpt = BuildExcerpt(section.Content, 200),
                Score = 1.0,  // LLM 直接引用 = 满分
                Rank = citations.Count + 1,
                Verified = true  // 后端已验证章节存在
            });
        }

        // 4. 清理引用标记（前端不展示原始标记）
        cleanText = CitePattern.Replace(cleanText, "");

        return new CitationParseResult
        {
            CleanContent = cleanText,
            Citations = citations.DistinctBy(c => c.HeadingId).ToList()
        };
    }

    private static Section? FindSection(ParsedPrd doc, string headingQuery)
    {
        // 精确匹配
        var exact = doc.Sections.FirstOrDefault(s =>
            s.Title.Equals(headingQuery, StringComparison.OrdinalIgnoreCase));
        if (exact != null) return exact;

        // 模糊匹配：章节编号 + 标题（如 "3.1 登录功能" 匹配 "3.1 用户登录功能需求"）
        var fuzzy = doc.Sections
            .Select(s => new { Section = s, Score = FuzzyMatch(s.Title, headingQuery) })
            .Where(x => x.Score > 0.6)
            .OrderByDescending(x => x.Score)
            .FirstOrDefault();

        return fuzzy?.Section;
    }
}
```

### 2.5 引用持久化

```csharp
// ━━━ Message.cs 变更 ━━━━━━━━━━━━━━━━━━━━
public class Message
{
    // 现有字段...

    // 新增：引用持久化
    public List<DocCitation> Citations { get; set; } = new();
}

// ━━━ ChatService.cs 变更 ━━━━━━━━━━━━━━━━
// 在 AI 回复完成后：
var parseResult = CitationParser.Parse(
    assistantMessage.Content,
    group.Documents,
    loadedDocuments);

// 1. 更新消息内容（去掉 [[cite:...]] 标记）
assistantMessage.Content = parseResult.CleanContent;

// 2. 持久化引用到消息
assistantMessage.Citations = parseResult.Citations;

// 3. 保存到 MongoDB（引用随消息一起存储）
await _messageRepository.UpdateAsync(assistantMessage);

// 4. 推送 messageUpdated（包含引用）
_groupMessageStreamHub.PublishUpdated(assistantMessage);  // Message 包含 Citations
```

### 2.6 引用数据模型升级

```csharp
public class DocCitation
{
    // 保留
    public string HeadingTitle { get; set; }
    public string HeadingId { get; set; }
    public string Excerpt { get; set; }
    public double? Score { get; set; }
    public int? Rank { get; set; }

    // 新增
    public string? DocumentId { get; set; }     // 来源文档 ID（多文档时必要）
    public string? DocumentLabel { get; set; }  // 来源文档标签（PRD/TECH/TEST）
    public bool Verified { get; set; }          // 后端是否已验证（LLM 引用=true，兜底匹配=false）
}
```

### 2.7 前端引用渲染改造

```typescript
// ━━━ MarkdownRenderer 变更 ━━━━━━━━━━━━━━━━━━

// 之前: LazyCitationMatcher 在前端做关键词匹配，猜测每个段落对应哪个引用
// 之后: 引用已经由 LLM 标注 + 后端解析，前端只需渲染

// 1. 引用直接从 message.citations 读取（已持久化）
// 2. 无需前端做 token overlap 匹配
// 3. 引用标记已在后端清除，前端展示 cleanContent

// 引用面板：从消息级别展示，而非段落级别匹配
const CitationPanel: FC<{ citations: DocCitation[] }> = ({ citations }) => (
  <div className="citation-panel">
    {citations.map((c, i) => (
      <div key={i} className="citation-item" onClick={() => navigateToSection(c)}>
        <span className="citation-badge">{c.documentLabel}</span>
        <span className="citation-title">{c.headingTitle}</span>
        <p className="citation-excerpt">{c.excerpt}</p>
      </div>
    ))}
  </div>
);

// 消息气泡底部显示引用
const MessageBubble: FC<{ message: Message }> = ({ message }) => (
  <div className="message-bubble">
    <MarkdownRenderer content={message.content} />
    {message.citations?.length > 0 && (
      <CitationPanel citations={message.citations} />
    )}
  </div>
);
```

### 2.8 兜底机制（Fallback）

LLM 可能不总是正确产出 `[[cite:...]]` 标记（格式错误、忘记标注等）。保留简化版的旧关键词匹配作为兜底：

```csharp
// ChatService.cs
var parseResult = CitationParser.Parse(content, groupDocs, documents);

if (parseResult.Citations.Count == 0)
{
    // LLM 没有产生任何结构化引用 → 降级到关键词匹配
    var fallbackCitations = DocCitationExtractor.Extract(primaryDoc, content, maxCitations: 6);
    foreach (var c in fallbackCitations)
        c.Verified = false;  // 标记为未验证
    parseResult.Citations = fallbackCitations;
}
```

前端可以用不同的视觉样式区分：
- `verified = true`：蓝色引用标签（LLM 直接标注，高可信度）
- `verified = false`：灰色引用标签（关键词匹配，低可信度）

### 2.9 对比

| 维度 | 旧系统 | 新系统 |
|------|--------|--------|
| **引用生成** | 后端关键词匹配 (411 行) | LLM 原生标注 + 后端验证 |
| **准确性** | 低（keyword overlap，无语义理解） | 高（LLM 理解上下文，后端验证章节存在） |
| **持久化** | 不持久化（SSE-only, seq=0） | 存入 Message.Citations（MongoDB） |
| **历史消息引用** | 不可能（历史消息无引用） | 永久可见（从 DB 加载） |
| **多文档引用** | 不支持（只匹配 1 个文档） | 支持（DocumentLabel 区分来源） |
| **前端匹配** | 前端二次关键词匹配（LazyCitationMatcher） | 无需匹配，直接渲染 |
| **消息积累问题** | 引用丢失（race condition + 不持久化） | 不存在（持久化 + 随消息加载） |
| **前端代码量** | ~500 行（MarkdownRenderer 匹配 + CitationChip + Highlighter） | ~100 行（纯渲染） |

---

## 3. 数据模型变更汇总

### 3.1 MongoDB 集合变更

| 集合 | 变更 |
|------|------|
| `groups` | 新增 `Documents: List<GroupDocument>` 字段 |
| `messages` | 新增 `Citations: List<DocCitation>` 字段 |
| `sessions` | `DocumentId` 标记为 deprecated（从 Group.Documents 解析主文档） |

### 3.2 新增接口

| 接口 | 方法 |
|------|------|
| `IGroupDocumentService` | `AddAsync`, `RemoveAsync`, `ReorderAsync`, `ListAsync`, `GetTokenBudgetAsync` |
| `ICitationParser` | `Parse(text, groupDocs, documents)` → `CitationParseResult` |

### 3.3 废弃/清理

| 文件 | 处理 |
|------|------|
| `DocCitationExtractor.cs` (411 行) | 降级为 fallback，大幅简化（保留 ~100 行） |
| `MarkdownRenderer.tsx` 中 `LazyCitationMatcher` | 删除 |
| `prdCitationHighlighter.ts` (284 行) | 简化（只保留基于 headingId 的定位，删除模糊匹配） |

---

## 4. 实施计划

### Phase 1: 多文档数据层（1 周）

```
Day 1-2:
  - GroupDocument model 定义
  - Group.Documents 字段添加
  - MongoDB 迁移脚本（PrdDocumentId → Documents[0]）
  - GroupsController 新增文档管理 API

Day 3-4:
  - ChatService 改造：多文档注入 + Token 预算
  - BuildMultiDocContextMessage 实现
  - 单元测试

Day 5:
  - 桌面端文档列表 UI
  - [+ 文档] 按钮 + 上传/选择交互
  - Token 用量进度条
```

### Phase 2: 引用系统重建（1 周）

```
Day 1-2:
  - System prompt 添加引用格式指令
  - CitationParser 实现（正则解析 + 章节验证）
  - Message.Citations 字段添加
  - ChatService 集成引用解析 + 持久化

Day 3-4:
  - 前端 CitationPanel 组件
  - 消息气泡引用展示
  - PRD 预览面板引用定位
  - 删除 LazyCitationMatcher 和旧的前端匹配逻辑

Day 5:
  - Fallback 机制（LLM 未产出引用时降级到关键词匹配）
  - 端到端测试
  - prd-admin 同步适配
```

### Phase 3: AI 文档生成（后续）

```
  - "帮我生成测试用例文档" → AI 生成 → 自动绑定到群组
  - 文档版本管理（同一文档多个版本）
  - 跨群组文档引用（Linked 类型）
```
