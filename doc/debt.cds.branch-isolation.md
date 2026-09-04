# CDS 多分支跨分支隔离 · 债务台账

> **版本**：v1.0 | **日期**：2026-06-21 | **状态**：开发中

**一句话**：多分支共用基础设施时的隔离欠账：哪些是有意共享的设计，哪些是缺的隔离层。
**谁该读**：做多分支验收的人；排查分支间互相污染的工程师。
**读完能做什么**：分清「设计如此」与「隔离缺失」，并找到对应修法。

---

## 总览

当前 open: 4（BNI-legacy-shared-alias / DBI-project-default-stale-build / DBI-clone-init-mongo-and-drift / DBI-write-back-full-replace，均为已知边界）/ 已落地待验证: 2（dns-alias-collision / bullmq）/ 已修复: 2（BNI-prune-network / BNI-cleanup）/ 总计: 8

> 2026-07-09 批次：BULLMQ_PREFIX 平台自动注入落地（env-provenance 第 4.5 层，customEnv 显式定义优先 + `CDS_BULLMQ_PREFIX_INJECTION=0` 逃生阀，slug 与 per-branch-db 同一 SSOT `slugifyBranchForDb`）；BNI-cleanup 补齐 janitor removeFn 与启动残留 prune 两处 `removeBranchNetwork` 调用。

记录 CDS「同一项目多分支并存」时,分支级应用服务之间的两类串台缺陷。**注意区分**:分支共享数据库/Redis/Postgres 实例是**有意设计**(省资源 + 预览看真数据),本台账记录的不是"共享数据"的问题,而是"服务身份(DNS)"和"工作队列"被平台顺手一起共享导致的串台。

---

## 背景与机制(先分清"设计"与"缺陷")

三种"共享",只有第①种是有意设计:

| 共享什么 | 是否有意设计 | 是否有问题 |
|---|---|---|
| ① 共享 DB/Redis/Postgres **实例**(分支连同一个 Mongo,看同一份真实数据) | 是,有意为之 | 没问题,是好设计 |
| ② 服务之间靠**裸名**互相找(`worker` 调 `http://ai:8000`) | 否,平台疏漏 | 出问题(DNS 串台) |
| ③ 共享**同名任务队列**(BullMQ queue 无分支前缀) | 否,①的副作用 | 出问题(抢 job) |

### ② DNS 串台机制

- CDS 只做到**项目级**网络隔离:每个项目一张 `cds-proj-<id>` 网络(`cds/src/services/container.ts` Week 4.9),**同一项目的所有分支共享这一张网络**。
- 服务别名由 `computeProfileAliases`从 `profile.id` 削出裸短名(`ai-<projectMarker>` → 同时打 `--network-alias ai`),而 profile 是项目级共享的。
- 于是同一张网里同时有多个容器自称 `ai`:本分支的 `ai`(新代码)+ 旧分支的 `ai`(旧代码)。docker DNS round-robin → worker 调 `http://ai:8000/<新路由>` 间歇命中旧分支容器 → 404。
- 实测:`cdscli branch exec <branchId> "getent hosts ai" --profile worker` 在两个并存分支上各返回两个 IP。

### ③ BullMQ 抢 job 机制

- `.claude/rules/cross-project-isolation.md` 通道 4:同项目所有分支**共享同一 Redis/Mongo**(有意设计)。
- 但 BullMQ 队列名无分支前缀 → 所有分支共用一个收件箱。旧分支 worker(旧代码)可能先抢到新分支投递的 job,用旧逻辑处理并静默丢弃新字段,新分支 worker 永远收不到。
- 共享"数据记录"(读同一条)没事,共享"待办任务"出事——任务必须由对的代码版本处理。

### 触发条件(三者同时成立才咬人)

1. 同一项目**两个以上分支同时在线**,且
2. 它们跑**不同代码**(一新一旧),且
3. 服务之间**有内部调用**(worker→ai)**或共享队列**。

→ 单分支 / 多分支同代码 / 简单应用(只前端 + 共享 DB,无内部服务调用、无队列)**完全无感**;多服务应用(如 brandai)+ 多分支预览才出现。

### 业务侧现状(workaround)

brandai 项目已临时用分支级 env 兜底:`AI_SERVICE_URL=http://cds-<branchId>-ai:8000` + `BULLMQ_PREFIX=<slug>`。平台层修好后这两个 workaround 应可移除。

---

## 债务列表

| ID | 严重度 | 创建日期 | 描述 | 触发条件 | 状态 | 备注 |
|----|--------|---------|------|---------|------|------|
| 2026-06-21-dns-alias-collision | high | 2026-06-21 | 同项目多分支共享一张 docker 网络 + 裸服务别名,worker 调 `ai`/`redis`/`postgres` 经 DNS round-robin 间歇命中别分支(旧代码)容器 → 新路由 404 | 多服务项目 + 多分支并存 + 代码不一致 | 已落地(待CDS docker验证) | 2026-06-29 修复:每分支专属 app 网 `cds-br-<id>` + 共享 infra 网(multi-attach,app 容器无别名连共享网仅为可达 DB),自动逐分支默认开 + 全局 env 逃生。见 `design.cds.branch-network-isolation` + `branch-network.ts`。残留见下方 BNI 行 |
| 2026-06-21-bullmq-cross-branch-steal | high | 2026-06-21 | 分支共享同一 Redis,BullMQ 队列名无分支命名空间,别分支(旧代码)worker 抢本分支 job 并丢弃新字段 | 同上,且应用用共享队列 | 已落地(待brandai验证) | 2026-07-09 修复:`env-provenance.ts` 第 4.5 层自动注入 `BULLMQ_PREFIX=slugifyBranchForDb(branch)`(与 per-branch-db 同一 slug SSOT);customEnv/profile.env 显式定义优先不覆盖;逃生阀 `CDS_BULLMQ_PREFIX_INJECTION=0`。brandai 验证通过后其手填 `BULLMQ_PREFIX` 可删(`AI_SERVICE_URL` workaround 仍保留至 dns-alias 验证完) |
| BNI-cleanup | low | 2026-06-29 | 分支级网络隔离的 `removeBranchNetwork()` 已实现但未接全 `removeBranch` 调用点;空的 `cds-br-*` 网会随分支删除缓慢堆积 | 长期运行 + 大量分支增删 | 已修复 | 2026-07-09:台账原记「4 处未接」已过时,对账后实剩 2 处(index.ts janitor setRemoveFn + 启动残留 prune),均已在 removeBranch 前补 `await removeBranchNetwork(slug).catch(()=>{})`,清网失败不阻断删除(janitor.test.ts 有守卫用例) |
| BNI-prune-network | low | 2026-06-29 | `pruneStaleAppContainersForProfile` 曾按共享网扫描,隔离后 app 别名在分支网 | 隔离开启后的陈旧容器清理 | 已修复 | 2026-06-29 review:已改按 `netPlan.runNetwork`(隔离=分支网)扫别名,与别名实际所在网一致 |
| BNI-legacy-shared-alias | low | 2026-06-29 | 渐进迁移过渡窗口:已迁移分支 connect 共享网以可达 infra,若兄弟分支旧容器仍跑在共享网,其残留 app `--network-alias` 仍可被解析,隔离要等所有兄弟重部署后才完全生效 | 隔离 rollout 期 + 兄弟分支未重部署 + 解析本分支网缺失的 app 名 | open（已知边界） | 无 flag day 渐进迁移固有过渡态,非新代码 bug。缓解:兄弟下次部署即落分支网/旧别名消失、运营可批量重部署或 prune 共享网存量 app 别名、逃生开关整体回退。根治=app 只连 infra-only 专网(共享网不再承载 app 别名),属更大架构改动,待专项。见 `design.cds.branch-network-isolation` §6 |
| DBI-project-default-stale-build | low | 2026-09-02 | 项目设置「数据库隔离」改的是 `BuildProfile.dbScope` 底座，保存只写配置不重部署：改完之后、分支重新部署之前，跑着的旧容器仍连着改前的库；分支删除后 `app_<slug>` 独立库也不会自动 drop（与 `guide.cds.multi-branch-db` §4 一致） | 改项目默认后不重部署 / 频繁增删分支 | open（已知边界） | 有意设计：切库是重操作，重部署时机交给用户；页面与 API 回包都写明「重新部署后生效」并给出受影响分支数。独立库的去向已由数据台账接管（2026-09-03 收敛 3）：删分支默认保留转孤儿，备份 / 演练 / 丢弃门禁在项目设置「派生库台账」里 |
| DBI-clone-init-mongo-and-drift | low | 2026-09-04 | 分支独立库「时间点克隆」只覆盖 mysql / postgres，mongo 服务只能空库；克隆后的逐表校验只比行数、只比一次，克隆期间共享库的写入会以「不一致」呈现而不区分「克隆丢数据」与「源库又写了」 | 选了克隆的 mongo 服务 / 高写入共享库 | open（已知边界） | mongo 走专用实例通道要把 cloneMongoViaDedicatedInstance 抽进三元组管线并让分支独立库的连接串改指专用实例；校验若要区分两种原因，需在克隆前先拍一次源库行数快照（复制集波 4 的分阶段进度条与校验报告落地后一并接） |
| DBI-write-back-full-replace | low | 2026-09-04 | 回写是时间点整库替换（派生库赢），不合并两边改动；主库在克隆之后的写入靠冲突清单提示、靠回写前快照回退兜底；替换期间目标库短暂不可用；mongo 与专用实例隔离库不能回写 | 主库与分支同时有写入的项目 / mongo 项目 | open（已知边界） | 增量回写走引擎原生日志（mysql binlog、mongo oplog、postgres 逻辑复制）与冲突合并属复制集波 5；落地时把 `db-write-back.ts` 的门禁与台账记录原样复用，只替换「整库替换」那一步 |

---

## 修复方案(保留共享设计,只补隔离层)

两层分治,均不推翻"分支共享 DB/Redis 实例":

- **DNS 层**:每分支独立 docker network(裸别名只在本分支内解析,业务零改动),或服务别名加分支前缀。共享 infra 容器(Redis/Postgres)需 multi-attach 到每张分支网络,或文档化可达性约定(改 `cds/src/services/infra-catalog.ts` 是主要工作量)。
- **队列/数据层**:CDS 自动注入 `BULLMQ_PREFIX=<branchSlug>`(+ 可选 redis key/db 前缀),让各分支工单箱不混。

### 迁移路径

平台两层都自动注入后,brandai 的手填 `AI_SERVICE_URL` + `BULLMQ_PREFIX` 即可删除。

### 关联

- 修复落地时应在 `.claude/rules/cross-project-isolation.md` 事故台账补一行(分支级隔离穿透,第 N 次"不同层面")。
- 该修复值得走 `/risk` + `/trace` + CDS 双分支并存回归(`getent hosts ai` 只解析本分支 / 新路由不再间歇 404 / job 不被别分支消费),不应与功能 PR 混合。

---

## 已还的债务（归档）

> 修复后从上面表格挪到这里，保留以便复盘

| ID | 修复 PR | 修复日期 | 备注 |
|----|---------|---------|------|

---

## 实现来源

给要跳去看代码的人；只读这篇文档的人可以整块跳过。

| 位置 | 文件 |
|------|------|
| ② DNS 串台机制 | `container.ts:316` |
