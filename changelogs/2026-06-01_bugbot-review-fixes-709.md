| fix | prd-admin | DocBrowser tag 筛选自动剔除当前 entries 不存在的已选 tag，跨知识库切换时不再卡死（Codex P2） |
| fix | prd-admin | DocBrowser 受控 tagColors 用 intentRef 跟踪最新色板，避免快速连点两个 tag 时第二次覆盖第一次（Bugbot Medium） |
| fix | prd-admin | DocumentStorePage tagColors 保存用 seq 守卫，避免老请求 rollback 覆盖新成功的保存（Bugbot Medium） |
| fix | prd-api | DocumentStore 导出/导入 bundle 包含 TagColors 字段，跨环境同步不再丢失自定义颜色（Bugbot Low） |
