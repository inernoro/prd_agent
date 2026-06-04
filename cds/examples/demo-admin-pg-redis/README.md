# 运营管理台 Demo - Postgres + Redis

一个前后端分离的「管理后台」演示：左侧导航 + 顶部统计卡片 + 服务清单数据表。
全部通过官方镜像 + `command` + bind-mount 一键部署，无 Dockerfile、无 build 步骤。

## 演示了什么

- **静态前端**（`node:20-alpine` + `npx serve`）渲染一个真实管理后台外观：侧边栏、
  4 张统计卡片、可新增行的数据表，全部从后端 `/api` 拉取。
- **Node + Express 后端** 真实读写 PostgreSQL（`items` 表），并用 Redis 记一个访问计数器。
- **PostgreSQL** 通过 `init.sql` 首次启动建表并写入 4 条种子数据。
- **Redis** 带密码，缓存自增的访问量计数。

## 基础设施

| 服务 | 镜像 | 端口 | 说明 |
|------|------|------|------|
| postgres | `postgres:16-alpine` | 5432 | 命名卷 `postgres-data` + 挂载 `init.sql` 建表种子 |
| redis | `redis:7-alpine` | 6379 | 命名卷 `redis-data`，启动带 `--requirepass` |

连接串走 `x-cds-env` 的 `DATABASE_URL` / `REDIS_URL`，service 用 `${VAR}` 引用，密码不写死在 service env。

## 应用与端点

| 服务 | 路由前缀 | 容器端口 | 端点 |
|------|----------|----------|------|
| frontend | `/` | 4173 | 管理后台页面 |
| backend | `/api/` | 3000 | `GET /api/health`、`GET /api/items`、`POST /api/items`、`GET /api/visits` |

- `GET /api/health` — 返回 postgres + redis 连通性
- `GET /api/items` — 列出 Postgres `items` 表的行
- `POST /api/items` — 写入一行（body: `{ "name": "...", "status": "active" }`）
- `GET /api/visits` — Redis 计数器自增并返回当前值

## 验证一键导入 / 评分

```bash
python3 ../../../.claude/skills/cds/cli/cdscli.py verify .
```

## 「跑通了」的信号

1. 打开前端（`/`）能看到管理后台，统计卡「服务条目」显示 4、「后端状态」为「正常」。
2. 在「服务清单」表单里输入名称点「新增」，数据表立即多出一行（来自 Postgres）。
3. 每次刷新页面，「累计访问」数字递增（来自 Redis）。
4. `GET /api/health` 返回 `{"ok": true, "checks": {"postgres": {"ok": true}, "redis": {"ok": true}}}`。
