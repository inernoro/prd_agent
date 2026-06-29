| fix | cds | 修复项目创建自动检测误把 CDS 控制面、sidecar 和测试目录识别为应用服务的问题；compose 基础设施改为检测提示并由 compose 导入，无 command 的 compose 应用服务也会出现在创建预览中，带 workDir 的 compose 命令会在对应子目录验证 |
| chore | scripts | Git hooks 安装脚本新增 post-checkout 钩子，checkout/worktree 后自动补齐 .claude/skills 到 .agents/skills 的本地链接 |
