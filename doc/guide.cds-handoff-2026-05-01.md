# CDS 综合交接文档(2026-05-01)

> **类型**:guide(接力指南) | **作者**:Claude (Opus 4.7) · **接力**:可委托任意下一个 AI / 开发者
> **当前分支**:`codex/migrate-cds-settings`(用户准备关闭)
> **下一阶段**:可在新分支(建议命名 `claude/cds-mysql-readiness` 或类似)继续

## 0. 30 秒读懂

本分支累计完成 **2 大块工作**:
1. **CDS Web 前端 React 迁移**(Week 2-4.8,~30 个 commit)
2. **CDS MySQL 接入鲁棒性 Phase 1+2**(本会话末尾)

**当前状态**:Phase 1+2 已 push,**Phase 2.5(四剑客补强)+ Phase 3-6 待做**。详细计划在 `doc/plan.cds-mysql-readiness.md`。

**用户的核心诉求**(从对话总结):
- 让 CDS 能"丝滑"接入任意项目(尤其 schemaful DB:MySQL/SQL Server/Postgres)
- 不破坏已有数据(强网络隔离 / 项目级独占)
- 出了问题不停在路上,主动找 + 修 + 测试 + 文档
- 接力可续 — 每阶段独立交付 + 文档同步

---

## 1. 已完成工作总览(本分支)

### 1.1 Web 前端迁移阶段(Week 2 - 4.8)

| 阶段 | 内容 | 关键 commit |
|---|---|---|
| Week 2-4 | `/cds-settings` `/project-list` `/branches` `/branch-panel` `/branch-topology` `/settings/:id` 全部迁到 React | 见 `doc/plan.cds-web-migration.md` § 七进度日志 |
| Week 4.6 | 视觉重构(AppShell + surface tokens + Railway-style 卡片) | 见 plan |
| Week 4.7 | 部署阶段树 + Active/History 分流(Drawer 内) | `0d78beb0` |
| Week 4.8 | 加载优化(git fetch cache)+ 卡片极简化 + Drawer URL chip + reset/retry CTA | `4c25dd1e` `00452b65` `658f9b2a` |

详细看 `doc/plan.cds-web-migration.md` + `doc/guide.cds-web-migration-runbook.md` + `doc/guide.cds-web-migration-handoff.md`。

### 1.2 cdscli + 海鲜市场升级

| 阶段 | 内容 | commit |
|---|---|---|
| Phase A | cdscli scan 加 12 种基础设施模板(Railway-style)+ 强随机密码 + 智能 ${VAR} 引用 | `5bf3e75d` |
| Phase B | 后端 `MarketplaceSkill` 加 slug + version 字段 + 幂等覆盖上传 + OpenApi DELETE | `9c6f8415` |
| Phase C | cdscli http/https 自动识别 + scan env carry-over | `beec6ec3` `2b3325ed` |

技能上传到海鲜市场(id `d222b312d95347e4aee56bf80cc304aa`)。

### 1.3 网络隔离重构

| 阶段 | 内容 | commit |
|---|---|---|
| Per-project network | ContainerService 用 `Project.dockerNetwork`(`cds-proj-<id>`)替代系统级共享网络;9 个测试 case;legacy default 跳过保护 | `2b9ebac9` |

### 1.4 MySQL 接入鲁棒性(Phase 1+2)

| Phase | 内容 | commit |
|---|---|---|
| **Phase 1** | `${VAR}` 嵌套展开(fixed-point iteration)+ startInfraService 接收 customEnv + 5 个 caller 同步 + 8 case 单测 | `8a618a40` |
| **Phase 2** | deploy 兜底起项目所有未运行 infra(以 docker 实际状态为准)+ discoverInfraContainers Map key 改 containerName(修跨项目同名 bug)+ 77 个测试全绿 | `95d5aa92` |

geo 项目(MongoDB)实战通过 — 删 mongo 容器后 deploy 自动起,backend `MongoDB connection successful`。

---

## 2. 当前未完成工作(从这里继续)

### 2.1 Phase 2.5 — 四剑客补强 ⭐(立刻做,0.5 天)

**为什么先做**:Phase 1+2 修了表面 bug,但**没系统化补四剑客**(代码 / 文档 / 技能 / 测试)。下面 7 个根因仍可能在新场景重现。

**工作清单**:

- [ ] 2.5.1 写 `doc/spec.cds-compose-contract.md` — cds-compose 完整契约 SSOT,集中写:
  - `x-cds-env` 嵌套 `${VAR}` 展开规则(已实现,但没文档)
  - `cds.path-prefix` label 语义(strip vs no-strip)
  - `volumes:` 相对路径必须仓库根存在(geo 踩过)
  - `dependsOn` 行为(声明 → 自动起;不声明 → Phase 2 兜底)
  - 预览域名 v3 公式(SSOT 在 `cds/src/services/preview-slug.ts`)
  - 应用 service `containerPort` 必须与应用真实监听端口一致(geo frontend 踩过)
- [ ] 2.5.2 测试 `tests/services/discover-infra-cross-project.test.ts` — 验证 2 个项目都有 svc.id='mongodb' 时,discover 用 containerName 隔离不撞 key
- [ ] 2.5.3 测试 `tests/routes/deploy-auto-infra.test.ts` — branch deploy 时 mongo 容器 Exited,验证 deploy 自动起 + SSE 流出 `infra-mongodb` event
- [ ] 2.5.4 测试 `tests/services/state-vs-docker-sync.test.ts` — state 写 running 但 docker 实际不存在时,deploy 流程不被 stale state 误导
- [ ] 2.5.5 cdscli `verify` 子命令 — `cdscli verify [path]` 跑 scan 后立刻校验生成的 yaml:
  - volumes 相对路径在仓库内存在
  - 应用 service `containerPort` 跟 webpack.config.js / appsettings.json 自洽
  - 命中 schemaful DB(mysql/postgres/sqlserver)时提示"建议加 ORM migration 命令"
  - 输出 warning + 修复建议
- [ ] 2.5.6 cds 技能 SKILL.md 加 "**已知 7 类常见漏洞 + 自检清单**" 段(放在文件中部),给后续 agent 直接参考避免再踩
- [ ] 2.5.7 changelog `2026-05-XX_cds-mysql-readiness-phase-2-5-quad-reinforcement.md` + plan 进度同步

**完成判定**:
- 任意 caller 改 helper 时,有契约测试拦住跨项目 bug
- 任意 agent 写 cds-compose 时,doc 是单点查询源
- 任意用户跑 cdscli scan 时,verify 提前给警告
- 后续 agent 接手时,SKILL.md 直接告诉它"这 7 类坑别再踩"

### 2.2 Phase 3 — cdscli scan 普适增强(1 天)

修 must-fix 4-7(volumes carry-over / wait-for-infra / url-encode / port 推断)。

**工作清单**:

- [ ] 3.1 `_parse_compose_services` 解析 `volumes:` 段(支持 list/dict 两种 yaml 形式)
- [ ] 3.2 `_yaml_from_compose_services` 把 volumes carry over(尤其 init.sql 挂 `/docker-entrypoint-initdb.d/`)
- [ ] 3.3 mysql/postgres/sqlserver 模板加 `init.sql` 挂载示例 + 注释"修改 init.sql 必须重置 data volume"(MF-6)
- [ ] 3.4 `_gen_password` 改用 `secrets.token_urlsafe(16)` 去掉 `!` 后缀(避免 URL 编码麻烦)+ url-encode helper
- [ ] 3.5 应用 service 命中 schemaful DB 时,自动前缀 `until nc -z mysql 3306; do sleep 1; done && ` wait-for(MF-7)
- [ ] 3.6 应用 service `containerPort` 推断:
  - node 项目读 `package.json` `scripts.dev` 找 `--port`
  - webpack.config.js 找 `devServer.port`
  - .NET 项目读 `appsettings.Development.json` `Kestrel.Endpoints` 或 `Properties/launchSettings.json`
- [ ] 3.7 4 场景 fixture 测试(prd_agent SSOT 直读 / 含 mysql + init.sql / wait-for 不重复添加 / 密码 url-encode)
- [ ] 3.8 changelog

**完成判定**:任意带 mysql + init.sql 的 docker-compose 项目,scan 输出的 yaml 直接能导入跑(用户不手改)。

### 2.3 Phase 4 — ORM 识别 + Migration 注入(1.5 天)

修 must-fix 3 + 8 — **MongoDB vs MySQL 接入丝滑度差异的核心**。

**工作清单**:

- [ ] 4.1 `_detect_orm(root) -> Optional[OrmKind]`:
  - `prisma/schema.prisma` → prisma
  - `**/Migrations/*.cs` + csproj 含 `Microsoft.EntityFrameworkCore` → ef-core
  - `migrations/*.ts` + package.json 含 typeorm → typeorm
  - `**/migrations/*.js` + sequelize → sequelize
  - `db/migrate/*.rb` → rails
  - `migrations/*.sql` + flyway.conf → flyway
- [ ] 4.2 各 ORM migration 命令模板(应用启动前缀):
  ```
  prisma:    npx prisma migrate deploy && <原 command>
  ef-core:   dotnet tool restore && dotnet ef database update && <原 command>
  typeorm:   npm run migration:run && <原 command>
  sequelize: npx sequelize-cli db:migrate && <原 command>
  flyway:    flyway migrate && <原 command>
  ```
- [ ] 4.3 dev/prod 模式区分:`x-cds-deploy-modes` 描述,dev 加 seed,prod 不加
- [ ] 4.4 scan 输出 `signals.orm` 字段
- [ ] 4.5 写 `doc/guide.cds-orm-support.md`(每种 ORM 支持状态 + 边界)
- [ ] 4.6 测试 fixture(5 种 ORM 项目识别正确)
- [ ] 4.7 changelog

**完成判定**:接 prisma + mysql 项目,scan 输出 backend command 自动含 migration,部署后 schema 自动建。

### 2.4 Phase 5 — 多分支 DB 共享/独立(1.5 天)

技术债已登记。等 Phase 3-4 完成后做。

**工作清单**:

- [ ] 5.1 BuildProfile 加 `dbScope: 'shared' | 'per-branch'` 字段(默认 shared)
- [ ] 5.2 `per-branch` 模式:scheduler 注入 `MYSQL_DATABASE=app_${branchSlug}` 替换 customEnv 默认值
- [ ] 5.3 多分支 migration 冲突警告:对比 git migration 文件清单 vs DB `__migrations` 表
- [ ] 5.4 prd-admin UI:BuildProfile 编辑页加 dbScope 切换 + 提示
- [ ] 5.5 `doc/guide.cds-multi-branch-db.md`
- [ ] 5.6 changelog

### 2.5 Phase 6 — 真实 MySQL 项目实战(0.5 天)

接力者:挑 1 个开源 mysql + ORM 项目(候选:`dotnet/eShop` EF Core + MySQL / 一些 Prisma 示例 / nestjs-typeorm starter),走完整流程,记录所有手工干预点。

---

## 3. 接力快速上手

### 3.1 必读文件(按顺序)

```
1. 本文件 (doc/guide.cds-handoff-2026-05-01.md)        ← 你正在读
2. doc/plan.cds-mysql-readiness.md                     ← 6 阶段完整计划
3. doc/plan.cds-web-migration.md                       ← Web 迁移历史背景
4. cds/CLAUDE.md                                       ← CDS 模块约束
5. cds/.claude/rules/scope-naming.md                   ← 系统级 vs 项目级 命名约束
6. .claude/skills/cds/SKILL.md                         ← cdscli 触发词 + 决策规则
7. cds/src/services/preview-slug.ts                    ← 预览域名 SSOT
```

### 3.2 实战工具链

**本机 CDS daemon**:
```bash
cd cds && ./exec_cds.sh start --fg    # 前台启动(便于看日志)
cd cds && ./exec_cds.sh restart       # 重启(改了 src 必须 restart)
cd cds && ./exec_cds.sh stop
cat cds/cds.log                        # 守护进程日志
```

**本机 CDS API 认证**:
```bash
# 当前测试 key 在 /tmp/cds-test-key.txt
export CDS_HOST="127.0.0.1:9900"
export AI_ACCESS_KEY=$(cat /tmp/cds-test-key.txt)
curl -sS -H "X-AI-Access-Key: $AI_ACCESS_KEY" http://127.0.0.1:9900/api/projects
```

如果 key 不存在,创建步骤:
```bash
PLAIN_KEY="cdsg_$(python3 -c "import secrets; print(secrets.token_urlsafe(24))")"
HASH=$(python3 -c "import hashlib; print(hashlib.sha256('$PLAIN_KEY'.encode()).hexdigest())")
KEY_ID=$(python3 -c "import secrets; print(secrets.token_hex(4))")
mongosh "mongodb://127.0.0.1:27018/cds_state_db" --quiet --eval "
  db.cds_global_state.updateOne(
    {_id: 'global'},
    {\$set: {'state.globalAgentKeys': [{
      id: '$KEY_ID', label: 'auto-test-bootstrap',
      hash: '$HASH', scope: 'rw',
      createdAt: new Date().toISOString(), createdBy: 'agent-cdscli-auto'
    }]}}
  );"
echo "$PLAIN_KEY" > /tmp/cds-test-key.txt
./exec_cds.sh restart
```

**测试**:
```bash
pnpm --prefix cds exec tsc --noEmit                                 # 类型检查
pnpm --prefix cds exec vitest run tests/services tests/routes       # 全跑
pnpm --prefix cds exec vitest run tests/services/compose-parser.test.ts  # 单文件
```

**cdscli**:
```bash
CLI=/Users/inernoro/project/prd_agent/.claude/skills/cds/cli/cdscli.py
python3 $CLI scan /path/to/project           # 扫描输出 yaml
python3 $CLI scan --apply-to-cds <projectId> /path  # 提交 pending-import
python3 $CLI health                          # CDS 健康
python3 $CLI project list                    # 列项目
```

**geo 实战项目**:
```
本地路径:    /Users/inernoro/project/geo
GitHub:      https://github.com/noroenrn/geo
CDS 项目 id: 76de6f934762
分支 id:     geo-master
预览端口:    backend :10017 / frontend :10018 / mongo :10016
```

### 3.3 验证 Phase 1+2 没回归

```bash
# 1. 删 mongo 容器(模拟"基础设施挂了")
docker stop cds-infra-geo-mongodb && docker rm cds-infra-geo-mongodb

# 2. 直接 deploy
curl -sS -X POST "http://127.0.0.1:9900/api/branches/geo-master/stop" -H "X-AI-Access-Key: $(cat /tmp/cds-test-key.txt)"
curl -sS -N -X POST "http://127.0.0.1:9900/api/branches/geo-master/deploy" -H "X-AI-Access-Key: $(cat /tmp/cds-test-key.txt)" --max-time 120 | grep -E "infra-mongodb|done"

# 3. 必须看到:
#    infra-mongodb running → done :10016     (Phase 2 工作)
#    backend env 里 MongoDB__ConnectionString 完整展开成 mongodb://root:xxx@... (Phase 1 工作)

docker exec cds-geo-master-backend-geo env | grep MongoDB__Conn
# 期望: mongodb://root:aE7aB6...!@mongodb:27017/admin?authSource=admin
```

---

## 4. 实战教训(geo 7 个冲突 → 永远别再踩)

| # | 现象 | 根因 | 修在哪个 Phase |
|---|---|---|---|
| 1 | `${MONGODB_URL}` 在 backend env 字面量 | resolveEnvTemplates 不递归 | Phase 1 ✅ |
| 2 | mongo 容器没起,backend `Name or service not known` | deploy 流不自动起 infra(要 dependsOn) | Phase 2 ✅ |
| 3 | 跨项目 mongo 撞 Map key | discoverInfraContainers 用 svc.id 不唯一 | Phase 2 ✅(顺手) |
| 4 | workDir 错位(`./sgeo/backend` 远程不存在) | CDS 信赖 yaml 不校验 | Phase 2.5(verify) + Phase 3 |
| 5 | frontend webpack 监听 :8000 不是 :3000 | webpack.config 硬编码,scan 不读 | Phase 3 |
| 6 | CDS 不重新 detect 改后的 cds-compose | first clone 后 detect 不再跑 | Phase 3(`cdscli sync-compose`) |
| 7 | 预览域名拼成 `geo-master.localhost` | SSOT 存在但 agent 凭直觉拼 | SKILL.md 已固化 ✅ |

**所有 7 类问题的根因模板**:
> 代码 / 文档 / 技能 / 测试 任一剑客缺失,bug 就潜伏。修必须四剑客同步。

---

## 5. 关键约定 / SSOT 引用

### 5.1 预览域名公式(`cds/src/services/preview-slug.ts:computePreviewSlug`)

```
有 prefix:  ${tail}-${prefix}-${projectSlug}.miduo.org
无 prefix:  ${tail}-${projectSlug}.miduo.org   (中段省略)
```

例:
- `master` + `geo` → `master-geo.miduo.org` ✓
- `claude/fix-x` + `prd-agent` → `fix-x-claude-prd-agent.miduo.org` ✓
- ❌ 永远不要写 `geo-master.miduo.org`(顺序反了)/ `master-geo.localhost:5500`(本机不走域名)

### 5.2 命名规范(`cds/.claude/rules/scope-naming.md`)

- 系统级 vs 项目级 必须明示,不允许裸用"设置"
- API 路径:系统级 `/api/cds-system/*`,项目级 `/api/projects/:id/*`(禁用 `?project=` query)
- 状态字段:跨项目共享放 `CdsState`,项目独占放 `Project.xxx`

### 5.3 cds-compose 关键字段(`cds/src/services/compose-parser.ts`)

```yaml
x-cds-project:   { name, description, repo }
x-cds-env:        # 项目级共享变量,支持 ${VAR} 嵌套(2026-05-01 起)
x-cds-deploy-modes: # dev/static 模式区分
services:
  <name>:
    build / image
    working_dir / volumes
    ports
    environment    # ${VAR} 引用 x-cds-env
    labels:
      cds.path-prefix: "/api/"   # 路由转发前缀,no-strip
```

### 5.4 BuildProfile 字段(`cds/src/types.ts`)

```ts
{ id, name, projectId, dockerImage, workDir, containerWorkDir,
  command, containerPort, env, dependsOn, pathPrefixes }
```

注意:`workDir` 是相对仓库根的子目录,**会被 mount 到容器的 `containerWorkDir`**。Phase 2.5 verify 命令必须校验此路径在仓库内存在。

### 5.5 InfraService 字段

```ts
{ id, projectId, name, dockerImage, containerPort, hostPort,
  containerName, status, volumes, env, healthCheck }
```

`containerName` 格式:`cds-infra-{projectSlug}-{id}`,**全局唯一**。Phase 2 改用此字段当 discover Map key 即因此。

---

## 6. 不要做的事

| ❌ 不要 | 原因 |
|---|---|
| 删除 `cds/web-legacy/` | 用户明确要求保留作为功能对照,Week 5 才考虑 |
| 重新引入 `/v2` URL 前缀 | URL 永远干净 |
| 在 cds 任何输出加 emoji(包括 commit / 文档 / UI / SVG label) | 根 CLAUDE.md §0 + cds CLAUDE.md §0 |
| 在 `cds/web/` 用 `localStorage` | 必须 `sessionStorage`(`.claude/rules/no-localstorage.md`) |
| 写 `var(--xxx, #darkColor)` fallback | 暗色 fallback 在 light theme 下泄漏(用户已第 10+ 次反馈) |
| 跳过 build / tsc / vitest 直接 push | Phase 全过才 push(Phase 1+2 都做了) |
| 改 `setCustomEnvVar` 不调 save | 现状是调用方负责 save(不是 helper 自身) |
| 修 helper 不审计所有 caller | Phase 2 的 Map key 撞 bug 就是这样产生的 |
| 改预览域名公式 / SSOT 顺序 | 公式在 preview-slug.ts,有测试,不要乱动 |

---

## 7. 推荐的接力顺序

> 用户原话:"分阶段并且一次性完不成, 就列出工作列表放入 doc 然后根据列表逐个展开完成, 避免执行时间过长, 当然做完一个阶段后交接"

**单次会话能做完的最小单元**:
- Phase 2.5 单独一刀(0.5 天)
- Phase 3 单独一刀(1 天,密集)
- Phase 4 单独一刀(1.5 天,最难)
- Phase 5 + 6 可并(总 2 天)

**建议节奏**:
1. **会话 A**:Phase 2.5(四剑客补强)— 当天能完
2. **会话 B**:Phase 3(scan 增强)— 当天能完
3. **会话 C**:Phase 4(ORM 识别)— 1-2 天
4. **会话 D**:Phase 5(多分支 DB)+ Phase 6(实战验证)— 1-2 天

每会话开头读本文 § 2 找第一个 `[ ]` 未勾选的任务,按 plan 工作清单执行。每完成一个 [ ] 立刻勾选 + commit + push,plan 进度日志追加一行,changelog 一份。

---

## 8. 提交契约

**commit message**:`feat/fix(cds): Phase N — XXX(简短描述)`,正文用中文说原因 + 动作 + 影响 + 测试结果 + 下一阶段。

**push 后预览**(本分支):
```
分支 codex/migrate-cds-settings + 项目 prd-agent
→ migrate-cds-settings-codex-prd-agent.miduo.org
```

**新分支建议命名**:
- `claude/cds-mysql-phase-2-5-quad-reinforcement`
- `claude/cds-mysql-phase-3-scan-enhance`
- `claude/cds-mysql-phase-4-orm-migration`

---

## 9. 主要文件索引

| 文件 | 用途 |
|---|---|
| `doc/plan.cds-mysql-readiness.md` | MySQL 接入 6 阶段计划(进度日志在 § 五) |
| `doc/plan.cds-web-migration.md` | Web React 迁移计划(已基本完成) |
| `doc/guide.cds-web-migration-runbook.md` | Web 迁移操作手册 |
| `doc/guide.cds-web-migration-handoff.md` | Web 迁移上一份接力 |
| **本文** | **MySQL 阶段接力**(2026-05-01) |
| `cds/CLAUDE.md` | CDS 模块强约束 |
| `cds/.claude/rules/scope-naming.md` | 命名规范 |
| `.claude/skills/cds/SKILL.md` | cdscli 技能(对外) |
| `.claude/skills/cds/cli/cdscli.py` | cdscli Python 实现 |
| `cds/src/services/compose-parser.ts` | cds-compose 解析(含 `resolveEnvTemplates`) |
| `cds/src/services/container.ts` | docker 容器编排(含 `startInfraService` / `discoverInfraContainers`) |
| `cds/src/routes/branches.ts` | branch CRUD + deploy(Phase 2 改动在此) |
| `cds/src/services/preview-slug.ts` | 预览域名 SSOT |
| `cds/tests/services/compose-parser.test.ts` | env-expand 单测(Phase 1 加的 8 case 在此) |
| `cds/tests/services/container-network-isolation.test.ts` | 网络隔离单测 |
| `cds/tests/routes/branches.test.ts` | branch 路由单测 |

---

## 10. 给接力 AI 的最后一句

**先读 § 1.4 + § 2 + § 4**,知道做完了什么 + 还要做什么 + 别再踩什么。**然后从 § 7 的会话 A(Phase 2.5)开始**,完成后切下一会话。

每一阶段都要保证四剑客同步:**代码 + 文档 + 技能 + 测试**。任意一剑客缺失,下一个 agent 就会再踩同样的坑。这次 7 个冲突就是这么来的。

祝接力顺利。
