| refactor | prd-admin | AiChatPage 删除 RAF 攒批重构后残留的死 ref：liveTailByMessageRef / flushTimeoutRef / lastStreamingAssistantIdRef，三个都只剩 set/clear 没有 read。修复 PR #528 Bugbot review |
