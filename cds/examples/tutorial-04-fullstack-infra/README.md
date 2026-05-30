# CDS 教程 04 - 多体前后端分离 + Redis + MySQL + RabbitMQ

横向场景④（最复杂）：前后端分离 + 三种基础设施。本例由经过验证的
`cds/examples/fullstack-infra-smoke/` 同构而来，可直接部署冒烟。

## 目录

- `frontend/` — Vite 静态页，调用 `/api/health`
- `backend/` — Express 后端，依次检查 MySQL / Redis / RabbitMQ 三条连通性
- `mysql`（init.sql 建表）/ `redis` / `rabbitmq` 三个 infra
- `cds-compose.yml` — 2 个 app service + 3 个 infra，注入 `MYSQL_URL` / `REDIS_URL` / `RABBITMQ_URL`

## 纵向②：cds-compose.yml 一键导入

```bash
cd cds/examples/tutorial-04-fullstack-infra
python3 ../../../.claude/skills/cds/cli/cdscli.py verify . --min-score 90
python3 ../../../.claude/skills/cds/cli/cdscli.py scan . --apply-to-cds <projectId>
```

## 纵向①：直接配置（无 compose）

onboarding 选「前端(static)」+「后端(Node.js)」，infra 区域分别加 MySQL / Redis /
RabbitMQ 三个 preset。详见 `doc/guide.cds-tutorial.md` 场景④。

## 预期结果

- app `frontend`（`/`，4173）+ `backend`（`/api/`，3000）
- infra `mysql` + `redis` + `rabbitmq`
- 后端 `/api/health` 返回三种基础设施的检查结果都 ok
