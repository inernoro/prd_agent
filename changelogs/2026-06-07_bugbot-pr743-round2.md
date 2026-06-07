| fix | prd-admin | GitHub 日志刷新合并 tail 时未保留 cursor：原本用 first-page 的 nextCursor 续接，会拉回已经在 preservedTail 里的同一批产生重复条目，改为保留 previous.hasMore / previous.nextCursor |
| fix | prd-admin | GitHub 日志 loadMoreGitHubLogs stale-response 保护：开始时快照 githubLogsRef，若等待期间 refresh 完成（latest.logs 已不含 requestedCursor），丢弃旧 cursor 的延迟响应避免污染新列表 |
| fix | prd-admin | 用户手动「刷新」（force=true）时不再保留旧 fragments tail：尊重用户明确的「全量重载」意图，仅 SSE/后台刷新路径保留 tail |
