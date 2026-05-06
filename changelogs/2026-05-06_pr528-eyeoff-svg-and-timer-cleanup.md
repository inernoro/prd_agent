| fix | prd-desktop | 登录页 EyeOff SVG 路径错画成 y=12 横线（应为右上到左下斜划线）。改为对齐 lucide-react EyeOff 的 4 段路径。修复 PR #528 Bugbot review |
| fix | prd-admin | AiChatPage 增加 useEffect unmount cleanup，组件卸载时清掉所有 pendingDeleteTimers。避免用户在 5 秒撤销窗口内切走，timer 仍触发 DELETE + toast 在别的页面弹出的问题。修复 PR #528 Bugbot review |
