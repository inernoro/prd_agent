# CDS 教程 03 - 网页 + 后台 + MongoDB

横向场景③：在场景②基础上加一个 MongoDB infra，后端真实读写一条记录。

## 目录

- `frontend/index.html` — 点按钮调用 `/api/visit`
- `backend/` — Express + mongodb driver，写入并统计访问数，就绪探针 `/ready` 依赖 mongo 连上
- `cds-compose.yml` — frontend + backend + `mongodb` infra（含 healthcheck + named volume）

## 纵向②：cds-compose.yml 一键导入

```bash
cd cds/examples/tutorial-03-web-backend-mongo
python3 ../../../.claude/skills/cds/cli/cdscli.py verify . --min-score 90
python3 ../../../.claude/skills/cds/cli/cdscli.py scan . --apply-to-cds <projectId>
```

## 纵向①：直接配置（无 compose）

onboarding 选「前端(static)」+「后端(Node.js)」，并在 infra 区域加一个 MongoDB
preset，CDS 自动注入 `MONGODB_URL`。详见 `doc/guide.cds.tutorial.md` § 场景③。

## 预期结果

- app `frontend`（`/`）+ `backend`（`/api/`）+ infra `mongodb`
- 点按钮看到 `visits` 计数递增（数据落进 MongoDB）
