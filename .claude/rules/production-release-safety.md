# 生产发布安全触发规则

修改 `exec_dep.sh`、`fast.sh`、`deploy/nginx/**`、`docker-compose*.yml`、`.github/workflows/web-latest-pages.yml`、`.github/workflows/server-deploy.yml` 或其他生产发布入口前，必须完整阅读 `doc/rule.platform.production-release-safety.md`。

## 强制约束

1. 容器、API 或 Gateway 健康不等于用户页面健康；必须从公网验证 HTML 及其实际入口 JS/CSS。
2. 静态产物必须先在非在线目录完成权限、完整性和资源验证，再原子切换，并保留 previous。
3. 目录权限必须显式归一化为可遍历状态，测试必须覆盖 `umask 077`。
4. 已在生产使用的命令不能静默改变语义；`./exec_dep.sh release` 必须兼容 latest。
5. 发布失败必须指出首个失败阶段，并保存结构化证据和回滚结果。
6. 未取得公网最终入口证据时，禁止声称生产发布完成。

未偿实现项见 `doc/debt.platform.production-release.md`，不得因本规则已存在而将 open 债务误报为已实现。

## 技能路由

- 风险与代码复审：`risk-matrix` → `human-verify`。
- 灰度与接口验证：`cds-deploy-pipeline` → `smoke-test` → `preview-url`。
- 最终入口验收：`acceptance-checklist`。
- 正式环境最小发布：`production-hotfix-release`。
- 证据和债务收口：`task-handoff-checklist`。

技能只分工，不复制规则；发生冲突时以 `doc/rule.platform.production-release-safety.md` 为准。
