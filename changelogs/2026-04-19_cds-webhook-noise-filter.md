| fix | cds | GitHub webhook 收到非订阅事件(check_suite / workflow_run / pull_request_review / status / star 等)时直接 200 确认并跳过 dispatcher,响应头 X-CDS-Suppress-Activity=1 让 Dashboard 活动流不再被噪声事件淹没 |
| fix | cds | dispatcher 抛错时 webhook 返回 200 (ok:false) 而不是 500,阻止 GitHub 按 8 小时策略重投递触发反复构建;错误仍在服务端日志记录 |
| fix | cds | 同一 (branchId, commitSha) 30 秒内重复 dispatch 自动去重,避免 push + check_run.rerequested + 延迟重投等多路径同 SHA 连续触发两次构建把第一次刚起的容器撕掉 |
| feat | cds | Dashboard 活动流的 GitHub webhook 条目追加事件名标签(如 "GitHub 推送 Webhook · push" / "· check_run" / "· issue_comment"),一眼分辨不同事件类型 |
| docs | doc | 新增 guide.cds-github-webhook-events.md:列出 CDS 必订的 7 个事件(push / pull_request / issue_comment / check_run / installation_repositories / delete / repository)、可选事件(ping / installation / release)、被静默过滤的噪声事件清单(check_suite / workflow_run / pull_request_review 等 20+ 种),以及 GitHub App 后台订阅配置步骤、self-test 验证方法、新增订阅 checklist |
