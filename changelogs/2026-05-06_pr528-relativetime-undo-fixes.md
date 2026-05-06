| fix | prd-admin | RelativeTime 修复未来跨午夜时间点掉到 "MM-DD HH:mm" 格式（应为 "X 小时后"）。"小时"分支对 future 不再要求 isSameDay。修复 PR #528 Bugbot review |
| fix | prd-admin | 撤销 toast 修复在用户 5 秒 undo 窗口内切换到别的会话时，撤销按钮强制还原为已删会话的 bug。改用函数式 setActiveSessionId(current => current === '' ? id : current)，仅在 active 仍为空时还原。修复 PR #528 Bugbot review |
