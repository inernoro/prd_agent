| fix | cds | runInProcessWebBuild fast-path 命中时清理残留 .build-error，避免 transient 失败留下的 stale 错误被新一次"成功复用"压不掉（Codex P2 报告） |
| fix | prd-admin | SkillAgentPage 的 showToast 加 useRef 缓存 timer 句柄 + clearTimeout，连续触发时新 toast 不会被旧 setTimeout 提前关掉；卸载时统一清理（Bugbot Low 报告） |
