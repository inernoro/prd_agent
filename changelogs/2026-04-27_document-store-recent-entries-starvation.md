| fix | prd-api | 修复知识库卡片"暂无内容"与 documentCount 不一致：recentEntries 改为按 store 维度独立查询，避免单次全局 sort+limit 导致活跃度低的 store 被抢占额度 |
