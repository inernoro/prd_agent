| chore | cds | 删除 self-update handler 里未引用的 startedIso 变量(Bugbot Low) |
| fix | cds | 修复 WorktreeService 构造测试的错误参数(Bugbot Medium):multi-project-e2e + view-parity.smoke 都传了非签名要求的额外位置参数,仅靠 JS 运行时容忍(extra args 丢弃)。统一为单参数 (shell) 与 src/services/worktree.ts:70 的 `constructor(private readonly shell: IShellExecutor)` 对齐 |
