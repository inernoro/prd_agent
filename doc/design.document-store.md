# 文档空间 · 设计

> **版本**：v1.0 | **日期**：2026-04-07 | **状态**：已实现

## 一、管理摘要

- **解决什么问题**：系统缺少统一的文档存储与知识管理能力，用户无法集中管理、预览和复用文档资产
- **方案概述**：借用已有基础设施（IAssetStorage + FileContentExtractor + DocumentService），构建文档空间 CRUD + 文件上传存盘 + 订阅源定期同步
- **业务价值**：文档成为一等公民，可以上传、预览、搜索、自动同步，并作为涌现探索器的种子来源
- **影响范围**：后端（DocumentStoreController + DocumentSyncWorker）、管理后台（/document-store 页面）

## 二、核心能力

| 能力 | 状态 | 实现方式 |
|------|------|---------|
| 文档空间 CRUD | ✅ | DocumentStore 模型 + Controller |
| 文件上传存盘 | ✅ | 借用 IAssetStorage（COS/本地）+ Attachment |
| 文本提取 | ✅ | 借用 FileContentExtractor（PdfPig + OpenXml） |
| 文档解析分段 | ✅ | 借用 DocumentService → ParsedPrd |
| 内容预览 | ✅ | GET /entries/{id}/content |
| 搜索 | ✅ | 标题/摘要 regex 搜索 |
| 订阅源定期同步 | ✅ | DocumentSyncWorker (BackgroundService + PeriodicTimer) |
| 手动触发同步 | ✅ | POST /entries/{id}/sync |
| 全文搜索 | ❌ | 待实现（需 MongoDB Atlas Search 或 embedding） |
| RAG / 语义检索 | ❌ | 待实现 |

## 三、数据模型

### DocumentStore（文档空间）

| 字段 | 类型 | 说明 |
|------|------|------|
| Id | string | Guid，主键 |
| Name | string | 空间名称 |
| Description | string? | 描述 |
| OwnerId | string | 创建者 |
| AppKey | string? | 绑定应用标识 |
| Tags | List\<string\> | 标签 |
| IsPublic | bool | 是否公开 |
| DocumentCount | int | 文档数量（反规范化） |

### DocumentEntry（文档条目）

| 字段 | 类型 | 说明 |
|------|------|------|
| Id | string | Guid，主键 |
| StoreId | string | 所属空间 |
| DocumentId | string? | 关联 ParsedPrd（文本内容） |
| AttachmentId | string? | 关联 Attachment（文件存储） |
| Title | string | 标题 |
| Summary | string? | 摘要（自动提取或用户填写） |
| SourceType | string | upload / subscription / migration / reference / import |
| ContentType | string | MIME 类型 |
| FileSize | long | 字节 |
| SourceUrl | string? | 订阅源 URL |
| SyncIntervalMinutes | int? | 同步间隔（分钟） |
| LastSyncAt | DateTime? | 上次同步时间 |
| SyncStatus | string? | idle / syncing / error |
| SyncError | string? | 同步错误信息 |

## 四、API 端点

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | /api/document-store/stores | 创建空间 |
| GET | /api/document-store/stores | 列出空间 |
| GET | /api/document-store/stores/{id} | 空间详情 |
| PUT | /api/document-store/stores/{id} | 更新空间 |
| DELETE | /api/document-store/stores/{id} | 删除空间（级联） |
| POST | /api/document-store/stores/{id}/entries | 添加条目（元数据） |
| POST | /api/document-store/stores/{id}/upload | 上传文件（multipart） |
| POST | /api/document-store/stores/{id}/subscribe | 添加订阅源 |
| GET | /api/document-store/stores/{id}/entries | 列出条目 |
| GET | /api/document-store/entries/{id} | 条目详情 |
| GET | /api/document-store/entries/{id}/content | 文档内容 |
| PUT | /api/document-store/entries/{id} | 更新条目 |
| DELETE | /api/document-store/entries/{id} | 删除条目 |
| POST | /api/document-store/entries/{id}/sync | 手动触发同步 |

## 五、借用的基础设施

| 组件 | 用途 | 原归属 |
|------|------|--------|
| IAssetStorage | 文件存储到 COS/本地 | 附件系统 |
| FileContentExtractor | PDF/Word 文本提取 | 附件系统 |
| DocumentService | Markdown 解析 + ParsedPrd 持久化 | PRD Agent |
| Attachment 模型 | 文件元数据 + ExtractedText | 附件系统 |

## 六、关联设计文档

- `design.emergence-explorer.md` — 涌现探索器（文档空间的消费者）
- `design.multi-doc-knowledge.md` — 桌面端多文档知识库（同一文档基础设施的另一个消费者）
