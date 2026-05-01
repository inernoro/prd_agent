# CDS 多分支数据库隔离指南(Phase 5)

> **类型**:guide(操作指南) | **版本**:1.0 | **最后更新**:2026-05-01
> **覆盖范围**:`BuildProfile.dbScope` 字段;同一 mysql/postgres 实例下用 database name 隔离多分支
> **目标读者**:用户(开多分支验收时) + AI Agent(写 cdscli 模板表时)

---

## 0. 30 秒读懂

CDS 多分支同时部署同一项目时,默认所有分支共用一个 `app` 库。一个分支跑了破坏性 migration,**所有分支都炸**。

Phase 5 给 `BuildProfile` 加了 `dbScope` 字段:

| 模式 | 含义 | 用什么时候 |
|------|------|-----------|
| `shared`(默认) | 所有分支共用同一 database | 简单项目 / 仅 SELECT / 数据共享有意义 |
| `per-branch` | 每个分支独立 database(同一 DB 实例,不同 db name) | 含 migration / 数据隔离 / 多人并发开发 |

切到 `per-branch` 后,容器收到的 env 自动后缀分支 slug:

```
原 env:    MYSQL_DATABASE=app
分支 main:  MYSQL_DATABASE=app_main
分支 feat/x: MYSQL_DATABASE=app_feat_x
```

连接串通过 `${MYSQL_DATABASE}` 引用,自动跟随。互不干扰,互不破坏。

---

## 1. 怎么开启

### 1.1 给整个项目开(推荐)

修改 BuildProfile 的 `dbScope` 字段(目前手动改 yaml,UI 切换在后续 phase 加):

```yaml
services:
  backend:
    image: node:20
    # ... 其它字段
    # 后续 cds 会读这个 label 转成 BuildProfile.dbScope
    labels:
      cds.db-scope: "per-branch"
```

> **TODO Phase 5.5**:`cdscli scan` 自动给含 schemaful infra 的项目默认设 `dbScope: per-branch`,目前需要手改。

或直接调 CDS API:

```bash
curl -X PUT "$CDS/api/projects/<id>/build-profiles/backend" \
  -H "X-AI-Access-Key: $AI_ACCESS_KEY" \
  -H "Content-Type: application/json" \
  -d '{"dbScope": "per-branch"}'
```

### 1.2 给单个分支开(覆盖 baseline)

如果 baseline 是 `shared`,但 main 分支要做大改不能污染共享库:

```bash
curl -X PUT "$CDS/api/branches/main/profile-overrides/backend" \
  -H "X-AI-Access-Key: $AI_ACCESS_KEY" \
  -H "Content-Type: application/json" \
  -d '{"dbScope": "per-branch", "notes": "大改 schema 期间隔离"}'
```

---

## 2. 自动后缀的 env key 列表

只有这些 key 会被改写,其它一律不动(白名单制度,杜绝意外破坏):

| Env Key | 适用 DB |
|---------|--------|
| `MYSQL_DATABASE` | MySQL |
| `MARIADB_DATABASE` | MariaDB |
| `POSTGRES_DB` | PostgreSQL |
| `POSTGRESQL_DB` | PostgreSQL(别名) |
| `MONGO_INITDB_DATABASE` | MongoDB |

新加 DB 类型只需在 `cds/src/services/db-scope-isolation.ts` 的 `PER_BRANCH_DB_ENV_KEYS` 数组追加。

**不在列表的 key 不动**(如 `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_ROOT_PASSWORD` 都保持不变,用户认证还是同一套)。

---

## 3. 连接串如何跟随

cdscli scan 生成的模板默认走 `${VAR}` 引用形式:

```yaml
x-cds-env:
  MYSQL_DATABASE: "app"
  DATABASE_URL: "mysql://${MYSQL_USER}:${MYSQL_PASSWORD}@mysql:3306/${MYSQL_DATABASE}"
                                                                       # ↑ 这里跟随
```

per-branch 模式下:
- `MYSQL_DATABASE` → `app_feat_x`
- `${MYSQL_DATABASE}` 在连接串里展开成 `app_feat_x`
- 应用拿到 `mysql://...:.../app_feat_x` 自动连对库

**不要硬编码 DB 名**:如果你写 `DATABASE_URL: mysql://.../app`(硬编码 `app` 而不是 `${MYSQL_DATABASE}`),per-branch 模式就失效。改成引用形式即可。

---

## 4. 已知边界(MVP)

| 限制 | 影响 | 后续解决方案 |
|------|------|-------------|
| **不主动建库** | 假定 mysql/postgres 镜像或 ORM migration 阶段会自动 `CREATE DATABASE IF NOT EXISTS`。多数 ORM(Prisma/EF/Sequelize)自带此行为;原生 SQL 项目可能要在应用启动加 `mysql -e "CREATE DATABASE..."` | Phase 5.5+ scheduler 部署前主动建库 |
| **不清理** | 分支删除后 `app_<slug>` 库残留,占 disk | Phase 5.5+ 加 GC,删分支时 drop 库 |
| **migration 多分支冲突无警告** | 两个分支都改 schema 各自跑 migration,merge 时可能冲突 | Phase 5.5+ 部署前对比 git migration 文件 vs DB `__migrations` 表给警告 |
| **dbScope UI 切换暂未做** | 现在手 PUT API 或改 yaml | Phase 5.5+ prd-admin 加切换 toggle |
| **不支持每分支独立 mysql 实例** | 所有分支共用同一容器,只是 db name 不同。disk 用一份 | 设计取舍:per-branch instance 太重,本 MVP 不做 |

这些边界**不阻塞**北极星目标"多分支不互相破坏数据" — 核心隔离机制已 work。

---

## 5. 何时选哪种模式

```
项目特征                            → 推荐 dbScope
─────────────────────────────────────────────────
无数据库                            → 不适用(本 phase 不影响)
有 DB 但纯 SELECT(报表 / 看板)      → shared
有 INSERT/UPDATE 但无 schema 改动    → shared
有 ORM migration 且并发开发          → ★ per-branch
学习项目 / hello-world               → shared
生产 staging                        → 取决于团队,通常 shared(数据共享)
```

简单原则:**有 ORM migration → per-branch;否则 shared**。

---

## 6. 实现 SSOT 索引

| 主题 | 文件 | 关键函数 / 字段 |
|------|------|----------------|
| 类型定义 | `cds/src/types.ts` | `BuildProfile.dbScope` / `BuildProfileOverride.dbScope` |
| profile 合并 | `cds/src/services/container.ts` | `applyProfileOverride`(包含 dbScope) |
| 隔离助手 | `cds/src/services/db-scope-isolation.ts` | `applyPerBranchDbIsolation` / `slugifyBranchForDb` / `previewPerBranchDbDiff` |
| 注入位置 | `cds/src/services/container.ts:runService` | mergedEnv 收集后、resolveEnvTemplates 前 |
| 测试 | `cds/tests/services/db-scope-isolation.test.ts` | 17 case |

---

## 7. 给接力 AI 的话

Phase 5 MVP 完成的核心是 *机制存在 + 默认安全*:
- ✅ shared 默认 → 现有项目零行为变化
- ✅ per-branch 切换可用 → 多分支用户拿到独立 DB
- ⏳ UI 切换、自动建库、GC、冲突警告 → Phase 5.5+

Phase 6 实战时,挑一个 Prisma + MySQL 项目,把 backend 的 dbScope 设成 per-branch,验证多分支同时部署 → 各自跑 prisma migrate deploy 不冲突。

---

## 8. 关联文档

- `doc/spec.cds-compose-contract.md` — cds-compose 完整契约 SSOT
- `doc/guide.cds-orm-support.md` — Phase 4 ORM migration 注入(per-branch 后,migration 命令在每个分支独立 DB 上跑一次)
- `doc/plan.cds-mysql-readiness.md` — 6 阶段计划
- `cds/src/services/db-scope-isolation.ts` — 实现 + 内联文档
