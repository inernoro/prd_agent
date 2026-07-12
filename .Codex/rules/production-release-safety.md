# Codex 生产发布安全触发规则

本文件只负责让 Codex 在接触生产发布链路时加载长期规则，不复制完整规范。

触发范围：`exec_dep.sh`、`fast.sh`、`deploy/nginx/**`、`docker-compose*.yml`、`.github/workflows/web-latest-pages.yml`、`.github/workflows/server-deploy.yml` 及生产发布、回滚、健康检查相关脚本。

开始修改或验收前必须完整阅读：

- `doc/rule.platform.production-release-safety.md`：唯一规则 SSOT。
- `doc/debt.platform.production-release.md`：尚未偿还的实现缺口。

硬约束：公网 HTML 与入口资源是完成门；API/容器健康不能替代；静态站必须原子切换；旧命令必须兼容；发布必须留下可追溯证据。
