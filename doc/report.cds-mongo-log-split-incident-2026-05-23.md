# CDS Mongo 日志拆分事故复盘（2026-05-23）

## 结论

这次 502 不是 Cloudflare 问题，也不是业务分支容器先坏掉，而是 CDS 控制面 `cds-master` 在保存 Mongo 状态时崩溃。

直接触发错误是 MongoDB 单文档 / 单命令 16MB 限制：

```text
MongoServerError: BSONObj size ... is invalid. Size must be between 0 and 16809984(16MB)
Collection.replaceOne(... cds_state ...)
```

当时 `cds_state` 主文档把控制面配置、分支状态、操作日志、容器日志归档、Webhook 记录混在同一个 `{ _id: "state", state: ... }` 文档里。一次正常保存需要整体 `replaceOne`，任何日志膨胀都会拖垮整个 CDS 主系统。

## 本次主要是哪类日志发生问题

按线上 Mongo 状态估算，事故前主要体积来源是：

| 字段 | 估算体积 | 说明 |
|---|---:|---|
| `containerLogArchives` | 约 10.2MB | 最大肇事字段，保存了多分支、多容器的完整容器日志归档。 |
| `logs` | 约 3.8MB | 分支操作日志，包含事件、构建输出、容器 tail snapshot。 |
| `githubWebhookDeliveries` | 约 2.1MB | Webhook 投递记录被提高到 1000 条后继续留在主状态。 |
| 其他状态 | 约数百 KB | 正常控制面状态，本身不是问题。 |

`containerLogArchives + logs + githubWebhookDeliveries` 已经接近 MongoDB 16MB 上限；`replaceOne` 命令还会带额外 BSON 包装开销，所以实际写入时超过限制，导致 `cds-master` 进程异常退出。

## 为什么会影响主系统运行

旧结构违反了控制面持久化的隔离原则：

1. 主状态文档既保存“系统必须启动的数据”，也保存“可增长的日志数据”。
2. 日志写入和配置写入共用同一次 `replaceOne`。
3. 任意一个日志列表超限，都会导致整个状态保存失败。
4. `cds-master` 启动后会加载并保存状态；保存失败未被隔离，最终造成控制面不可用。

这相当于把“审计日志表”和“系统配置表”放进了同一行记录里。关系型数据库里也不会这样做，日志应垂直拆表，主表只保留索引、计数和必要状态。

## 第一阶段修复范围（已完成）

本阶段目标是先把日志型增长面从主状态剥离，并保证单条日志不会再次撑爆 Mongo 文档。

### 已拆分出主文档

| 数据 | 拆分方式 |
|---|---|
| `logs` | 不再进入 `cds_state.state` |
| `containerLogArchives` | 不再进入 `cds_state.state` |
| `activityLogs` | 不再进入 `cds_state.state` |
| `serviceDeployments.logs` | 主状态只保留部署元数据，`logs: []` |
| `selfUpdateHistory` | 不再进入 `cds_state.state` |
| `dataMigrations` | 不再进入 `cds_state.state` |
| `githubWebhookDeliveries` | 不再进入 `cds_state.state` |

主文档 `cds_state.state` 不再保存这些日志型列表或大日志正文。

## 第二阶段修复范围（已完成）

第一阶段的 `cds_state_fragments` 已经能保护主文档，但它仍然是“一个 owner 一个数组文档”。如果某个分支、某个 deployment 或 webhook 历史继续增长，单个 fragment 理论上仍可能变大。第二阶段已把日志持久化推进到记录级 collection：

### 已落到 `cds_state_log_records`

| 数据 | 横向扩张方式 | 单文档风险 |
|---|---|---|
| `logs` | 每条 `OperationLog` 一个 Mongo 文档，`ownerId = branchId` | 受事件条数与事件正文限幅控制 |
| `containerLogArchives` | 每个容器归档一个 Mongo 文档，`ownerId = branchId` | 单条归档日志正文最大约 `120KB` |
| `activityLogs` | 每条项目活动一个 Mongo 文档，`ownerId = projectId` | 活动记录本身轻量 |
| `serviceDeployments.logs` | 每条部署日志一个 Mongo 文档，`ownerId = deploymentId` | 单条 message 最大约 `16KB` |
| `selfUpdateHistory` | 每次 self-update 一个 Mongo 文档 | error/step text 限幅 |
| `dataMigrations` | 每次迁移一个 Mongo 文档 | log/errorMessage 限幅 |
| `githubWebhookDeliveries` | 每次 webhook delivery 一个 Mongo 文档 | delivery 记录独立扩张 |

`cds_state_fragments` 现在只作为旧数据兼容读取入口保留；新写入不再把日志数组写回 fragments。启动加载时会先合并旧 fragments，再合并新的 record collection，因此旧数据不会丢，上层 API 仍然看到原来的 `CdsState` 结构。

### 单条日志限幅

硬规则：任何持久化日志正文不得超过 `125KB`。

第一阶段实际限幅如下：

| 类型 | 限幅策略 |
|---|---|
| 容器归档日志 | 保留尾部，最大约 `120KB` |
| OperationLog event `log/chunk` | 高频日志，最大约 `8KB` |
| OperationLog 单文档 | 每条最多保留 `10` 个事件，避免事件数组把单个 Mongo 文档撑大 |
| OperationLog container snapshot | 最大约 `32KB` |
| ServiceDeployment 单条 message | 最大约 `16KB` |
| SelfUpdate step text | 最大约 `8KB` |
| DataMigration log | 最大约 `120KB` |
| error/errorMessage | 最大 `125KB` |

被截断时保留尾部，并加前缀说明原始大小，便于排障时知道这是持久化截断，不是原日志天然结束。

## MECE 批次验收计划与结果

| 批次 | 验收点 | 方法 | 当前结果 |
|---|---|---|---|
| B1 主文档瘦身 | `cds_state.state` 不包含所有日志型增长字段 | 单测读取 fake Mongo 主文档 | 通过 |
| B2 记录级横向扩张 | 日志按记录写入 `cds_state_log_records`，不是按 owner 写入单个大数组 | 单测统计 record docs 数量 | 通过 |
| B3 旧数据兼容 | 旧 `cds_state_fragments` 可被加载合并，新 records 也可合并 | 单测预置 fragment + record 后 init/load | 通过 |
| B4 单条限幅 | 容器归档、operation event、deployment log、self-update、migration log 均小于 `125KB` | 构造超大日志写入后检查 byteLength | 通过 |
| B5 增长压测 | 20 个分支，每分支 15 条 operation log、15 条容器归档，每条含超大正文 | 单测检查主文档 `<512KB`、record 文档横向增加、最大 record 文档 `<160KB` | 通过 |
| B6 写入恢复 | 一次 Mongo 写入失败不会中断后续 save 链 | 单测模拟 replaceOne 失败 | 通过 |
| B7 本地接口编译健康 | TypeScript 编译无错误 | `npm --prefix cds run build` | 通过 |
| B8 相关服务冒烟 | state、container log archiver、mongo backing store 回归 | 3 组测试共 57 条 | 通过 |
| B9 线上健康 | 检查 `/healthz`、Mongo 主文档大小、主文档是否仍含日志字段 | `curl /healthz` + 远端 Mongo 只读检查 | 当前线上健康；record collection 需本次代码部署后开始增长 |

## 线上当前健康快照

检查时间：2026-05-23。

| 项目 | 结果 |
|---|---|
| `/healthz?lightweight=1` | HTTP 200，`{"ok":true,"port":9900}` |
| `cds-master.service` | `active` |
| `cds_state` 主文档 JSON 体积 | `286985` bytes，约 `280KB` |
| 主文档是否含 `logs` | false |
| 主文档是否含 `containerLogArchives` | false |
| 主文档是否含 `activityLogs` | false |
| 主文档是否含 `githubWebhookDeliveries` | false |
| `serviceDeployments` 是否仍带 `logs` | 0 个 |
| 旧 `cds_state_fragments` | 114 个，来自第一阶段已部署结构 |
| 新 `cds_state_log_records` | 0 个；当前代码尚未线上部署，部署后新写入会进入该 collection |

## 本地验证

本地验证：

```text
npm --prefix cds test -- tests/infra/mongo-backing-store.test.ts tests/services/state.test.ts tests/services/container-log-archiver.test.ts
57 passed

npm --prefix cds run build
tsc passed
```

新增测试覆盖：

| 测试点 | 结果 |
|---|---|
| 主 Mongo 文档不再包含日志型增长字段 | 通过 |
| detached fragments 能在启动时合并回内存状态 | 通过 |
| `serviceDeployments.logs` 从部署元数据中剥离 | 通过 |
| 容器归档 / 操作日志 / shared-service 部署日志限幅 | 通过 |
| self-update / data migration 日志限幅 | 通过 |
| 20 分支大量日志增长时主文档不膨胀 | 通过 |
| 日志增长时 Mongo 文档横向增加到 `cds_state_log_records` | 通过 |

## 健康结论

当前代码层面已经消除这次 502 的同类根因：

1. `cds_state` 主文档不再承载日志正文和历史列表。
2. 日志增长会增加 `cds_state_log_records` 文档数量，而不是增加单个主文档大小。
3. 单条持久化日志正文有 `125KB` 以内的硬限幅，OperationLog 还额外限制事件数量，避免“一个 log 文档里塞满事件数组”。
4. 写入链路对单次 Mongo 写失败有恢复测试，避免一次写失败永久卡住后续保存。

仍需注意：这保证的是“Mongo 单文档不会再因为日志型字段膨胀到 16MB”。如果未来完全取消条数上限、把二进制大文件或未截断 stdout 直接塞进某个非日志字段，仍然可能制造新的大文档。因此后续新增持久化字段必须遵守：主状态只存索引和当前态，所有可增长历史均独立 collection + 单条限幅。

## 后续建议

第一阶段和第二阶段已经解决“主系统被日志拖死”的问题。后续建议集中在查询和运维能力，而不是继续拆主状态。

下一阶段应把 `cds_state_log_records` 继续演进为按业务类型拆开的集合：

| 集合 | 建议 |
|---|---|
| `cds_operation_logs` | 每条 OperationLog 一条文档，索引 `branchId + startedAt` |
| `cds_container_log_archives` | 每个容器归档一条文档，索引 `branchId + capturedAt` |
| `cds_webhook_deliveries` | 每个 webhook 一条文档，索引 `receivedAt + repoFullName` |
| `cds_activity_logs` | 每个 project activity 一条文档，索引 `projectId + at` |
| `cds_service_deployment_logs` | 每条 deployment log 一条文档，索引 `deploymentId + seq` |

这样才能做到真正的分页、倒序、TTL/清理策略和独立备份。
