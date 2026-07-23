| fix | cds | 修复部署已失败但 GitHub check run 长期停留 in_progress 的问题：新增 CheckRunRunner.reconcileStale 周期收敛（每 5 分钟按 DeploymentRun/分支真实终态把滞留的 check run 补收尾为 failure/cancelled/success），不再只靠重启时的 reconcileOrphans |
| fix | cds | 部署被更高优先级操作取代（superseded）提前返回的路径补上 check run 收尾为 cancelled，不再留下永远转圈的黄灯 |
| fix | cds | 举一反三补齐两条「部署未启动、GitHub 彻底静默」的兄弟路径：webhook 部署派发失败、极速版等待 CI 镜像超时，均通过新增 CheckRunRunner.concludeWithoutDeploy 直接创建已完结的 failure check run，push 后 PR Checks 面板不再空无一物 |
