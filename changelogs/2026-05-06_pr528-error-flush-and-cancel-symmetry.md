| refactor | prd-admin | error 路径删除多余的 flushPendingChunks 调用，由后续 stopStreaming 内置 flush 统一负责（避免 done/error 路径不对称导致难以理解）。修复 PR #528 Bugbot review |
| fix | prd-admin | deleteSession "双击取消"分支补 setActiveSessionId 恢复逻辑，与 toast undo 对称；之前删了当前活跃会话再双击取消，活跃态保持空白。修复 PR #528 Bugbot review |
