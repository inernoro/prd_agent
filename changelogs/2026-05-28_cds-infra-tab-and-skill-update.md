| feat | cds | 项目设置新增「基础设施」Tab(`ProjectSettingsPage.tsx`):列出该项目所有 infra 容器(mongo/redis/minio/postgres 等),支持启动/停止/删除。修复"openvisual 烂 minio infra 没法在 UI 删,只能调 API DELETE"的 UX 缺陷 |
| docs | cds | 更新 `cds-project-scan` / `cds` 技能文档 + `cdscli.py` 错误提示:Agent 提交 pending-import 后**不再需要主动告诉用户审批 URL**——CDS Dashboard 任意已登录页面右下角会自动弹出"Agent 导入 N"徽章(2026-05-28 起)。直达链接保留作 fallback |
