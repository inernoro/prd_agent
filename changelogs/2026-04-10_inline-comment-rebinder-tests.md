| refactor | prd-api | 划词评论重锚定算法抽取到 `PrdAgent.Infrastructure.Services.DocumentStore.InlineCommentRebinder` 纯函数类，便于单元测试覆盖；同步新增 20 个 xunit 测试覆盖唯一命中/多处消歧/失锚/空输入/边界情况 |
| fix | prd-api | 知识库级联删除补齐三张表：删除 Store 时同步清理 `document_store_view_events` / `document_inline_comments` / `document_store_agent_runs`；删除 Entry/Folder 时按 `EntryId`/`SourceEntryId` 清理对应记录，避免孤儿数据 |
