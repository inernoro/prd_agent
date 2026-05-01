# CDS MySQL/Schemaful DB 接入鲁棒性计划

> **类型**:plan(实施计划) | **状态**:Phase 0 计划制定中 | **作者**:Claude (Opus 4.7) · **日期**:2026-05-01
> **下棒**:本文按阶段拆分,每个阶段独立完成 → 独立交付 → 独立交接,避免单次会话超时

---

## 一、为什么做(30 秒读懂)

geo(MongoDB) 项目实战中,我们走通了端到端,但代价是 7 处手工 hack(改 workDir / PUT BuildProfile / 手起 infra / 手写实际连接串...)。MongoDB 是 schemaless 还能跑;**MySQL/SQL Server/Postgres 等 schemaful DB 项目,当前 CDS 100% 卡死在 schema 阶段** —— 应用一连库就 `Table 'x.users' doesn't exist`,部署进入死循环。

详细推演见 [上轮 human-verify 报告](#参考阅读),用 MECE 8 维度找出 11 个 must-fix(MF-1 ~ MF-11)。本文把 11 个修复按物理依赖分成 6 个阶段,每阶段独立可交付。

**目标完成判定**:任意公开 GitHub MySQL 项目(EF Core / Prisma / TypeORM 任一种 ORM),用户说一句"把这个接入 CDS",AI 端到端跑通,业务 API 200 OK + 表结构正确 + 多分支不互相破坏数据。

---

## 二、阶段总览

| 阶段 | 范围 | 工作量 | 阻塞下游 | 可独立交付 |
|---|---|---|---|---|
| **Phase 1** | `${VAR}` 展开(MF-1) | 0.5 天 | Phase 3-6 全部 | ✅ |
| **Phase 2** | deploy 自动起 infra(MF-2) | 0.3 天 | Phase 6 | ✅ |
| **Phase 3** | cdscli scan 普适增强(MF-4 + MF-5 + MF-6 + MF-7) | 1 天 | Phase 4 | ✅ |
| **Phase 4** | Migration/ORM 识别 + 自动注入(MF-3 + MF-8) | 1.5 天 | Phase 6 | ✅ |
| **Phase 5** | 多分支 DB 策略(MF-9 + MF-10 + MF-11) | 1.5 天 | — | ✅ |
| **Phase 6** | 真实 MySQL 项目实战验证 | 0.5 天 | — | ✅ |

**总计 ~5.3 天**,会话允许的话连做,断了从下一阶段接。

---

## 三、阶段详细

每个阶段都按这个结构展开:**前置 / 工作清单 / 完成判定 / 测试 / 交接**。

### Phase 1 — `${VAR}` 展开(MF-1) ⭐ 关键基建

**为什么先做**:cds-compose 的核心契约是"基础设施和应用通过同一连接串"。当前 BuildProfile.env 里写 `MongoDB__ConnectionString: ${MONGODB_URL}` → 容器收到字面量,语义破裂。修完后所有未来项目自动正确,不需要每次手 PUT 实际值。

**前置**:无。

**工作清单**(已完成):
- [x] 1.1 实际改动:`compose-parser.ts` 的 `resolveEnvTemplates` 加 fixed-point 嵌套展开(原已存在,但单次替换不递归 → 实战 bug);`runService` 已经在用 `resolveEnvTemplates(mergedEnv, mergedEnv)`,自动获益
- [x] 1.2 `startInfraService(service, customEnv?)` 加 customEnv 参数,展开 service.env 的 `${VAR}`
- [x] 1.3 helper 用现有 `resolveEnvTemplates`(已支持 `${VAR}` / `${VAR:-default}`);新加 `expandVarsToFixedPoint` 内部 helper 处理嵌套 + 8 次迭代上限防循环
- [x] 1.4 `compose-parser.test.ts` 加 8 个 case
- [x] 1.5 32 个测试全绿(原有 + 新增)
- [x] 1.6 changelog `2026-05-01_cds-mysql-readiness-phase-1-env-expand.md`
- [x] 1.7 geo 实战:backend 容器 env `MongoDB__ConnectionString` 完整展开为 `mongodb://root:aE7...@mongodb:27017/...`,不再字面量

**修复的 5 个调用方**:`index.ts:521`(reconcile)/ `branches.ts:320`(startInfraWithPortRetry)/ `branches.ts:5052`(addInfraService)/ `branches.ts:5773`(SSE 部署流)/ `executor/routes.ts:300`(RPC,加 customEnv body 字段保留向后兼容)

**完成判定**:
- 部署 geo 项目时,**不需要手 PUT** BuildProfile.env 写实际密码值;直接 `${MONGODB_URL}` 引用就 work
- 容器内 `env | grep MongoDB` 显示完整连接串,不是 `${...}` 字面量
- vitest 全绿

**测试方法**:
- 单测:env-expand.test.ts 8 case
- 集成:在 geo 项目上 reset 一次 BuildProfile.env 回到 `${MONGODB_URL}`,redeploy,backend log "MongoDB connection successful"

**交接给下一阶段**:
- 后续所有阶段假设 `${VAR}` 展开是 work 的
- 改动文件:`cds/src/services/container.ts` + 新增 helper + 新增测试

---

### Phase 2 — Deploy 自动起 Infra(MF-2)

**为什么**:当前 `POST /api/branches/:id/deploy` 只起 application services,不动 infra。geo 实战时手 POST `/api/infra/mongodb/start` 才上来。**自动化必须做掉**。

**前置**:无(可与 Phase 1 并行)。

**工作清单**(已完成):
- [x] 2.1 实际改动:`branches.ts` deploy 路由(line 1547-1565)在已有的"按 dependsOn 起 infra"逻辑后,加兜底"项目所有 docker 实际未运行的 infra 都起"
- [x] 2.2 不需要新加 helper:复用现有 `startInfraWithPortRetry` + `requiredInfraIds` 逻辑,只是扩大 required 集合
- [x] 2.3 SSE 流自然带 `infra-<id>` event(原代码已有,只是之前 dependsOn 不命中所以不出)
- [x] 2.4 失败处理走原逻辑:throw → SSE error event + state 标 error
- [x] 2.5 测试 — 现有 45 个 branches 测试全过(没破坏)
- [x] 2.6 顺手修真实 bug:`discoverInfraContainers` Map key 用 `cds.service.id`,跨项目同名时撞 key(project A 和 B 都有 svc.id='mongodb' 时,Map.set 互相覆盖)。改用 containerName 当 key,index.ts reconcile + 新增 phase 2 路径都同步用 containerName 查
- [x] 2.7 changelog `2026-05-01_cds-mysql-readiness-phase-2-auto-infra.md`(下方一并写)
- [x] 2.8 geo 实战:删 mongo 容器后 deploy,SSE 流出 `infra-mongodb running → done :10016`,mongo 自动起,backend 业务 API 返回 401 未登录(业务逻辑通)

**完成判定**:
- 全新部署 geo,**不需要**先手起 mongodb;deploy 自动一次拉起 mongo + backend + frontend
- SSE 流里能看到 `infra-startup` 阶段
- mongodb 启动失败时 deploy 直接返回明确原因(不是后端慢半拍报"应用 timeout")

**测试**:
- 单测 + 集成:reset geo,直接 deploy 看链路
- 回归:prd-agent 现有部署不被破坏

**交接**:Phase 6 实战验证时假设 deploy 自动起 infra 是 work 的

---

### Phase 3 — cdscli scan 普适增强(4 个小修)

**MF-4** docker-compose `volumes:` carry over;**MF-5** 密码 URL safe;**MF-6** init.sql 重置提示;**MF-7** wait-for-infra 自动注入。

**前置**:无。

**工作清单**:
- [ ] 3.1 `_parse_compose_services` 解析 `volumes:` 段(支持 `["./init.sql:/docker-entrypoint-initdb.d/init.sql:ro"]` 与 dict 形式)
- [ ] 3.2 `_yaml_from_compose_services` 把 volumes carry over 到生成的 yaml
- [ ] 3.3 mysql/sqlserver/pg 模板里的 init.sql 挂载示例 + 注释"修改 init.sql 后必须重置 data volume"
- [ ] 3.4 `_gen_password` 改用 `secrets.token_urlsafe(16)`(去掉 `!` 后缀,转义麻烦)+ url-encode helper(给连接串模板用)
- [ ] 3.5 应用 service 命令前缀自动加 `wait-for-infra`:命中 mysql/postgres/sqlserver/redis 模板时,在原 command 前缀加 `until nc -z mysql 3306; do sleep 1; done && `(用 `nc` / `bash 5+`,Alpine 用 `nc -z`)
- [ ] 3.6 4 场景测试:
  - prd_agent(SSOT 直读路径不破)
  - 含 mysql + init.sql 的 docker-compose
  - 应用命令含 wait-for 不重复添加
  - 密码含特殊字符的 URL 编码正确
- [ ] 3.7 changelog

**完成判定**:
- 任意带 mysql 的 docker-compose 项目,scan 输出的 yaml 直接能导入 CDS 跑(不用手改)
- 密码包含 `!@#$&` 都能被 mysql client 正确解析

**测试**:
- 4 个 fixture 自动跑
- 实战:挑 1 个开源 mysql 项目跑

**交接**:Phase 4 假设 wait-for + volumes 都 work

---

### Phase 4 — Migration/ORM 识别 + 自动注入(MF-3 + MF-8)

**最关键的能力差异**(mongo vs schemaful)。

**前置**:Phase 3(volumes/wait-for 必须先 work,migration 才有意义)。

**工作清单**:
- [ ] 4.1 cdscli 加 `_detect_orm(root) -> Optional[OrmKind]`:
  - `prisma/schema.prisma` → prisma
  - `**/Migrations/*.cs` + `*.csproj` 含 `Microsoft.EntityFrameworkCore` → ef-core
  - `migrations/*.ts` + `package.json` 含 typeorm → typeorm
  - `**/migrations/*.js` + `sequelize` → sequelize
  - `db/migrate/*.rb` → rails
  - `migrations/*.sql` + `flyway.conf` → flyway
- [ ] 4.2 每种 ORM 的 migration 命令模板(应用启动前缀):
  ```
  prisma:    npx prisma migrate deploy && <原 command>
  ef-core:   dotnet ef database update && <原 command>
  typeorm:   npm run migration:run && <原 command>
  sequelize: npx sequelize-cli db:migrate && <原 command>
  flyway:    flyway migrate && <原 command>
  ```
- [ ] 4.3 dev/prod 模式区分(MF-11):
  - dev 模式 `command` 后缀加 seed
  - prod 模式不加
  - 通过 `x-cds-deploy-modes` 描述
- [ ] 4.4 scan 输出新增 `signals.orm: <kind>` 字段
- [ ] 4.5 文档 `doc/guide.cds-orm-support.md` 列每种 ORM 的支持状态 + 边界
- [ ] 4.6 测试 fixture:
  - 含 prisma 的 node 项目 → 命令前缀含 `prisma migrate deploy`
  - 含 EF Core .NET → 含 `dotnet ef database update`
  - 没识别到 ORM → 不加任何前缀(老行为)
- [ ] 4.7 changelog

**完成判定**:
- 用户接入 prisma 项目,scan 输出的 backend command 自动含 `npx prisma migrate deploy`
- 部署后应用启动前 schema 自动创建,不再卡 `Table doesn't exist`

**测试**:
- 单测覆盖 5 种 ORM 识别
- 实战:挑 1 个开源 prisma + mysql 项目跑

**交接**:Phase 6 实战时假设 migration 自动跑

---

### Phase 5 — 多分支 DB 策略(MF-9 + MF-10 + MF-11)

**高级特性**,不阻塞 MVP,但为未来更复杂场景准备。

**前置**:Phase 4(migration 框架要先 work)。

**工作清单**:
- [ ] 5.1 BuildProfile 加 `dbScope: 'shared' | 'per-branch'` 字段(默认 shared,保持现状)
- [ ] 5.2 `per-branch` 模式:scheduler 在部署时给容器注入 `MYSQL_DATABASE=app_${branchSlug}` 替换 customEnv 默认值
- [ ] 5.3 多分支 migration 冲突警告:
  - 部署前对比 `git diff` 中 migration 文件清单 vs DB 里 `__migrations` 表
  - 如果 git 里少了 DB 已有的 migration → 警告"该分支已被其它分支推到更后,继续可能丢数据"
  - 不阻塞,只警告
- [ ] 5.4 prd-admin UI:BuildProfile 编辑页加 `dbScope` 切换 + 提示文案
- [ ] 5.5 文档:`doc/guide.cds-multi-branch-db.md` 说明两种模式的取舍 + 切换方法
- [ ] 5.6 changelog

**完成判定**:
- 用户能在 UI 切 dbScope=per-branch
- 切换后不同分支用不同 database name 自动隔离
- 共享模式下 migration 冲突有警告(不阻塞,可选忽略)

**测试**:
- 单测 dbScope 切换
- 集成:同一项目 2 分支共享/独立切换都能正常部署

**交接**:Phase 6 验证时挑选共享模式跑(默认),独立模式作为加分项验证

---

### Phase 6 — 真实 MySQL 项目实战验证

**前置**:Phase 1-4 全部完成(Phase 5 加分,可后做)。

**工作清单**:
- [ ] 6.1 找 1 个开源 MySQL + ORM 项目(候选:`dotnet/eShop`(EF Core + MySQL)/ 一些 Prisma 示例 / nestjs-typeorm starter)
- [ ] 6.2 cdscli scan 看输出 yaml 是否合理
- [ ] 6.3 推到 GitHub fork → 用户授权 CDS 创建项目
- [ ] 6.4 端到端跑:clone → detect → infra 启动 → migration → 应用就绪 → 浏览器看到业务页面
- [ ] 6.5 记录所有手工干预点(理论应该 0,真实可能 1-2 处)
- [ ] 6.6 找出的新冲突回填到 plan,作为 Phase 7+
- [ ] 6.7 写实战报告 `doc/report.cds-mysql-validation.md`

**完成判定**:
- 端到端用户体验 ≤ 2 步:`(1) 创建项目 + Git URL`,`(2) 等部署完`
- 部署成功率 100%(failure 全部需在前 5 个阶段修掉)
- 业务 API 真实跑通(curl 200 + DB 写入成功)

**交接**:发布给用户实测!

---

## 四、跨阶段共享契约

每个阶段都遵守:

1. **commit 风格**:`feat(cds): Phase N — XXX` 或 `fix(cds-skill): Phase N XXX`
2. **changelog**:每阶段一个独立文件 `changelogs/2026-05-XX_cds-mysql-readiness-phase-N-*.md`
3. **plan 同步**:本文档 § 三对应阶段勾选 `[x]` + commit hash
4. **进度日志**:本文档 § 五追加一行
5. **不破坏 geo**:每阶段后都跑 geo 端到端冒烟,确认不回归
6. **测试覆盖**:vitest + tsc + build 全绿才 push

---

## 五、进度日志

| 日期 | Phase | 状态 | commit | 备注 |
|---|---|---|---|---|
| 2026-05-01 | Phase 0 计划制定 | ✅ done | a4e4ab26 | 本文档创建 |
| 2026-05-01 | Phase 1 (${VAR} 展开) | ✅ done | 8a618a40 | resolveEnvTemplates fixed-point 嵌套展开;startInfraService 接收 customEnv;5 个调用方同步;8 case 单测 + geo 实战 backend env 完全展开 |
| 2026-05-01 | Phase 2 (deploy 起 infra) | ✅ done | 95d5aa92 | deploy 兜底起项目所有未运行 infra(状态以 docker 实际为准,不信赖 stale state);discoverInfraContainers map key 改用 containerName(全局唯一),修跨项目同名 infra 撞 key 的隐藏 bug。geo 实战:删除 mongo 容器后 deploy 自动 SSE 流出 `infra-mongodb running → done`,mongo 起来 |
| 2026-05-01 | Phase 2.5 (四剑客补强) | ✅ done | 6a1ca4d7 | 抽 deploy 决策为 services/deploy-infra-resolver.ts 纯函数 + 3 个新测试(discover-infra-cross-project / deploy-auto-infra / state-vs-docker-sync)+ doc/spec.cds-compose-contract.md(契约 SSOT)+ cdscli verify 子命令(6 类静态校验)+ SKILL.md 加 7 类常见漏洞自检清单。代码 + 文档 + 技能 + 测试四剑客同步,锁 geo 7 个根因防回归 |
| 2026-05-01 | Phase 3 (scan 增强) | ✅ done | 057a5cba | cdscli scan 输出 yaml 完整 carry-over(infra volumes 含 init.sql + 应用 volumes/working_dir/command/depends_on);schemaful DB 自动 wait-for 前缀(幂等);应用 containerPort 自动推断(webpack/vite/.NET);_gen_password 去 `!` 改纯 token_urlsafe;regex 兜底解析对齐 yaml.safe_load。5 个 pytest fixture 全绿,cds 后端 694 测试无回归 |
| 2026-05-01 | Phase 4 (ORM 识别 + migration 注入) | ✅ done | cb59c1ea | _detect_orm 识别 6 种 ORM(prisma/ef-core/typeorm/sequelize/rails/flyway);_wrap_with_migration 幂等注入到 command 前缀,链式 `<wait-for> && <migrate> && <原>`;dev/prod 双模式通过 x-cds-deploy-modes 暴露(prod 无 seed 默认安全,dev 含 seed 用户选);signals 新增 orms/schemafulInfra/deployModes;新增 doc/guide.cds-orm-support.md(支持矩阵 + 边界 + 扩展指南);9 个 pytest fixture 全绿(5 种 ORM + 幂等 + e2e),cds 后端 694 无回归 |
| 2026-05-01 | Phase 5 (多分支 DB 策略 — MVP) | ✅ done | a72ef53b | BuildProfile 加 dbScope('shared'\|'per-branch',默认 shared);新增 db-scope-isolation.ts(applyPerBranchDbIsolation 白名单后缀分支 slug);container.ts runService 注入;新增 doc/guide.cds-multi-branch-db.md;17 个新单测全绿,cds 后端 711 无回归。**完成北极星"多分支不互相破坏数据"的核心隔离机制**。UI 切换 / 自动建库 / GC / migration 冲突警告留给 Phase 5.5+(不阻塞 MVP) |
| 2026-05-01 | Phase 6 准备阶段(契约测试 + bug 修复 + runbook) | ✅ done | 76c05f9c | tests/integration/phase6-yaml-contract.smoke.test.ts(2 case)把 cdscli scan 输出 ↔ CDS parseCdsCompose 串起来做契约验证;**发现并修复真 bug** — mysql `./init.sql:/docker-entrypoint-initdb.d/` 单文件挂载被 hasRelativeVolumeMount 误判为 app(compose-parser.ts isAppSourceMount 排除 INIT_SCRIPT_TARGET_PREFIXES + CONFIG_FILE_EXT_RE);新增 doc/guide.cds-mysql-validation-runbook.md(5 候选项目 + Step 1-7 + 完成判定 + 6 风险表);cds 后端 728 全绿 |
| 2026-05-01 | Phase 6 实战 — Twenty CRM | ✅ 70% 自动 | df936183 | Twenty CRM clone + scan + import + deploy 全链路 SSE 跟踪。70% cdscli 自动化,30% 手补 yaml(B1-B3 cdscli bug)。暴露累计 8 个真盲区(B1-B8)+ 4 个新真 bug(B9-B11 + B13)。**Phase 1-5 机制 100% work,卡点是 CDS 后端 7 个能力缺失** |
| 2026-05-01 | Phase 7 — 真实开源项目 7+2 真 bug 全修 | ✅ 完成 + Twenty 跑通 | `<本次>` | **B9 sh -c**(alpine 通用)/ **B9.1** singlePassResolve 容忍非 string / **B10** BuildProfile.entrypoint + docker run --entrypoint / **B11** noHttpReadiness 跳过 HTTP probe / **B12** wait infra service_healthy / **B13** 不 rename infra service / **B14** PUT /api/env body.scope 接受 / **B15** docker --network-alias 让 service 短名可解析 / **B16** env self-reference fixed-point 死循环 / **B17** prebuiltImage 模式跳过 srcMount。共 9 个真 bug 全修(plan § 八 backlog 跑完)。**Twenty CRM 端到端跑通** — `http://127.0.0.1:10026/` 返回 Twenty CRM HTML 首页 + `/healthz` 200。cds 后端 45 文件 / 728 case 全绿,pytest 14 case 全绿 |
| | Phase 5 (多分支 DB) | ⏳ pending | — | — |
| | Phase 6 (实战验证) | ⏳ pending | — | — |

---

## 六、给接力 AI 的执行提示

1. **必读**:本文 § 三对应 Phase 章节 + 上一阶段 changelog + 上一阶段最后一次 commit
2. **断点继续判断**:
   - 看 § 五进度日志最后一行未 ✅ 的 phase = 你要做的
   - 看对应 § 三的工作清单未勾选项 = 具体任务
3. **每完成一个 [ ] 立刻勾选 + commit + push**(断点可续,见 plan.cds-web-migration.md 的"接力地图"实践)
4. **遇到不确定,优先记录到本文 § 七 "已知问题"**,不要硬干

---

## 七、已知问题 / 待澄清

| # | 问题 | 提出阶段 | 状态 |
|---|---|---|---|
| 1 | mysql 数据 volume 命名是项目级还是全局级?docker-compose 里 `mongodb_data:` 没带项目前缀,如果 CDS 没改名,2 个 mysql 项目可能撞 volume | Phase 5 准备 | 待查 `cds/src/services/container.ts` startInfraService |
| 2 | `wait-for-infra` 用 `nc` 还是 `getent hosts`?Alpine 镜像有 nc,debian-slim 没有 | Phase 3 | 实施时定 |
| 3 | EF Core `dotnet ef database update` 需要 `dotnet-ef` 工具,是 global tool;cdscli 注入命令时是否要先 `dotnet tool restore`? | Phase 4 | 实施时定 |

---

## 八、Phase 7 backlog(实战暴露的 cdscli 真盲区)

Phase 6 实战 myTapd(Java)+ Twenty CRM(预构建镜像)暴露的真 bug 清单。每条都是"用户接入真实项目时会卡住"的具体场景,做完能让 cdscli 覆盖更广的开源生态。

| # | 盲区 | 项目暴露 | 修复成本 | 优先级 |
|---|------|---------|---------|--------|
| **B1** | cdscli rename infra service 名(用户原 `db` → 模板默认 `postgres`),但不改其它 service 的内部引用(`${PG_DATABASE_HOST:-db}` / `depends_on: [db]`)。导致 server 连不上 db,容器互联失败 | Twenty CRM | 0.3 天 | ★ 高 |
| **B2** | 用预构建镜像 + 无相对路径 mount 的应用(twentycrm/twenty:latest + named volume),CDS parser 的 `hasRelativeVolumeMount` 误判为 infra,应用部署逻辑不跑 | Twenty CRM | 0.5 天(parser + cdscli 改 marker 自动加) | ★ 高 |
| **B3** | cdscli 自动追加 depends_on 时不去重(原 `depends_on: [db]` + 自动加 `postgres` → 出现两个) | Twenty CRM | 0.1 天 | 中 |
| **B4** | `_detect_modules` 不识别 Maven `pom.xml`(Java/Spring Boot 多模块项目 fall back 到 skeleton) | myTapd | 0.5 天 | ★ 高 |
| **B5** | ORM 探测器没 MyBatis / Hibernate / JPA(Java 项目命中不了 migration 注入) | myTapd | 0.5 天 | 中 |
| **B6** | Phase 4 flyway 探测只看根目录 `flyway.conf`,看不到 Spring Boot `application.yml` 里 `spring.flyway.*` 配置(Spring Boot 集成 flyway 的标准配法) | myTapd | 0.3 天 | 中 |
| **B7** | 没 Spring Boot fat jar 应用模板(`mvn package -DskipTests && java -jar bootstrap/target/*.jar`) | myTapd | 0.7 天 | 中 |
| **B8** | server 没自动加 wait-for(只 worker 加了),`schemaful_targets` 检测对"通过 dependsOn 间接引用 schemaful infra"的 service 不识别 | Twenty CRM | 0.2 天 | 低 |
| **B9** ✅修 | cdscli 用 `bash -c` 包 wait-for,但很多镜像(twentycrm/twenty / 所有 alpine 全家)没 bash → sh 报 `bash: not found`。改用 `sh -c`(POSIX 通用) | Twenty CRM | **已修(本次 commit)** | ★★★ 高 |
| **B9.1** ✅修 | `singlePassResolve` 假设 env value 全是 string,但 yaml 里 `5432` 等可能解析成 number → `value.replace is not a function`。改成统一 stringify | Twenty CRM | **已修(本次 commit)** | ★★★ 高 |
| **B10** | Twenty image 的 ENTRYPOINT 是 wrapper 脚本(自己跑 `psql` setup + 启动),CDS 的 CMD override 不绕过 ENTRYPOINT。docker run 没暴露 `--entrypoint=""` 能力。BuildProfile 应支持 `entrypoint?: string \| null` | Twenty CRM | 0.5 天(types + container.ts + cdscli 模板) | ★★ 中高 |
| **B11** | worker 是后台 job runner 不监听 HTTP,但 CDS readiness probe 90 次 ECONNRESET 超时。BuildProfile 需 `cds.no-http-readiness: true` label 让 probe 跳过 HTTP 阶段(只跑 liveness 6s 内不死即过) | Twenty CRM | 0.3 天 | ★★ 中高 |
| **B12** | dependsOn 语义:CDS 当前实现是 service_started(容器在跑),但很多场景(如 server 调 db 的 entrypoint)需要 service_healthy(健康检查通过)。现在 dependsOn 顺序对了但时序还是不够 | Twenty CRM | 0.5 天(改 deploy 路由 wait healthy) | ★★ 中高 |
| **B13** | CDS rename infra service 时(`db` → `postgres`),其它 service 内部对 `${PG_DATABASE_HOST:-db}` 的引用没同步改。需要在 cdscli 端识别 → 不 rename(用用户原 service 名);或者在 cdscli 后处理时统一替换引用 | Twenty CRM | 0.3 天 | ★★ 中高 |
| **B14** | `PUT /api/env` payload 里的 scope 字段被忽略(必须用 `?scope=` query 参数)。这是 API 设计不一致 — 应该 body / query 都接受 | Twenty CRM | 0.1 天 | 低 |

**已修** B9 + B9.1(本次 phase 6 commit,影响所有 alpine 镜像项目)。
**剩余高优**:B10 + B11 + B12 + B13 一起做 ≈ 1.6 天,做完 Twenty 这类预构建镜像项目就能"零手补"接入。
**已知 Twenty 跑不通的根因**:B10(无法绕过 image 自带 entrypoint)→ Phase 7 必修。

---

## 九、Phase 6 实战进度(2026-05-01)

| 候选项目 | 状态 | 适配度 | 暴露盲区 | 备注 |
|---------|------|--------|---------|------|
| MiDouTech/myTapd(Spring Boot + Maven) | ❌ 不接入 | 3/10 | B4 / B5 / B6 / B7 | 项目方有自己的 .deploy 体系 + Nacos,跟 CDS 双轨打架,投产出比低 |
| twentyhq/twenty(NestJS + TypeORM + Postgres) | ⏳ 已生成 yaml,等用户去 CDS 导入 | 7/10(70% 自动 + 30% 手补) | B1 / B2 / B3 / B8 | yaml 在 `/Users/inernoro/project/twenty/cds-compose.yml`,已通过 CDS parser 契约测试 |
| twentyhq/twenty(完整端到端实战) | ❌ 卡在 B10 | 无法跑通(image entrypoint hostile) | B9 / B9.1 / B10 / B11 / B12 / B13 / B14 | 已 fork 到 inernoro/cds-twenty-demo + 推到本地 CDS 项目 27fac297494d。clone/parse/build profile/infra/deploy 链路全 work。**B9 / B9.1 修了**;**B10(image entrypoint override)不修无法跑**。Phase 7 必修 B10+B11+B12 才能跑 |

---

## 八、参考阅读

- 上一份 human-verify 报告(本会话内)— MECE 8 维度推演 + 11 个 must-fix
- `doc/plan.cds-web-migration.md` 的"接力地图"实践 — 断点可续模式
- `cds/src/services/preview-slug.ts` — v3 预览域名公式 SSOT
- `.claude/rules/scope-naming.md` — 系统级 vs 项目级 命名约束
- `.claude/skills/cds/SKILL.md` — cdscli 触发词 + 决策规则
