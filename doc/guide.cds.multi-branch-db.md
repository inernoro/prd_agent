# CDS 多分支数据库隔离指南(Phase 5) · 指南

> **版本**：v1.0 | **日期**：2026-05-01 | **状态**：已落地

**一句话**：同一个数据库实例下按分支切库名做隔离，连接串自动跟随，避免多分支验收互相污染数据。
**谁该读**：开多分支验收的用户；写模板的工程师与 AI。
**读完能做什么**：开启隔离并知道哪些连接串会被自动改写、边界在哪。

---

> **覆盖范围**:`BuildProfile.dbScope` 字段;同一 mysql/postgres 实例下用 database name 隔离多分支
> **目标读者**:用户(开多分支验收时) + AI Agent(写 cdscli 模板表时)

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

项目默认值就是 `BuildProfile.dbScope`，入口在**项目设置 → 数据 → 数据库隔离**（2026-09-02 起）：

- 第一屏先给结论（几个服务共享库、几个分支独立库、几条分支有本分支覆盖）；
- 可以「全部设为共享库 / 全部设为分支独立库」批量设，也可以逐服务切；
- 每个服务会列出它会被改写的库名变量；**没声明库名变量的服务切了也不会有效果**，页面会直接提示；
- 保存是原子的：任何一项不合法整批不落盘。保存前会说明影响面——所有继承项目配置的分支
  重新部署后生效，已有本分支覆盖的分支保持不变。

对应 API（项目级，`assertProjectAccess` 守门，项目 key 只能改自己的项目）：

```bash
# 读：每个服务的生效档位 + 来源 + 会改写的 key + 分支覆盖概况
curl "$CDS/api/projects/<id>/db-isolation" -H "X-AI-Access-Key: $AI_ACCESS_KEY"

# 写：批量（all）或逐服务（services），两者同时给时 services 优先
curl -X PUT "$CDS/api/projects/<id>/db-isolation" \
  -H "X-AI-Access-Key: $AI_ACCESS_KEY" -H "Content-Type: application/json" \
  -d '{"all": "per-branch", "services": {"web": "shared"}}'
```

托管交付（managed）项目的 profile 由 CDS 自动生成，这个页签只读。

**新分支的独立库从哪来（2026-09-04 起）**：每个分支独立库的服务多一个「新分支初始化」下拉——

- **空库重跑迁移**（默认）：库由应用启动时自己建、自己跑 migration；
- **从共享库时间点克隆**：分支首次部署前，CDS 先把共享库整库复制到折算后的独立库（`app` → `app_feat_x`），
  应用一起来就能读到克隆时间点之前的数据，不必重跑迁移。克隆是时间点快照，之后共享库的写入不会同步。
  克隆完成后逐表数行数、与共享库比对，结果连同克隆时间点记进「派生库台账」；不一致的表会列出两边行数
  （最常见原因是克隆期间共享库又有写入），不会自动判死。目标库已经在实例上就跳过，不覆盖分支自己的数据。

只有认出 mysql / postgres 库名变量的服务能选克隆；mongo 的分支独立库暂时只有空库一条路（共享 mongo 实例
大批量写入会崩，复制集通道为此改用了专用实例，分支独立库还没接）。写法上与档位同一个 PUT：
`{"inits": {"api": "clone"}}`；分支覆盖也支持 `dbInit`。台账里选了克隆但还没建库的条目有「现在克隆」按钮，
走的是和部署前钩子同一条路径（`POST /api/branches/<id>/db-init/<profileId>`）。

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

**硬编码库名也会跟随（2026-09-03 起）**：写成 `DATABASE_URL: mysql://.../app`（库名段写死）的连接串，只要库名段等于某个会加后缀的库名变量的原值，就跟着一起改成 `app_feat_x`；服务里根本没有库名变量、只有一条硬编码的 JDBC / mysql / postgres / mongodb 串，串里的库名段直接加后缀。三种情况不动：库名段是 `${VAR}` 模板（展开后自然跟随）；库名段对不上本服务任何库名变量（指向别的库）——这条会在分支详情的配置检查器里标「连接串未跟随」，请核对；库名变量属于按项目约定不加后缀的框架家族（如 `MongoDB__DatabaseName`），它的连接串同样保持不动。引用形式仍是推荐写法，硬编码只是兜底。

---

## 4. 已知边界(MVP)

| 限制 | 影响 | 后续解决方案 |
|------|------|-------------|
| **空库方式不主动建库** | 初始化方式为「空库重跑迁移」时假定 mysql/postgres 镜像或 ORM migration 阶段会自动 `CREATE DATABASE IF NOT EXISTS`。多数 ORM(Prisma/EF/Sequelize)自带此行为;原生 SQL 项目可能要在应用启动加 `mysql -e "CREATE DATABASE..."` | 选「从共享库时间点克隆」则由 CDS 部署前建库并灌数据（2026-09-04 起）；空库方式的主动建库仍待 Phase 5.5+ |
| **mongo 独立库不支持时间点克隆** | mongo 服务只能选空库；共享 mongod 大批量写入会随机段错误（复制集隔离库为此改用专用实例） | 分支独立库接专用实例通道，或等共享实例升级到稳定版本后放开 |
| **删分支默认保留派生库** | 分支删除后 `app_<slug>` 库不自动 drop，转为项目设置「数据库隔离 → 派生库台账」里的孤儿条目 | 有意设计（2026-09-03 起）：数据不丢是第一位；在台账里先备份并演练验证，再丢弃；确实不要就复述库名强制丢弃。「扫描补录」能把历史残留库找回台账 |
| **migration 多分支冲突无警告** | 两个分支都改 schema 各自跑 migration,merge 时可能冲突 | Phase 5.5+ 部署前对比 git migration 文件 vs DB `__migrations` 表给警告 |
| **改项目默认不会自动重部署、不迁移存量数据** | 切到 per-branch 后旧共享库里的数据不会搬进分支库，分支要重新部署并重跑 migration | 有意设计：切库是重操作，重部署时机由用户决定；数据迁移走复制集「隔离库」能力 |
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
有 ORM migration 且并发开发          →  per-branch
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
- 是 shared 默认 → 现有项目零行为变化
- 是 per-branch 切换可用 → 多分支用户拿到独立 DB
- 进行中 UI 切换、自动建库、GC、冲突警告 → Phase 5.5+

Phase 6 实战时,挑一个 Prisma + MySQL 项目,把 backend 的 dbScope 设成 per-branch,验证多分支同时部署 → 各自跑 prisma migrate deploy 不冲突。

---

## 8. 关联文档

- [doc/spec.cds.compose-contract.md](./spec.cds.compose-contract.md) — cds-compose 完整契约 SSOT
- [doc/guide.cds.orm-support.md](./guide.cds.orm-support.md) — Phase 4 ORM migration 注入(per-branch 后,migration 命令在每个分支独立 DB 上跑一次)
- [doc/plan.cds.status.md](./plan.cds.status.md) — CDS 当前状态看板(mysql 接入完整里程碑见 §二)

---

## 实现来源

给要跳去看代码的人；只读这篇文档的人可以整块跳过。

| 位置 | 文件 | 作用 |
|------|------|------|
| 8. 关联文档 | `cds/src/services/db-scope-isolation.ts` | 实现 + 内联文档 |
