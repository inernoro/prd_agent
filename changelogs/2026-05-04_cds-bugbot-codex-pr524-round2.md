| fix | cds | 修复 [CDS 系统设置] /api/self-status 顶层 handler 暴露在 auth middleware 之前导致 commit SHA / 自更新历史无认证可读(Codex P2):移到 auth + agent key 之后、所有 /api router 之前,鉴权生效仍抢在 router 链前 |
| fix | cds | 修复 ?probe=remote 完整版 self-status 漏检 webBuildError 导致 GlobalUpdateBadge 在 build 失败时角标不亮(Bugbot Medium):branches.ts bundleStale 同时检 .build-error 文件,与轻量版保持一致 |
| fix | cds | 修复 GlobalUpdateBadge restarting 状态秒数 5s 跳一次造成"卡死"错觉(Bugbot Low):state.kind === 'restarting' 时启 1s setInterval 强制 re-render |
| fix | cds | 删除 GlobalUpdateBadge 中无用的 RefreshCw import + dummy export(Bugbot Low):死代码 |
| fix | cds | ConfirmAction onConfirm 抛异常兜底(Bugbot Medium):popover 已关 + 调用方未 try/catch 时不再 unhandled rejection,console.error 让开发可见 |
