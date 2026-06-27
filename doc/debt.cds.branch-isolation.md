# CDS 多分支跨分支隔离 · 债务台账

> **版本**：v1.0 | **日期**：2026-06-21 | **状态**：维护中

## 总览

当前 open: 2 / paid: 0 / 总计: 2

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
- 服务别名由 `computeProfileAliases`(`container.ts:316`)从 `profile.id` 削出裸短名(`ai-<projectMarker>` → 同时打 `--network-alias ai`),而 profile 是项目级共享的。
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
| 2026-06-21-dns-alias-collision | high | 2026-06-21 | 同项目多分支共享一张 docker 网络 + 裸服务别名,worker 调 `ai`/`redis`/`postgres` 经 DNS round-robin 间歇命中别分支(旧代码)容器 → 新路由 404 | 多服务项目 + 多分支并存 + 代码不一致 | open | 修复方向:每分支独立 network,或服务别名带分支前缀,让裸名只在本分支内解析;共享 DB/Redis 实例照旧。需处理共享 infra 容器对每分支网络的可达性(multi-attach) |
| 2026-06-21-bullmq-cross-branch-steal | high | 2026-06-21 | 分支共享同一 Redis,BullMQ 队列名无分支命名空间,别分支(旧代码)worker 抢本分支 job 并丢弃新字段 | 同上,且应用用共享队列 | open | 修复方向:CDS 自动派生并注入 `BULLMQ_PREFIX=<branchSlug>`(+ 可选 Redis key/db 前缀);仍用同一 Redis 实例,只给工单贴分支标签 |

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
