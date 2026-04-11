---
name: document-emerge
description: >
  文档空间涌现式功能设计技能。基于市面主流文档产品（Notion/Confluence/语雀/飞书/Obsidian/Gitbook）的功能矩阵，
  通过涌现思维为 prd_agent 文档空间规划和实现下一个最有价值的功能。每次调用产出一个可落地的功能方案。
  触发词："文档涌现"、"document emerge"、"涌现功能"、"/emerge"、"下一个文档功能"。
---

# Document Emerge — 文档空间涌现式功能设计

通过对标市面顶级文档产品，用涌现思维为 prd_agent 文档空间持续演进功能。

## 目录

- [设计哲学](#设计哲学)
- [适用场景](#适用场景)
- [涌现工作流](#涌现工作流)
- [功能象限](#功能象限)
- [当前系统能力基线](#当前系统能力基线)
- [输出模板](#输出模板)
- [示例](#示例)

## 设计哲学

**涌现 ≠ 堆砌功能**。涌现的核心是：

1. **观察** — 分析用户当前使用文档空间的方式和痛点
2. **连接** — 将已有能力（ParsedPrd、Attachment、LLM Gateway）与新需求交叉组合
3. **浮现** — 从交叉点中发现"做了 A+B 就自然产生 C"的涌现价值
4. **验证** — 每个功能必须回答："这比用户手动做能快多少？"

**反模式**：逐条抄袭竞品 → 缺乏整合 → 功能孤岛。
**正模式**：分析当前系统独有的能力组合 → 找到竞品没做但我们能做的交叉点。

## 适用场景

| 场景 | 触发 |
|------|------|
| **规划下一个文档功能** | "文档空间下一步做什么" |
| **对标竞品设计** | "Notion 的 XX 功能我们怎么做" |
| **功能优先级排序** | "文档功能排个优先级" |
| **技术方案涌现** | "文档空间要支持 XX，怎么利用现有能力" |
| **批量功能规划** | "给文档空间做个路线图" |

## 涌现工作流

```
涌现进度：
- [ ] Step 1: 扫描当前系统能力基线
- [ ] Step 2: 识别用户场景与痛点
- [ ] Step 3: 功能象限定位
- [ ] Step 4: 交叉组合涌现
- [ ] Step 5: 方案输出与评估
- [ ] Step 6: 落地执行（可选）
```

### Step 1: 扫描当前系统能力基线

读取以下文件确认当前状态：

```bash
# 文档空间模型
cat prd-api/src/PrdAgent.Core/Models/DocumentStore.cs
cat prd-api/src/PrdAgent.Core/Models/DocumentEntry.cs

# 已有文档能力
cat prd-api/src/PrdAgent.Core/Models/ParsedPrd.cs
cat prd-api/src/PrdAgent.Core/Models/Attachment.cs

# 控制器端点
grep -rn "Http" prd-api/src/PrdAgent.Api/Controllers/Api/DocumentStoreController.cs

# LLM 能力
grep -rn "ILlmGateway" prd-api/src/PrdAgent.Core/Interfaces/ILlmGateway.cs | head -20
```

### Step 2: 识别用户场景

从用户描述中提取核心场景，映射到功能象限。如果用户未指定场景，主动询问：

> "文档空间目前支持基础存储。你最想先实现哪个方向？
> 1. 📥 导入导出（PDF/Word/Markdown 互转、批量导入）
> 2. 🔍 搜索发现（全文搜索、标签、智能推荐）
> 3. 🤖 AI 增强（自动摘要、Q&A、自动标签）
> 4. 📤 分享协作（公开链接、下载、权限）
> 5. 🔗 知识链接（双向链接、引用、知识图谱）
> 6. 📋 模板系统（文档模板、一键套用）
> 7. 其他 — 说出你的想法"

### Step 3: 功能象限定位

参考 [reference/feature-matrix.md](reference/feature-matrix.md) 中的市场分析，将目标功能放入象限：

```
                高价值
                  │
    ┌─────────────┼─────────────┐
    │  Quick Win   │  Strategic  │
    │  (先做)      │  (规划做)    │
    │  导入导出    │  AI Q&A     │
    │  下载/分享   │  知识图谱    │
────┼─────────────┼─────────────┼──── 低→高 实现难度
    │  Nice to    │  Icebox     │
    │  Have       │  (暂不做)    │
    │  拖拽排序   │  实时协同    │
    │  收藏       │  OCR 识别    │
    └─────────────┼─────────────┘
                  │
                低价值
```

### Step 4: 交叉组合涌现

**核心方法论** — 列出已有能力，两两组合寻找涌现点：

| 已有能力 A | + 已有能力 B | = 涌现功能 C |
|-----------|-------------|-------------|
| DocumentEntry | + ParsedPrd 分节解析 | = 文档目录大纲导航 |
| DocumentEntry | + ILlmGateway | = AI 自动摘要/标签 |
| DocumentStore.IsPublic | + ShareLink | = 知识库公开分享 |
| Attachment.ExtractedText | + DocumentEntry | = PDF/Word 全文搜索 |
| ParsedPrd.Sections | + LLM 问答 | = 文档 Q&A |
| DocumentEntry.Tags | + 全文索引 | = 多维度搜索发现 |
| DocumentStore | + 模板 | = 一键创建标准知识库 |
| DocumentEntry.Metadata | + Webhook | = 文档变更通知 |

**评估每个涌现点**：
- 用户价值：解决什么痛点？
- 实现成本：需要多少新代码？能复用多少？
- 独特性：竞品有但我们做得更好的点在哪？

### Step 5: 方案输出

按下方模板输出方案，由用户确认后执行。

### Step 6: 落地执行（用户确认后）

执行标准开发流程：
1. 后端 Model / Service / Controller
2. 前端页面（如需要）
3. `dotnet build` 验证
4. changelog 碎片
5. commit + push

## 当前系统能力基线

> 每次新功能落地后更新此清单。

### 后端基础设施

| 能力 | 状态 | 集合/文件 |
|------|------|----------|
| 文档空间 CRUD | ✅ | `document_stores` |
| 文档条目 CRUD | ✅ | `document_entries` |
| 文本解析存储 | ✅ | `documents` (ParsedPrd) |
| 文件附件存储 | ✅ | `attachments` |
| 文件文本提取 | ✅ | Attachment.ExtractedText |
| Markdown 解析 | ✅ | MarkdownParser → Sections |
| LLM 统一网关 | ✅ | ILlmGateway |
| 权限控制 | ✅ | document-store.read/write |
| 菜单入口 | ✅ | AdminMenuCatalog |

### 待建设能力

| 能力 | 优先级 | 依赖 |
|------|--------|------|
| 文档内容上传（文本直传） | P0 | DocumentService |
| 文件上传（PDF/Word/Excel） | P0 | Attachment + ExtractedText |
| 文档下载（原文/PDF/Markdown） | P0 | 无 |
| 全文搜索 | P1 | MongoDB text index 或 Atlas Search |
| AI 自动摘要 | P1 | ILlmGateway |
| AI 自动标签 | P1 | ILlmGateway |
| 文档 Q&A | P2 | ILlmGateway + Sections |
| 公开分享链接 | P1 | ShareLink 模式复用 |
| 版本历史 | P2 | 新集合 |
| 双向链接 | P3 | 新模型 + 解析 |
| 知识图谱可视化 | P3 | 双向链接 |
| 模板系统 | P2 | DocumentStore 预设 |
| 批量导入 | P1 | 文件上传 |
| Webhook 通知 | P3 | 现有 Webhook 模式 |
| 协同编辑 | P4 | CRDT / OT（重度） |

## 输出模板

```markdown
## 涌现功能方案：[功能名称]

### 涌现路径
> 能力 A（xxx）+ 能力 B（xxx）= 涌现功能 C

### 用户价值
- 解决痛点：...
- 对标产品：Notion/语雀/... 的 XX 功能
- 独特优势：...

### 技术方案

**后端改动**：
| 文件 | 操作 | 说明 |
|------|------|------|
| ... | 新增/修改 | ... |

**前端改动**（如需要）：
| 文件 | 操作 | 说明 |
|------|------|------|

**API 端点**：
| 方法 | 路由 | 说明 |
|------|------|------|

### 象限评估
- 价值：⭐⭐⭐⭐⭐ (1-5)
- 难度：⭐⭐ (1-5)
- 复用度：利用了 XX、XX 已有能力
- 象限：Quick Win / Strategic / Nice to Have

### 验收标准
1. ...
2. ...
3. ...

确认后执行。
```

## 示例

**用户输入**：
> "文档空间要支持下载"

**涌现分析**：

### 涌现功能方案：文档多格式下载

#### 涌现路径
> ParsedPrd.RawContent（已有 Markdown 原文）+ Attachment.Url（已有文件 URL）= 多格式下载

#### 用户价值
- 解决痛点：用户存入文档后无法取出，"只进不出"
- 对标产品：Notion 导出 PDF/Markdown、语雀导出 DOCX
- 独特优势：结合 ParsedPrd 解析结构，导出时可选择"仅导出某章节"

#### 技术方案

**后端改动**：

| 文件 | 操作 | 说明 |
|------|------|------|
| `DocumentStoreController.cs` | 修改 | 新增下载端点 |

**API 端点**：

| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/api/document-store/entries/{id}/download?format=markdown` | 下载原始 Markdown |
| GET | `/api/document-store/entries/{id}/download?format=raw` | 下载原始文件（PDF/Word） |

#### 象限评估
- 价值：⭐⭐⭐⭐⭐ — 基础能力，用户预期
- 难度：⭐⭐ — 仅需组合已有数据
- 复用度：ParsedPrd.RawContent + Attachment.Url
- 象限：**Quick Win**

确认后执行。
