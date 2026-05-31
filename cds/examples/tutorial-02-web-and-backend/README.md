# CDS 教程 02 - 网页 + 后台

横向场景②：前端静态站 + 后端 API，CDS 用 path 前缀把 `/api/` 路由到后端。

## 目录

- `frontend/index.html` — 前端，调用 `/api/health`
- `backend/` — Express 后端，暴露 `/api/health`、`/api/hello`、就绪探针 `/ready`
- `cds-compose.yml` — 两个 app service（path 前缀 `/` 与 `/api/`）

## 纵向②：cds-compose.yml 一键导入

```bash
cd cds/examples/tutorial-02-web-and-backend
python3 ../../../.claude/skills/cds/cli/cdscli.py verify . --min-score 90
python3 ../../../.claude/skills/cds/cli/cdscli.py scan . --apply-to-cds <projectId>
```

## 纵向①：直接配置（无 compose）

onboarding 同时启用「前端服务(static)」+「后端服务(Node.js)」。详见
`doc/guide.cds-tutorial.md` § 场景②。

## 预期结果

- app service `frontend`（`/`，4173）+ `backend`（`/api/`，3000）
- 打开预览域名点按钮，看到后端返回的 JSON
