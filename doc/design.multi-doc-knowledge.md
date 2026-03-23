# 多文档知识库与文档类型系统 — 设计文档

> **版本**: v3.0
> **日期**: 2026-03-23
> **状态**: 已实现（含渐进式披露 Phase 2 + 文件上传与三阶段格式检测）
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

### 3.1 上下文组装流程

大白话解释：用户发一条消息，后端需要把"文档内容 + 聊天历史 + 当前消息"拼成一个完整的上下文给 LLM。问题是 LLM 的上下文窗口有限（通常 128K token），文档多了、聊天多了就会超。所以我们引入了"预算制"——把总预算切成三块，每块有上限，超了就降级处理。

```
用户发送消息
  │
  ▼
ChatService.SendMessageAsync()  [ChatService.cs:65]
  │
  ├─ 1. 加载文档
  │     session.GetAllDocumentIds() → 获取所有文档 ID
  │     foreach docId → documentService.GetByIdAsync() → 加载文档内容
  │
  ├─ 2. Token 预算分配  [ChatService.cs:211-213]
  │     总预算 = 100,000 tokens（留 ~28K 给模型输出）
  │     ┌───────────────────────────────────────┐
  │     │  文档区 60K  │  历史区 30K  │ 当前 10K  │
  │     └───────────────────────────────────────┘
  │
  ├─ 3. 文档上下文组装  [ChatService.cs:216-218]
  │     │
  │     ├─ 单文档: 走原逻辑，不做预算管控（向后兼容）
  │     │
  │     └─ 多文档: 调用带预算的新方法
  │         PromptManager.BuildMultiPrdContextMessage(docs, getDocType, 60000)
  │         │
  │         │  ┌────────────────────────────────────┐
  │         │  │ 第一步：给每个文档打优先级           │
  │         │  │   product (产品文档) → 优先级 0 最高  │
  │         │  │   technical/design  → 优先级 1       │
  │         │  │   reference (参考)  → 优先级 2 最低   │
  │         │  │                                      │
  │         │  │ 第二步：按优先级从高到低"花预算"       │
  │         │  │   预算够 → 全文注入                   │
  │         │  │   预算不够 → 摘要注入（目录+前文片段） │
  │         │  │                                      │
  │         │  │ 第三步：按原始顺序组装输出             │
  │         │  └────────────────────────────────────┘
  │         │
  │         ▼ 输出示例（3 个文档，第 3 个被摘要化）:
  │
  │     [[CONTEXT:PRD_BUNDLE]]
  │     <PRD index="1" title="需求文档" type="product">
  │     {完整 Markdown 内容}
  │     </PRD>
  │     <PRD index="2" title="技术方案" type="technical">
  │     {完整 Markdown 内容}
  │     </PRD>
  │     <PRD index="3" title="竞品分析" type="reference" mode="summary">
  │     # 竞品分析
  │     ## 章节目录
  │     - 概述
  │     - 竞品A 分析
  │     - 竞品B 分析
  │     ## 内容摘要（前文）
  │     {前 N 字符...}
  │     [...文档已截断，如需完整内容请针对本文档追问...]
  │     </PRD>
  │     [[/CONTEXT:PRD_BUNDLE]]
  │
  ├─ 4. 对话历史组装（动态窗口）  [ChatService.cs:226-247]
  │     │
  │     │  大白话：不再固定取最近 20 条，而是用 token 预算（30K）
  │     │  从最新消息往回数，能装多少装多少，装不下就丢掉更早的。
  │     │
  │     │  短对话（每条 200 token × 20 条 = 4K）→ 全部保留
  │     │  长对话（每条 2K token × 50 条 = 100K）→ 只保留最近 ~15 条
  │     │
  │     └─ 最终按时间顺序（旧→新）排列
  │
  └─ 5. 添加当前用户消息 → 组装完成 → 发给 LLM
```

**关键文件路径**:

| 文件 | 职责 |
|------|------|
| `PrdAgent.Core/Services/ChatService.cs:103-250` | 文档加载 + 预算分配 + 消息组装 |
| `PrdAgent.Core/Interfaces/IPromptManager.cs:19-30` | 接口定义（含新重载签名） |
| `PrdAgent.Infrastructure/Prompts/PromptManager.cs:102-125` | 原全量注入方法（单文档/无预算多文档） |
| `PrdAgent.Infrastructure/Prompts/PromptManager.cs:136-213` | 带预算的多文档组装（类型加权 + 摘要降级） |
| `PrdAgent.Infrastructure/Prompts/PromptManager.cs:217-260` | BuildDocumentSummary 摘要生成 |
| `PrdAgent.Infrastructure/Prompts/PromptManager.cs:264-268` | EstimateTokens 粗估方法 |
| `PrdAgent.Core/Services/DocCitationExtractor.cs:26-95` | 引用提取（仅主文档） |
| `PrdAgent.Core/Models/Session.cs:26-44` | 文档列表 + 类型查询 |

### 3.2 渐进式披露机制（已实现）

大白话解释：想象你有一张桌子（LLM 上下文窗口），桌面有限。你有 5 份文档要放上去，桌子放不下怎么办？

**答案**：最重要的文档放原版，不太重要的放缩印版（摘要），桌子就放得下了。

#### 3.2.1 预算分配策略

```
LLM 上下文窗口 ≈ 128K tokens
                    │
  ┌─────────────────┼─────────────────┐
  │                 │                 │
  ▼                 ▼                 ▼
文档区: 60K      历史区: 30K      剩余: 38K
(所有 PRD 文档)  (对话记录)      (系统提示词 + 当前消息 + 模型输出空间)
```

**为什么是 60/30 这个比例？**
- 文档是 AI 回答的"原材料"，必须优先保证
- 对话历史提供上下文连续性，但越旧越不重要
- 留给模型输出的空间不能太少，否则回答会被截断

#### 3.2.2 文档类型优先级

```
优先级 0（最高）: product    — 产品文档，对话的焦点，必须全文
优先级 1（中等）: technical  — 技术文档，用于可行性验证
                  design     — 设计文档，用于方案对照
优先级 2（最低）: reference  — 参考资料，锦上添花，预算不够就摘要
```

大白话：产品文档是"必须看的"，技术文档是"最好看的"，参考资料是"有空看的"。

#### 3.2.3 超预算降级过程（大白话版）

```
假设 3 个文档，预算 60K tokens:

文档 A (product, 40K tokens) → 优先级 0, 先分配
  剩余预算 = 60K - 40K = 20K ✅ 预算够，全文注入

文档 B (technical, 25K tokens) → 优先级 1, 第二个
  剩余预算 = 20K - 25K = -5K ❌ 预算不够！
  → 降级为摘要模式：
    1. 提取标题
    2. 列出章节目录（"概述"、"架构设计"、"接口定义"...）
    3. 取前 N 字符的内容预览
    4. 标注 mode="summary"，告诉 LLM 这个文档被截断了
  摘要估计 3K tokens，剩余预算 = 20K - 3K = 17K

文档 C (reference, 15K tokens) → 优先级 2, 最后
  剩余预算 = 17K - 15K = 2K ✅ 预算够，全文注入
  （注意：虽然优先级低，但如果预算够就还是全文）
```

关键设计决策：**预算分配按优先级排序，但输出按原始顺序**。就是说，先给重要文档分预算，但最终拼给 LLM 的顺序还是用户看到的文档顺序。

#### 3.2.4 摘要生成逻辑

```
BuildDocumentSummary(doc, remainingBudget)
  │
  ├─ 始终包含：标题 + 章节目录
  │   # API 接口文档
  │   ## 章节目录
  │   - 概述
  │   - 用户认证
  │     - 登录接口
  │     - 注册接口
  │   - 数据查询
  │
  ├─ 如果还有预算：追加前 N 字符的内容
  │   ## 内容摘要（前文）
  │   本文档描述了 PRD Agent 的 API 接口设计...
  │
  └─ 结尾标注：
      [...文档已截断，如需完整内容请针对本文档追问...]
```

#### 3.2.5 动态历史窗口

```
旧方案（固定条数）:
  取最近 20 条消息，不管每条多长
  问题：20 条"你好"占 200 tokens，20 条长分析占 40K tokens
         → 同样 20 条，token 消耗差 200 倍

新方案（预算制）:
  1. 从数据库取最近 50 条
  2. 从最新一条开始往回数
  3. 每条消息估算 token 数 = 字符数 / 3
  4. 累计不超过 30K tokens
  5. 超了就丢掉更早的消息
  6. 最后按时间顺序（旧→新）排好

效果：
  短对话 → 全部保留（和以前一样）
  长对话 → 自动丢弃早期不太重要的历史
```

#### 3.2.6 LLM 系统提示词配合

系统提示词中新增了对 `mode="summary"` 的引导：

```
- 当收到多个文档（PRD_BUNDLE）时，每个文档以 <PRD index="N" title="标题" type="类型"> 标签区分
- 部分文档可能因 token 预算限制而被摘要化（标记 mode="summary"），
  如果用户问题涉及被摘要的文档，请提示用户"该文档当前为摘要模式，如需详细内容请针对该文档追问"
```

大白话：LLM 知道某些文档是"缩印版"，如果用户问到了那个文档的细节，LLM 会主动说"这个文档我只看了目录，你要问细节的话可以单独问我"。

#### 3.2.7 单文档不受影响

设计上有一个重要的分支：

```csharp
// ChatService.cs:216-218
var prdContext = documents.Count > 1
    ? _promptManager.BuildMultiPrdContextMessage(documents, ..., DocBudget)  // 多文档：走预算逻辑
    : _promptManager.BuildMultiPrdContextMessage(documents);                 // 单文档：走原逻辑
```

**为什么单文档不走预算？** 因为单文档场景下用户期望 AI 看到完整内容，截断反而降低体验。而且绝大多数单文档 < 60K tokens，超限风险低。

#### 3.2.8 Token 估算方法

```
EstimateTokens(text) = ceil(text.Length / 3.0)
```

这是一个粗估公式：
- 纯中文：实际约 1 token / 1.5 字符，公式高估约 2 倍 → 偏保守（安全）
- 纯英文：实际约 1 token / 4 字符，公式低估约 25% → 偏激进
- 中英混合：大致准确

**已知局限**：
- 精确估算需要 tiktoken（按模型的实际 tokenizer 计算），但引入外部依赖的 ROI 不高，粗估已经够用。
- **注意两个 EstimateTokens 公式不一致**：`MarkdownParser`（入库用）采用中英文分别计算（中文×1.5 + 英文×0.25），`PromptManager`（预算 fallback）采用统一 `length/3`。正常流程优先使用入库值，不会触发 fallback。但 `BuildDocumentSummary` 内部的 `headerBudget` 计算用的是 PromptManager 公式，对纯中文文档可能导致摘要前文截取偏长。

### 3.3 未来演进方向（Phase 3: 按需检索）

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

与当前 Phase 2（预算制）的区别：Phase 2 是"文档级"的降级（整个文档全文或摘要），Phase 3 是"章节级"的按需检索（只拉用户问题相关的章节），需要引入 embedding/RAG 基础设施。

### 3.4 与技能系统的交互

技能（Skill）通过 `contextScope` 控制上下文注入范围：

| contextScope | 行为 | 多文档影响 |
|-------------|------|-----------|
| `all` | 注入对话历史 + 所有文档 | 全部文档进入上下文 |
| `current` | 注入当前对话上下文 | 全部文档 + 对话历史 |
| `prd` | 仅注入文档，不含对话 | 全部文档，无对话历史 |
| `none` | 不注入任何上下文 | 无文档注入 |

**一键创建技能**（SkillManagerModal）中，用户可选择 contextScope。当选择 `prd` 时，技能执行会自动获取会话中的所有文档作为上下文，无需手动指定。

---

## 3.5 文件上传与三阶段格式检测

### 3.5.1 设计目标

用户应该能上传**任意文本格式的文件**（代码、配置、文档等）作为知识库资料，而不是被白名单限制。同时，上传体验必须做到**即时反馈**——不能让用户上传完才被告知"格式不支持"。

### 3.5.2 三阶段检测架构

```
用户选择文件
    │
    ├── Phase 1：已知放行（KNOWN_GOOD_EXTS, 100+ 种）
    │   .ts/.py/.md/.json/.pdf/.docx/... → 直接上传，零延迟
    │
    ├── Phase 2：已知拒绝（KNOWN_BAD_EXTS）
    │   .png/.mp4/.zip/.exe/... → 立即拒绝 + UI 显示原因
    │
    └── Phase 3：未知格式 → 探测
        │
        ├── 桌面端：标记"正在检测" → 上传到后端 → 后端文本检测
        └── 管理后台：读前 8KB 检查 null 字节 → 通过才继续
```

**设计原则**：

| 原则 | 说明 |
|------|------|
| **黑名单 > 白名单** | 白名单需要不断扩展维护，黑名单更稳定（新格式默认允许尝试） |
| **前端预筛 + 后端兜底** | 前端按扩展名快速分类，后端按文件内容做最终判断 |
| **逐文件反馈** | 多文件上传时每个文件独立显示状态，不因一个失败阻塞全部 |
| **乐观探测** | 未知格式不直接拒绝，而是"试一下"再告知结果 |

### 3.5.3 后端文本检测算法（TryReadAsUtf8Text）

```
输入：byte[] 文件字节

Step 1：BOM 检测（UTF-16/UTF-32 支持）
  FF FE 00 00 → UTF-32 LE，用对应编码解码后返回
  FF FE       → UTF-16 LE，用 Encoding.Unicode 解码后返回
  FE FF       → UTF-16 BE，用 Encoding.BigEndianUnicode 解码后返回

Step 2：空文件检查
  bytes.Length == 0 → return null

Step 3：Null 字节检测（前 8KB）
  遍历前 8192 字节，发现 0x00 → return null（二进制文件特征）

Step 4：UTF-8 解码 + 控制字符比例检查
  Encoding.UTF8.GetString(bytes)
  检查前 4096 字符中不可打印字符（排除 \t \r \n）的比例
  超过 5% → return null（二进制）
  通过 → 返回文本内容
```

**已知限制**：只采样前 8KB/4096 字符。极端情况下（文件前部正常、中部变为二进制）可能误判，但实际概率极低。

### 3.5.4 前端文件状态机（桌面端）

```
FilePhase 状态：
  queued    → 已知好格式，等待上传
  rejected  → 已知坏格式，立即拒绝
  detecting → 未知格式，标记"正在检测"
  uploading → 上传中（含探测中的"格式未知，尝试上传…"）
  success   → 上传成功
  failed    → 上传失败或后端拒绝
```

| 颜色 | 状态 | 图标 |
|------|------|------|
| 蓝色 | queued / uploading | spinner |
| 琥珀色 | detecting | spinner |
| 绿色 | success | ✓（3 秒后自动消失） |
| 红色 | rejected / failed | ✗（rejected 3 秒后消失，failed 保留供排查） |

### 3.5.5 关键文件路径

| 层级 | 文件 | 职责 |
|------|------|------|
| **后端 Controller** | `SessionsController.cs:72-104` | `TryReadAsUtf8Text` — BOM 检测 + null 字节 + 控制字符比例 |
| **后端 Controller** | `SessionsController.cs:450-541` | `UploadDocument` — MIME 推断 + 图片/音视频拒绝 + 文本检测 |
| **Rust Command** | `document.rs:88-140` | `upload_file_to_session` — 读取字节 + MIME 推断 + POST multipart |
| **桌面端 UI** | `KnowledgeBasePage.tsx:15-38` | `KNOWN_GOOD_EXTS` / `KNOWN_BAD_EXTS` 集合定义 |
| **桌面端 UI** | `KnowledgeBasePage.tsx:118-192` | `handleAddDocumentNative` — 三阶段分类 + 逐文件进度 |
| **管理后台** | `AiChatPage.tsx:114-144` | `REJECTED_BINARY_EXTS` / `KNOWN_GOOD_EXTS` / `isLikelyTextFile` |
| **管理后台** | `AiChatPage.tsx:1057-1078` | `pickAttachment` — 三阶段检测（附件） |
| **管理后台** | `AiChatPage.tsx:1240-1269` | `handleAddDocument` — 三阶段检测（追加文档） |

### 3.5.6 格式分类清单

**KNOWN_GOOD_EXTS（100+ 种，直接放行）**：

| 分类 | 扩展名 |
|------|--------|
| 文档 | `.md` `.mdc` `.txt` `.csv` `.json` `.xml` `.html` `.htm` `.yaml` `.yml` `.toml` `.ini` `.cfg` `.conf` `.log` `.rst` `.adoc` `.tex` |
| 代码 | `.js` `.jsx` `.ts` `.tsx` `.vue` `.svelte` `.css` `.scss` `.less` `.sass` `.py` `.rb` `.go` `.rs` `.java` `.kt` `.kts` `.scala` `.swift` `.c` `.cpp` `.h` `.hpp` `.cs` `.fs` `.sh` `.bash` `.zsh` `.ps1` `.bat` `.cmd` `.sql` `.graphql` `.gql` `.proto` `.r` `.lua` `.dart` `.php` `.pl` `.pm` `.ex` `.exs` `.erl` `.hs` `.clj` `.lisp` `.ml` `.zig` |
| 数据/配置 | `.env` `.properties` `.gradle` `.pom` `.lock` `.editorconfig` `.gitignore` `.dockerignore` |
| 二进制文档 | `.pdf` `.doc` `.docx` `.xls` `.xlsx` `.ppt` `.pptx`（有 FileContentExtractor 提取器） |

**KNOWN_BAD_EXTS（立即拒绝）**：图片、音视频、可执行文件、压缩包、字体、数据库文件。

---

## 4. 风险比对矩阵

### 4.1 单文档 vs 多文档

| 维度 | 单文档 | 多文档 | 风险/限制 |
|------|--------|--------|----------|
| **Token 消耗** | 一份文档的 tokens | 所有文档 tokens 叠加 | ✅ 已实现 token 预算管理（60K 文档预算），超预算文档自动摘要化 |
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
| **权重影响** | ✅ 影响 LLM 注入优先级 | 权重通过预算分配实现，非显式 weight 属性 | `<PRD type="xxx">` 标签已传递给 LLM，优先级影响截断决策 |
| **引用提取** | 仅主文档 | 辅助文档的引用丢失 | DocCitationExtractor 改为遍历所有文档 |
| **类型继承** | 无 | 文档被 fork 后类型不继承 | fork 时可选择是否继承类型设置 |
| **类型统计** | 无 | 无法分析哪类文档最常用 | 可在 llmrequestlogs 中记录文档类型分布 |

### 4.3 已知风险清单

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| Token 超限 | 低（已有预算管控） | 中（单文档仍可能超限） | ✅ 多文档已实现 60K token 预算，超预算文档摘要化。⚠️ 单文档不做截断，极端大文档仍有风险 |
| 引用来源混淆 | 高（多文档时） | 中（用户看到引用但不知来自哪个文档） | DocCitationExtractor 扩展为多文档提取 |
| 旧数据迁移 | 低 | 低 | GetDocumentType() 有完整 fallback 逻辑 |
| 并发修改 | 低 | 中 | DocumentMetas 的 add/remove 操作已在 service 层做原子操作 |
| UTF-16 文件误拒 | 低 | 低 | ✅ 已修复：TryReadAsUtf8Text 检测 BOM 头后用对应编码解码 |
| 未知格式探测失败 | 低 | 低 | 后端返回明确错误信息，前端标记 failed 并保留供排查 |
| 大文件上传浪费带宽 | 低 | 低 | ✅ 管理后台已加 20MB 前端检查；桌面端由后端 RequestSizeLimit 兜底 |

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
| **Controller** | `PrdAgent.Api/Controllers/SessionsController.cs` | PATCH type + Upload + TryReadAsUtf8Text | L72-104, L416-541 |
| **Controller** | `PrdAgent.Api/Controllers/GroupsController.cs` | 补充 DocumentMetas 到 OpenGroupSession | L289-298 |
| **Rust Model** | `src-tauri/src/models/mod.rs` | `SessionDocumentMeta` + SessionInfo/OpenGroupSessionResponse 扩展 | L54-74, L137-146 |
| **Rust Command** | `src-tauri/src/commands/document.rs` | `update_document_type` + `add_document_to_session` + `upload_file_to_session` | L62-140 |
| **Rust Client** | `src-tauri/src/services/api_client.rs` | `patch()` 方法 | L584-665 |
| **Rust Registry** | `src-tauri/src/lib.rs` | 注册 `update_document_type` | L181 |
| **TS Types** | `prd-desktop/src/types/index.ts` | `DocumentType` + `DocumentMeta` + `DOCUMENT_TYPE_LABELS` | L48-68 |
| **TS Lib** | `prd-desktop/src/lib/openGroupSession.ts` | 从 response 提取 metas 合并到 Document | L30, L43-53 |
| **Desktop UI** | `prd-desktop/src/components/Layout/Sidebar.tsx` | 补充文档预览眼睛 + 类型标签 | L738-772 |
| **Desktop UI** | `prd-desktop/src/components/KnowledgeBase/KnowledgeBasePage.tsx` | 预览 + 类型选择器 + 三阶段文件上传 + 逐文件进度 | 全文重写 |
| **Admin UI** | `prd-admin/src/pages/AiChatPage.tsx` | 类型标签 + metas 映射 + 三阶段格式检测（附件/追加文档） | L114-144, L1057-1078, L1240-1269 |
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

### 6.2 演进路线图（当前处于阶段 2）

```
阶段 1 ✅ 已完成: 全量注入 + UI 类型标记
  └─ 所有文档平等注入，类型仅用于 UI 展示

阶段 2 ✅ 已实现: Token 预算 + 类型加权
  └─ 总预算 100K = 文档 60K + 历史 30K + 当前/输出 10K+
  └─ 文档按类型优先级分配预算：
     product → 优先全文（最高优先级）
     technical/design → 次优先
     reference → 最低优先，预算不够先截这类
  └─ 超预算文档降级为摘要（标题 + 目录 + 前文）
  └─ 对话历史从固定 20 条改为 token 预算制（30K）
  └─ LLM 系统提示词引导处理 mode="summary" 文档

阶段 3（未来: 按需检索 / RAG）:
  └─ 首次只注入主文档 + 问题最相关章节
  └─ LLM 需要更多上下文时，追加注入
  └─ 需要 embedding 基础设施
  └─ 减少 token 浪费，提高回答精度

阶段 4（未来: 与技能融合）:
  └─ 技能定义中可指定 "preferredDocTypes": ["product", "technical"]
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

### 7.2 文件上传端点（v3.0 新增）

```http
POST /api/v1/sessions/{sessionId}/documents/upload
Content-Type: multipart/form-data

file: <binary>                           // 必填，文件二进制内容
documentType: "reference"                // 可选查询参数，默认 "reference"

Response: SessionResponse (含 documentMetas)

错误码:
  UNSUPPORTED_TYPE  — 图片/音视频等不支持的格式
  INVALID_FORMAT    — 无法提取文本内容（二进制可执行文件或空文件）
  FILE_TOO_LARGE    — 超过 20MB 限制
```

**格式支持策略**: 不使用 MIME 白名单，而是自动检测。已知二进制文档（PDF/Office）用 `FileContentExtractor` 提取文本，其他格式尝试 UTF-8 解码，通过 null 字节和控制字符比例判断是否为文本。仅拒绝图片（`image/*`）和音视频（`audio/*`/`video/*`）。

### 7.3 修改的端点

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

---

## 9. Token 预算架构：设计决策记录

> 这一节记录每个设计决策的"为什么"，方便后续 review 时对照检查。

### 9.1 为什么预算硬编码在 ChatService 而不是配置文件

```csharp
// ChatService.cs:211-213
const int TotalContextBudget = 100_000;
const int DocBudget = 60_000;
const int HistoryBudget = 30_000;
```

**决策理由**：
- 这些值跟模型上下文窗口强关联（128K），短期内不会频繁调整
- 放配置文件会引入"修改配置忘记重启"的运维风险
- 如果未来需要按模型/应用动态调整，再抽到 `appsettings.json`

**已知缺陷**：不同模型上下文窗口不同（GPT-4o: 128K, Claude: 200K），固定 100K 对大窗口模型偏保守。

### 9.2 为什么优先级用静态函数而不是数据库配置

```csharp
static int TypePriority(string docType) => docType switch
{
    "product" => 0,
    "technical" => 1,
    "design" => 1,
    _ => 2
};
```

**决策理由**：
- 文档类型只有 4 种且短期不会变
- 数据库配置增加了复杂度但没增加灵活性
- 如果新增文档类型，在这里加一行 case 即可

### 9.3 为什么摘要用"目录+前文"而不是 LLM 生成摘要

**决策理由**：
- LLM 生成摘要需要额外一次 API 调用，延迟 +2-5 秒
- 目录+前文是"零成本"的降级方案，响应速度不受影响
- 用户可以通过"追问该文档"触发完整注入（Phase 3 方向）

**已知缺陷**：目录+前文的信息密度不如 LLM 摘要，可能导致 AI 对摘要文档的理解不够深入。

### 9.4 为什么历史窗口从新到旧遍历

```csharp
// 从最新往最旧遍历，优先保留最近消息
foreach (var m in ((IEnumerable<Message>)history).Reverse())
{
    if (historyTokensUsed + tokenEstimate > HistoryBudget)
        break;  // 预算用完，丢弃更早的消息
    ...
}
// 恢复时间顺序
trimmedHistory.Reverse();
```

**决策理由**：
- 最近的对话最重要（上下文连贯性）
- 用户问"刚才说的那个"时，AI 能理解
- 丢弃早期历史比丢弃近期历史影响小得多

### 9.5 为什么单文档不走预算逻辑

```csharp
var prdContext = documents.Count > 1
    ? _promptManager.BuildMultiPrdContextMessage(documents, ..., DocBudget)
    : _promptManager.BuildMultiPrdContextMessage(documents);
```

**决策理由**：
- 单文档场景占使用量的 90%+，不应引入任何额外复杂度
- 单文档被截断会直接影响 AI 回答质量，用户体感差
- 单文档超限是极端 case（需要 > 180K 字符），概率低

**已知风险**：如果用户上传了一份 50 万字的文档，单文档场景仍会超限。需要在 Phase 3 补充单文档保护。

### 9.6 预算是"软上限"而非"硬上限"

当所有文档都超预算时，每个文档仍然会生成最小摘要（标题+目录，约 300-500 token/文档）并累加到 `usedTokens`。也就是说 10 个全部超预算的文档会多出 ~5K token 的摘要开销。

**决策理由**：
- 完全丢弃文档（不注入任何内容）会让用户困惑——"我加了 10 个文档，AI 怎么只看到 3 个？"
- 最小摘要至少告诉 LLM"有这个文档存在"，用户追问时 LLM 能给出引导
- 5K token 的超出在 128K 上下文窗口中可忽略（< 4%）

**如果需要硬上限**：在循环中加 `if (usedTokens >= tokenBudget) break;`，但会导致后面的文档完全消失。

---

## 10. 完整调用链路追踪（Debug 用）

> 当多文档对话出了问题，按这个路径排查。

### 10.1 正常流程

```
1. 用户发消息 → ChatRunsController.CreateRun()
   │
2. ChatRunWorker 启动 → ChatService.SendMessageAsync()
   │
3. 加载文档列表
   session.GetAllDocumentIds()      [Session.cs:37-44]
   → 优先读 DocumentIds，回退 DocumentId
   │
4. 逐个加载文档
   foreach docId → documentService.GetByIdAsync()
   → documents: List<ParsedPrd>
   │
5. 组装文档上下文
   ├─ 单文档 → BuildMultiPrdContextMessage(docs)  [PromptManager.cs:102]
   └─ 多文档 → BuildMultiPrdContextMessage(docs, getDocType, 60000)  [PromptManager.cs:136]
       │
       ├─ 计算每个文档的 token 估算  [PromptManager.cs:160]
       │   doc.TokenEstimate > 0 ? doc.TokenEstimate : EstimateTokens(doc.RawContent)
       │
       ├─ 按优先级排序分配预算  [PromptManager.cs:171-196]
       │   product(0) > technical/design(1) > reference(2)
       │   预算够 → full，不够 → BuildDocumentSummary()
       │
       └─ 按原始顺序输出 XML  [PromptManager.cs:200-213]
           <PRD index="N" title="..." type="..." [mode="summary"]>
   │
6. 组装对话历史
   GetHistoryAsync(sessionId, 50)   [ChatService.cs:229]
   → 取最近 50 条
   → 从新到旧按 token 预算裁剪（30K 上限）  [ChatService.cs:230-247]
   → 按时间顺序排列
   │
7. 添加当前消息 → 发给 LLM
```

### 10.2 排查 checklist

| 现象 | 可能原因 | 排查路径 |
|------|----------|----------|
| AI 说"该文档为摘要模式" | 文档被降级了 | 检查文档大小 vs 60K 预算，检查文档类型和优先级 |
| AI 回答跟某文档无关 | 文档可能被丢弃/摘要化 | 查 LLM 日志中的 PRD_BUNDLE，看是否有 `mode="summary"` |
| AI 忘了之前聊过什么 | 历史被 30K 预算截断 | 查 LLM 日志中实际注入了多少条历史消息 |
| 单文档对话 AI 截断 | 单文档不走预算，可能超模型窗口 | 检查文档字符数（> 180K 字 ≈ 60K token 就可能出问题） |
| 新类型文档被当参考处理 | TypePriority 没加新类型的 case | 检查 PromptManager.cs 的 switch 表达式 |
| 文档类型全是 reference | Session.DocumentMetas 为空 | 检查 AddDocument 时是否传了 documentType |
