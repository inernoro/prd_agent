| refactor | cds | 解耦本地多用户账号与 GitHub OAuth，并保留原始账号密码登录 |
| fix | cds | 账号密码模式开放用户管理与用户痕迹能力 |
| fix | cds | 修复 macOS Bash 3.2 写入含单引号环境变量时的二次转义 |
| security | cds | 收紧普通本地账号的系统所有者边界并统一敏感路由判据 |
| fix | cds | 登录与退出时清理另一套会话 Cookie，避免旧身份回退 |
| test | cds | 补充普通账号越权、持久化所有者与登录切换回归 |
| test | cds | 补齐分支分组接口的窄屏布局离线数据 |
| security | cds | 收紧项目迁移为仅系统所有者可执行并阻断普通本地账号外泄密钥 |
| fix | cds | 让持久化本地会话可以处理授权申请并记录真实审批账号 |
| fix | cds | 统一远程运行管理的人类所有者判据并拒绝普通账号提权 |
| fix | cds | 切换本地账号、原始账号、GitHub OAuth 与 SSO 时清理其他人类会话 Cookie |
