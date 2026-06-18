| fix | prd-admin | 短视频卡片：视频已入库但转写 stage 失败（run 为 done、phase 非 error）时，补一行显示转写失败原因 + 可单独重试提示，不再让用户看不出"为什么没有文字"（Codex P2） |
| fix | prd-admin | 短视频轮询：run 为 done 但未返回完整入库产物时，error 消息一并同步终态 run，避免卡片渲染上一轮旧 run 与终态 API 不一致（Bugbot Low） |
