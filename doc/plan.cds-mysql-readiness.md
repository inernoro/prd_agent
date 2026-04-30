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

**工作清单**:
- [ ] 1.1 `cds/src/services/container.ts` `runService()` 在合并 `mergedEnv` 时,用 customEnv 做一遍 `${VAR}` 替换
- [ ] 1.2 同样改 `startInfraService()`(InfraService 的 env 也走 ${VAR})
- [ ] 1.3 共享 helper:`expandVarsInRecord(envMap, customEnv): Record<string, string>`
  - 处理 `${VAR}` / `${VAR:-default}` 两种语法
  - 引用未定义变量 → 保留字面量 + console.warn
  - 循环引用 → 检测到立即报错,不死循环
- [ ] 1.4 单元测试 `tests/services/env-expand.test.ts`:8+ case 覆盖空值/未定义/循环/默认值/多层嵌套
- [ ] 1.5 回归现有测试不破坏(`pnpm test` 全绿)
- [ ] 1.6 changelog `2026-05-01_cds-env-var-expand.md`

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

**工作清单**:
- [ ] 2.1 看 `scheduler.ts` 当前 deploy 流程,找 layer-0 启动前的 hook
- [ ] 2.2 加 `ensureProjectInfra(projectId)`:扫 project 所有 InfraService,status != running 的全部 start(并行)
- [ ] 2.3 deploy SSE 流增加 `event: infra-startup` 阶段(放在 layer-0 之前)
- [ ] 2.4 失败处理:某个 infra 起不来,整个 deploy 失败 + 明确错误(不是模糊"deploy timeout")
- [ ] 2.5 单测覆盖:project 有 2 个 infra,1 个已运行 1 个未运行 → 只起未运行的
- [ ] 2.6 changelog

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
| 2026-05-01 | Phase 0 计划制定 | ✅ done | `<待填>` | 本文档创建 |
| | Phase 1 (${VAR} 展开) | ⏳ pending | — | — |
| | Phase 2 (deploy 起 infra) | ⏳ pending | — | — |
| | Phase 3 (scan 增强) | ⏳ pending | — | — |
| | Phase 4 (ORM 识别) | ⏳ pending | — | — |
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

## 八、参考阅读

- 上一份 human-verify 报告(本会话内)— MECE 8 维度推演 + 11 个 must-fix
- `doc/plan.cds-web-migration.md` 的"接力地图"实践 — 断点可续模式
- `cds/src/services/preview-slug.ts` — v3 预览域名公式 SSOT
- `.claude/rules/scope-naming.md` — 系统级 vs 项目级 命名约束
- `.claude/skills/cds/SKILL.md` — cdscli 触发词 + 决策规则
