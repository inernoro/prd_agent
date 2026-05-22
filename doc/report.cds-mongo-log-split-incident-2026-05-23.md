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

## 第一阶段修复范围

本阶段目标是先把日志型增长面从主状态剥离，并保证单条日志不会再次撑爆 Mongo 文档。

### 已拆分到 `cds_state_fragments`

| 数据 | 拆分方式 |
|---|---|
| `logs` | 按 `branchId` 拆成 `state:logs:<branchId>` |
| `containerLogArchives` | 按 `branchId` 拆成 `state:containerLogArchives:<branchId>` |
| `activityLogs` | 按 `projectId` 拆成 `state:activityLogs:<projectId>` |
| `serviceDeployments.logs` | 按 `deploymentId` 拆成 `state:serviceDeploymentLogs:<deploymentId>`，主状态只保留部署元数据 |
| `selfUpdateHistory` | 拆成 `state:selfUpdateHistory` |
| `dataMigrations` | 拆成 `state:dataMigrations`，并限制其中 `log/errorMessage` |
| `githubWebhookDeliveries` | 拆成 `state:githubWebhookDeliveries` |

主文档 `cds_state.state` 不再保存这些日志型列表或大日志正文。

### 单条日志限幅

硬规则：任何持久化日志正文不得超过 `125KB`。

第一阶段实际限幅如下：

| 类型 | 限幅策略 |
|---|---|
| 容器归档日志 | 保留尾部，最大约 `120KB` |
| OperationLog event `log/chunk` | 高频日志，最大约 `8KB` |
| OperationLog container snapshot | 最大约 `32KB` |
| ServiceDeployment 单条 message | 最大约 `16KB` |
| SelfUpdate step text | 最大约 `8KB` |
| DataMigration log | 最大约 `120KB` |
| error/errorMessage | 最大 `125KB` |

被截断时保留尾部，并加前缀说明原始大小，便于排障时知道这是持久化截断，不是原日志天然结束。

## 验证

本地验证：

```text
npm --prefix cds test -- tests/infra/mongo-backing-store.test.ts tests/services/state.test.ts tests/services/container-log-archiver.test.ts
56 passed

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

## 后续建议

第一阶段解决“主系统被日志拖死”的问题，但还不是最终日志系统。

下一阶段应把 `cds_state_fragments` 继续拆成更接近关系型设计的集合：

| 集合 | 建议 |
|---|---|
| `cds_operation_logs` | 每条 OperationLog 一条文档，索引 `branchId + startedAt` |
| `cds_container_log_archives` | 每个容器归档一条文档，索引 `branchId + capturedAt` |
| `cds_webhook_deliveries` | 每个 webhook 一条文档，索引 `receivedAt + repoFullName` |
| `cds_activity_logs` | 每个 project activity 一条文档，索引 `projectId + at` |
| `cds_service_deployment_logs` | 每条 deployment log 一条文档，索引 `deploymentId + seq` |

这样才能做到真正的分页、倒序、TTL/清理策略和独立备份。

