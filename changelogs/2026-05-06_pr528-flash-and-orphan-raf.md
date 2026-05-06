| fix | prd-admin | 撤销 toast 真删后会话短暂闪回修复：finalize 成功路径加 setSessions 本地直接 filter，避免 pendingDeleteIds 先清但 sessions 未刷新中间帧 visibleSessions 渲染回已删会话。修复 PR #528 Bugbot review |
| fix | prd-admin | flushPendingChunks 顶部改为主动 rafCancel 已排程 RAF（之前只无条件清 ref，stop/done/error 直调时留下孤儿 RAF）。修复 PR #528 Bugbot review |
