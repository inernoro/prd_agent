| feat | cds | 基础设施预设收敛为单一注册表 SSOT（src/services/infra-catalog.ts）：后端 createInfraPreset 改为读注册表，新增 Kafka / NATS / SQL Server / ClickHouse / Elasticsearch / MinIO / Memcached，消息队列与数据库一键可选，新增基建只需注册表加一条 |
| feat | cds | 新增 GET /api/infra/catalog 端点（按 database/cache/queue/search/storage 分类、脱敏不含密码），前端不再硬编码镜像/端口/连接变量名 |
| feat | cds | 一键部署项目弹窗的基础设施选择器改为读 /api/infra/catalog，按类别分组展示全部预设（含 Kafka/NATS），新增预设自动出现在 UI |
| feat | cds | 新增 4 个自包含示例工程（demo-admin-pg-redis / demo-queue-rabbitmq / demo-stream-kafka / demo-events-nats），均以 image+命令+挂载运行、cdscli verify 评级 A |
| test | cds | 新增 infra-catalog 单测 9 例（向后兼容 5 个旧预设、密码脱敏、卷启发式回退、Kafka KRaft 断言），全量 vitest 1796 通过 |
| docs | cds | 新增 design.cds-ai-compose（AI 借用 CDS Agent/OpenRouter 生成 compose 草稿的可选路径设计）+ plan.cds-visual-deploy（绝对可视化部署计划看板） |
| docs | cds | 新增 guide.cds-deploy-acceptance（部署+验收步骤指南）+ scripts/publish-cds-deploy-acceptance-kb.py，已发布到 prd-api 新知识库「CDS 部署验收知识库」（含主指南 + 4 个示例文档） |
