| fix | prd-admin | 演讲编辑器重新生成不再先抹掉旧节点：用 pendingClearRef 延迟到首个 node 事件再清，并发拒绝/HTTP 失败/SSE 早炸时保留上一轮 mindmap（Bugbot Medium "Regenerate clears nodes without restore"） |
