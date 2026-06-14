| fix | prd-admin | 修复快捷指令复制到剪贴板在非安全上下文/内嵌浏览器下静默失败却假报「已复制」的问题 |
| feat | prd-admin | 新增健壮剪贴板工具 lib/clipboard.ts（async API + execCommand 兜底 + 真实成功反馈），统一快捷指令各处复制 |
| fix | prd-admin | 快捷指令 iCloud 模板安装：配置复制失败时不再跳转 iCloud，避免装出来读不到配置 |
