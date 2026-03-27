# design.generation-snapshot — 生成快照设计

> **版本**：v1.0 | **日期**：2026-03-21 | **状态**：已实现

---

## 一、管理摘要

- **解决什么问题**：投稿详情页的生成信息依赖动态查询，源数据删除后信息永久丢失，且缺少参考图、水印等关键输入源
- **方案概述**：投稿创建时一次性采集所有输入源的快照（GenerationSnapshot），读取时零跨集合查询，支持"一键做同款"复刻
- **业务价值**：用户可完整查看作品的输入配方（正文/提示词/参考图/水印），支持复刻和溯源，数据不再因源删除而丢失
- **影响范围**：Submission 模型（新增嵌套快照）、投稿详情 API、前端详情页 4 Tab 布局
- **预计风险**：低 — 旧投稿自动降级为动态查询兜底，回填端点可随时补数据

## 1. 背景

投稿系统原来的 `generationInfo` 是**读时动态拼装**：每次查详情都要查 ImageGenRun → LLMModel → Workspace → LiteraryPrompt 四张表。问题：

1. 源数据（Run/Workspace/Prompt）被删后，信息永久丢失
2. 缺少参考图 URL、水印配置、系统提示词内容等关键输入源
3. 无法支持"做同款"一键复刻

## 2. 设计方案

### 核心思路：创建时快照，读取时零查询

在 `Submission` 文档中新增 `GenerationSnapshot` 嵌套对象，**投稿创建时一次性采集**所有输入源的快照。

### 2.1 存储字段（GenerationSnapshot）

| 分类 | 字段 | 来源 | 用途 |
|------|------|------|------|
| **模型** | `ConfigModelId` | ImageGenRun | 做同款时定位模型 |
| | `ModelName` | LLMModel.Name 快照 | 展示 |
| | `Size` | ImageGenRun.Size | 展示 + 复刻 |
| **正文** | `PromptText` | ImageGenRunPlanItem.Prompt | 正文 Tab |
| | `StylePrompt` | Workspace.StylePrompt | 正文 Tab |
| **系统提示词** | `SystemPromptId` | Workspace.SelectedPromptId | 复刻定位 |
| | `SystemPromptTitle` | LiteraryPrompt.Title 快照 | 提示词 Tab |
| | `SystemPromptContent` | LiteraryPrompt.Content 快照 | 提示词 Tab |
| **参考图** | `HasReferenceImage` | Run.InitImageAssetSha256 | 参考图 Tab |
| | `ReferenceImageCount` | 计算值 | 参考图 Tab |
| | `InitImageUrl` | ImageAsset(SHA256).Url | 参考图 Tab 展示 |
| | `ImageRefs[]` | Run.ImageRefs 快照 | 参考图 Tab 多图 |
| | `HasInpainting` | Run.MaskBase64 非空 | 参考图 Tab |
| | `ReferenceImageConfigId/Name` | 预留 | 参考图配置 |
| **水印** | `WatermarkConfigId` | WatermarkConfig.Id | 水印 Tab |
| | `WatermarkName` | 快照 | 水印 Tab |
| | `WatermarkText` | 快照 | 水印 Tab |
| | `WatermarkFontKey` | 快照 | 水印 Tab |
| **溯源** | `ImageGenRunId` | Run.Id | 内部追踪 |
| | `AppKey` | Run.AppKey | 内部 |
| | `SnapshotAt` | 采集时间 | 审计 |

### 2.2 不存储的数据

| 数据 | 原因 |
|------|------|
| MaskBase64（涂抹蒙版） | 二进制大数据，单条可达数 MB |
| ImageRefs 的 Base64 | 同上 |
| Gateway 路由细节 | 内部运维信息，非用户关心 |
| ResponseFormat / MaxConcurrency | 实现细节 |

### 2.3 前端详情页 4 Tab 布局

```
右上角 Tab：
┌──────┬──────┬──────┬──────┐
│ 正文 │提示词│参考图│ 水印 │
└──────┴──────┴──────┴──────┘
```

| Tab | 数据来源 | 展示内容 |
|-----|----------|----------|
| 正文 | promptText, stylePrompt | 用户 prompt + 风格提示词 |
| 提示词 | systemPromptTitle, systemPromptContent | 系统提示词配置名 + 完整内容 |
| 参考图 | initImageUrl, imageRefs[], hasInpainting | 参考图缩略图 + 标签 + 涂抹标记 |
| 水印 | watermarkName, watermarkText, watermarkFontKey | 水印配置摘要 |

## 3. API 变更

### 3.1 详情 API 响应增强

`GET /api/submissions/{id}` 的 `generationInfo` 字段现在返回完整快照（有快照时），增加了：

- `promptText`, `stylePrompt` — 正文 Tab
- `systemPromptId`, `systemPromptContent` — 提示词 Tab
- `initImageUrl`, `imageRefs[]` — 参考图 Tab
- `watermarkConfigId`, `watermarkName`, `watermarkText`, `watermarkFontKey` — 水印 Tab
- `configModelId`, `appKey` — 做同款所需

### 3.2 回填端点

`POST /api/submissions/backfill-snapshots?username=admin&batchSize=100`

为已有投稿补充快照，按 batchSize 分批处理，返回 processed/updated/remaining。

## 4. 数据兼容

- 旧投稿 `GenerationSnapshot == null` 时，详情 API 自动降级为动态查询（兜底）
- 回填端点可随时运行，幂等（已有快照的不覆盖）

## 5. 教训与设计原则

> **教训**：任何展示给用户的信息，如果源数据可能被修改/删除，必须在创建时快照。

适用于视觉创作分享等类似场景的设计原则：

1. **快照不嫌多，展示按需选** — 存储层尽量完整采集，展示层按 Tab 选择性渲染
2. **面向复刻设计** — 存储的字段要满足"一键做同款"的全部输入需求
3. **读时零查询** — 详情页所需的所有信息都在文档内，不需跨集合联查
4. **渐进增强** — 新增字段时旧文档自动 fallback，回填端点补数据
