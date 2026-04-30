| feat | cds | 分支详情抽屉部署 tab 升级到 Railway 心智：顶部一张「当前部署」大卡承载 4 阶段状态树（拉取代码 / 构建镜像 / 启动服务 / 健康检查），剩余历史折叠成 5 行 + 「显示全部」 |
| feat | cds | 部署失败按阶段定位：build 缺 BuildProfile → 主按钮「修复构建配置」直跳项目设置；deploy / verify 阶段失败给出「重置异常」「重新诊断」「查看完整日志」 outline 入口 |
| feat | cds | 新增 `cds/web/src/lib/deploymentPhases.ts` 纯函数：日志 + 终态 + 错误信息归纳为阶段状态树，保守降级（短日志单 build 占位）+ 失败传播 + errorMessage 注入 |
| feat | cds | 新增 `PhaseTree / ActiveDeployment / HistoryRow` 组件，颜色全走 Tailwind token + cds-surface 系列，禁止暗色字面量 |
| refactor | cds | BranchDetailDrawer 部署 tab 旧 `DeploymentCard / LegacyDeploymentCard` 函数保留为 export 顶层声明，不再被默认渲染；新通道经 `legacyLogToDeploymentItem` 把 OperationLog 投影成统一 BranchDeploymentItem 后渲染 |
| docs | cds | 更新 `doc/plan.cds-web-migration.md` Week 4.7 章节 + 进度日志；同步 `doc/guide.cds-web-migration-runbook.md` 第 7 节 |
