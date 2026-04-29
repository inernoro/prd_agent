| fix | cds | stack-detector 三大修复：(1) 优先识别仓库根目录的 `cds-compose.yml`，命中后直接调用 parseCdsCompose 创建全部 BuildProfile + InfraService + 项目环境变量，无需再走启发式扫描；(2) 新增 `detectModules()` monorepo 感知扫描——根目录无 manifest 时自动遍历一级子目录，每个模块产生独立 profile（解决 prd_agent 这种 monorepo 被误判为 unknown 的根因）；(3) 兜底：仓库根只有 Dockerfile / docker-compose.* 时也建占位 profile，避免用户陷入"尚未配置构建配置"的死循环 |
| feat | cds | 分支卡「详情」按钮不再跳转 `/branch-panel/<id>` 整页，改为右侧 BranchDetailDrawer 抽屉就地打开；抽屉显示状态 / 服务列表 / 最近构建日志 + 「打开完整页面」转义；按 Esc / 点蒙版 / 点 X 关闭 |
| feat | cds | BranchFailureHint 在失败原因为「尚未配置构建配置」时，主操作改为「添加构建配置」（primary 色），直接跳到 `/settings/<projectId>` |
