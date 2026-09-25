# MongoDB 索引维护 · 指南

> **版本**：v2.3 | **日期**：2026-09-24 | **状态**：已落地

**一句话**：本平台禁止程序启动时自动建索引：索引由 DBA 跑仓库里那份可执行清单手动建，附验证与回滚步骤。
**谁该读**：负责数据库维护的人；新加了集合或查询、需要配套索引的后端工程师。
**读完能做什么**：按可执行清单手动建好索引，验证是否生效，必要时回滚。

---

PRD API 禁止在应用启动时自动创建 MongoDB 索引。应用库索引由 DBA 使用仓库内的可执行清单手动维护，文档不再复制一千余行 DDL。

## 1. 事实源

| 内容 | 位置 | 职责 |
|---|---|---|
| 可执行 DBA 索引清单 | `scripts/mongodb-indexes.js` | 应用库索引的执行入口 |
| Model 与集合定义 | `prd-api/src/PrdAgent.Infrastructure/Database/MongoDbContext.cs` | 集合名称和查询模型 |
| 历史索引构造参考 | 同文件的 `CreateIndexes()` | 只供对照，不在启动时调用 |
| 禁止自动建索引规则 | `.claude/rules/no-auto-index.md` | 约束 PRD API 应用库 |

新增或修改查询时，应先更新可执行清单，再在设计或债务文档中引用集合名和索引名；不要把完整 DDL 再粘回文档。

网页托管的删除清理新增两项人工维护索引：`hosted_sites` 的
`idx_hosted_sites_asset_cleanup_due`（只收还欠着待删对象的站点）与 `hosted_site_deletion_tasks` 的
`idx_hosted_site_deletion_due`。两者都服务于按分钟轮询的清理任务——没有它们，每一轮空扫都是
整表扫描加排序。同样只通过 DBA 清单创建。执行与验证步骤见 3.1 节。

本轮设计产物生命周期新增一项人工维护索引：`md_to_ppt_runs` 的
`idx_md_to_ppt_runs_contract_recovery`。它服务于 HTML PPT 专用 Run 与公共设计产物账本的周期恢复，
先按合同版本和同步状态筛选，再按更新时间从最旧记录开始收敛。该索引仍只通过上述 DBA 清单创建，
应用启动和恢复 Worker 都不会自动建索引。

## 2. 执行

确认目标连接串和数据库名称后，由 DBA 在维护窗口执行：

```bash
mongosh "<connection-uri>/<database>" scripts/mongodb-indexes.js
```

执行前必须：

- 备份目标数据库并确认当前连接的环境。
- 审查新增或收紧的唯一索引是否存在重复数据。
- 评估大集合在线建索引的资源影响。
- 检查脚本中的迁移目标，确认 `collMod` 和已知旧索引重建均在本次维护范围内。
- 为旧索引重建预留维护窗口；重建期间对应查询可能暂时没有该索引。

该脚本包含以下三类操作：

| 操作 | 触发条件 | 行为 |
|---|---|---|
| `createIndex` | 新库或索引不存在 | 幂等创建目录中的索引 |
| `collMod` | 同名、同键、同 partial filter 的历史索引尚未启用唯一约束 | 先设置 `prepareUnique`，检查重复组后原地转换为唯一索引 |
| `dropIndex` 后重建 | 索引命中脚本内明确登记的旧定义 | 先按新定义检查重复组，再短暂删除旧索引并重建；重建失败时尝试恢复旧定义 |

`dropIndex` 不用于通用清理，只允许处理脚本内登记的已知旧定义。迁移失败会集中记录，脚本继续应用无关索引后以非零状态退出。生产连接串不得写入仓库、终端共享记录或文档。

## 3. 验证

对本次涉及的集合执行 `getIndexes()`，核对：

- 索引名称和键顺序。
- `unique`、TTL 和 partial filter 等选项。
- 查询计划是否命中新索引。
- 应用错误率和写入延迟是否异常。

唯一索引创建失败时，先定位重复数据并给出迁移方案，不能通过去掉唯一约束掩盖问题。

若错误信息包含 `duplicate groups must be cleaned`：

1. 记录错误中的集合、索引名和重复键样本。
2. 核对业务主记录，制定合并、归档或删除重复数据的方案。
3. 清理后重新执行完整脚本，不要只手工补建失败索引。
4. 再次执行 `getIndexes()`；同定义收紧失败的索引可能处于 `prepareUnique` 状态，这是阻止新增重复数据的保护状态。

## 3.1 给 DBA 的待执行项：网页托管清理索引（2026-09-24）

**要做什么**：确认目标库上有下面两条索引，没有就跑一次可执行清单补上。

| 集合 | 索引名 | 服务的查询 |
|---|---|---|
| `hosted_sites` | `idx_hosted_sites_asset_cleanup_due` | 认领「还欠着待删对象、到点了、租约已过期」的站点，按下次尝试时间从早到晚取一条。带 partial filter，只收 `PendingAssetCleanupKeys` 非空的站点 |
| `hosted_site_deletion_tasks` | `idx_hosted_site_deletion_due` | 认领「到点了、租约已过期」的删除任务，按下次尝试时间从早到晚取一条 |

**为什么要建**：API 里的后台任务 `HostedSiteDeletionCleanupService` 每分钟跑一轮，每轮最多认领 20 次，
每次各向这两个集合发一条「按条件找一条并加租约」的请求。缺了索引，这两条请求每次都是整表扫描
再在内存里排序——哪怕根本没有待清理的东西，空扫也照样付全表的代价。站点与删除任务越多，
数据库每分钟被拖一次的程度越重。它不报错、不变红，只会表现为数据库负载与慢查询。

**怎么知道缺没缺**：API 启动后会查一次（只查不建），缺了在日志里写一条 Warning，开头就是后果，
例如「缺少 MongoDB 索引 idx_hosted_site_deletion_due（集合 hosted_site_deletion_tasks），于是：网页托管删除清理每分钟一轮……」。
同一份结论也挂在 `GET /health/ready` 的 `missingIndexes` / `unverifiedIndexes` / `indexesCheckedAt`
三个字段上，只读附带，**不影响**就绪判定。另外 `GET /api/healthz/deep` 每次被探测都会现查一次，
缺失数挂在 `mongo.required-indexes` 这条检查上并声明了 `cds:monitor`，CDS 的常设探针（2 小时一轮，连败 3 次即 6 小时内告警）
会在缺失时响铃；它现查的同时刷新 `/health/ready` 的快照，所以补建后不必重启。
这次启动巡检同时覆盖三条唯一索引（`hosted_site_revisions.uniq_hosted_site_revision_rollback_idempotency`、
`infra_agent_sessions.uniq_infra_agent_sessions_prewarm_key`、`activity_logs.uniq_activity_logs_deduplication_key`），
它们缺席时是并发重复写入而不是变慢；补建方式与本节相同。巡检清单与脚本的名字一致性有 xUnit 守卫。

### 执行

按第 2 节的前置检查做完（备份、确认环境、评估在线建索引的影响），整份执行：

```bash
mongosh "<connection-uri>/<database>" scripts/mongodb-indexes.js
```

脚本不支持只跑其中几条，而且也不需要：它是幂等的，已存在的同名同定义索引不会重建。
但整份执行会同时处理脚本里登记的其它迁移（见第 2 节「三类操作」表），维护窗口按整份脚本的范围评估，
不要只按这两条估。

### 验证

**第一步，核对名称、键与 partial filter**（把连接串换成目标库）：

```bash
mongosh "<connection-uri>/<database>" --quiet --eval 'printjson(db.hosted_sites.getIndexes().filter(i => i.name === "idx_hosted_sites_asset_cleanup_due"))'
mongosh "<connection-uri>/<database>" --quiet --eval 'printjson(db.hosted_site_deletion_tasks.getIndexes().filter(i => i.name === "idx_hosted_site_deletion_due"))'
```

| 索引 | 键（依次） | partial filter |
|---|---|---|
| `idx_hosted_sites_asset_cleanup_due` | `AssetCleanupNextAttemptAt` 升序、`AssetCleanupLeaseExpiresAt` 升序 | `PendingAssetCleanupKeys.0` 存在 |
| `idx_hosted_site_deletion_due` | `NextAttemptAt` 升序、`LeaseExpiresAt` 升序 | 无 |

定义以脚本为准，这张表只是核对口径；两边对不上时以脚本为准，并回来改表。

**第二步，确认清理查询命中索引**。下面两条照搬后台任务的真实条件与排序（每次找一条、按下次尝试时间升序）：

| 集合 | 条件（同时满足） | 排序 |
|---|---|---|
| `hosted_sites` | `PendingAssetCleanupKeys.0` 存在；租约到期时间为空或已过；下次尝试时间为空或已到 | 下次尝试时间升序 |
| `hosted_site_deletion_tasks` | 租约到期时间为空或已过；下次尝试时间已到 | 下次尝试时间升序 |

```bash
mongosh "<connection-uri>/<database>" --quiet --eval 'const now = new Date(); printjson(db.hosted_sites.find({"PendingAssetCleanupKeys.0": {$exists: true}, $and: [{$or: [{AssetCleanupLeaseExpiresAt: null}, {AssetCleanupLeaseExpiresAt: {$lte: now}}]}, {$or: [{AssetCleanupNextAttemptAt: null}, {AssetCleanupNextAttemptAt: {$lte: now}}]}]}).sort({AssetCleanupNextAttemptAt: 1}).limit(1).explain("executionStats"))'
mongosh "<connection-uri>/<database>" --quiet --eval 'const now = new Date(); printjson(db.hosted_site_deletion_tasks.find({$or: [{LeaseExpiresAt: null}, {LeaseExpiresAt: {$lte: now}}], NextAttemptAt: {$lte: now}}).sort({NextAttemptAt: 1}).limit(1).explain("executionStats"))'
```

判定：`queryPlanner.winningPlan` 里出现 `IXSCAN` 且 `indexName` 是对应索引，没有 `COLLSCAN`，也没有单独的内存排序 `SORT` 阶段；
`executionStats.totalDocsExamined` 远小于集合总文档数。第一条的条件里必须带着 `PendingAssetCleanupKeys.0` 存在这一项，
partial 索引才会被选中——后台任务的真实查询带着它，照搬即可，不要删。

**第三步，打一次 `GET /api/healthz/deep`**，确认 `mongo.required-indexes` 的 `observedValue` 为 0，随后 `/health/ready` 的 `missingIndexes` 为空数组（不需要重启 API）。

### 回滚

只有在确认这两条索引本身导致写入或资源异常时才回滚（它们只加速读，通常不会）：

```bash
mongosh "<connection-uri>/<database>" --quiet --eval 'db.hosted_sites.dropIndex("idx_hosted_sites_asset_cleanup_due")'
mongosh "<connection-uri>/<database>" --quiet --eval 'db.hosted_site_deletion_tasks.dropIndex("idx_hosted_site_deletion_due")'
```

回滚后清理任务照常工作，只是回到每轮整表扫描；下一次深度自检（或下次启动）会重新报出缺失并触发 CDS 告警。
其余步骤按第 6 节。

### 风险

- **在线建索引的资源占用**：MongoDB 4.2 起建索引只在开头和结尾短暂持有排它锁，中间允许读写，
  但会占用 CPU、磁盘 IO 与内存，集合大时持续时间长。`hosted_sites` 的 partial filter 只收待清理的站点，
  实际要写入索引的条目通常很少；`hosted_site_deletion_tasks` 是短命的任务表，一般不大。
  两者都放在低峰执行。
- **副本集**：索引在主节点建完后会复制到从节点，从节点各自再建一遍；执行期间留意复制延迟。
- **不会阻塞 API**：应用不依赖这两条索引才能启动或工作，建索引期间清理任务照常跑，只是先慢后快。

## 4. 维护规则

1. 新集合上线前同步登记必要索引。
2. 查询字段或排序变化时审计现有索引是否仍匹配。
3. 删除索引必须有使用证据、回滚方案和维护窗口。
4. 文档只解释目的和操作，DDL 只维护在 `scripts/mongodb-indexes.js`。
5. 代码注释可引用本指南，不复制完整命令。

## 5. CDS 自持数据库例外

CDS 的 `cds_state_db` 不属于 PRD API 应用库。其 split store 由
`cds/src/infra/state-store/mongo-split-store.ts` 在 `init()` 中幂等创建自持索引，包括：

| 集合 | 索引 |
|---|---|
| `cds_activity_logs` | `projectId_1_at_-1` |
| `cds_webhook_deliveries` | `receivedAt_-1` |

DBA 不应对这两个索引重复执行应用库脚本。若 CDS 改变索引策略，应在 CDS 源码和对应测试中维护。

## 5.1 网关自持数据库的一次性索引升级

网关（llmgw）的库同样不是 PRD API 应用库。这里的索引**不在启动时创建**：启动只查它在不在，
缺了往日志写一条警告，说清缺席期间什么会退化，建索引这一步归 DBA。

为什么定这条线：在一个已经有数据的集合上建索引可能阻塞写入、拖慢就绪；副本集滚动重启时
每个实例各建各的；而建失败若没被接住，整个进程起不来。这三种后果都发生在没人盯着的启动路径上。
（历史上这几条曾在启动时自动建，2026-09-17 起改为只查不建。存量还有一批仍在启动时创建，
见 [debt.platform.llm-gateway.md](./debt.platform.llm-gateway.md)，逐步搬到本节。）

### 5.1.1 待办：线路身份索引换键

| 集合 | 旧索引 | 要换成 | 为什么 |
|---|---|---|---|
| `llmgw_model_offerings` | `uniq_llmgw_offering_tenant_logical_target_v2`（或更早的四字段版 `..._target`） | `uniq_llmgw_offering_tenant_logical_target_v3`，在旧键基础上多一个 `UpstreamModelId` | 同一个兑换所下的不同别名是不同的线路。旧索引不认这一维，第二条别名会撞 `E11000`，池搬迁在那里半途停下 |

判断要不要做：启动日志里出现「线路身份唯一索引还是旧版」那条警告就是要做。做之前照第 2 节的
通例检查（备份、确认环境、评估大集合影响），在维护窗口里先删旧的再建新的——新索引比旧的**更松**
（多一个字段只会让约束更宽），所以不需要预先清理重复数据。没做之前旧索引继续生效，后果是
「同一个兑换所的第二条别名建不出来」，会如实报错而不是静默走偏。

一条都没有时（全新库，或索引被误删）启动会报「线路身份唯一索引不存在」。那期间线路身份
没有唯一约束，两次并发创建同身份线路都会插进去。

它的定义：集合 `llmgw_model_offerings`，键依次是 `TenantId`、`LogicalModelId`、`TargetKind`、
`TargetId`、`UpstreamModelId`、`SupersededByOfferingId`（全部升序），唯一，无部分过滤器。

**不用手敲**：这条与下一节那四条都在第 3 节那份可执行索引清单里，对着网关库跑一次即可。
脚本会先建好 v3、确认它在了之后再丢掉更严的旧版，顺序不会反；清单里的其它索引与网关无关，
脚本按集合是否存在自行跳过。下面的表用于核对与排障，不是让人照着一条条敲。

### 5.1.2 待办：控制台的四条唯一索引

这四条是库级不变量——端点里的「先查有没有别人」在并发下挡不住，Mongo 没有跨文档原子性可用。
缺哪一条，启动日志里就有对应的一行，写着缺席期间会退化成什么样。

| 集合 | 索引 | 缺了会怎样 |
|---|---|---|
| `llmgw_logical_models` | `uniq_llmgw_logical_default_per_type` | 两个管理员同时把不同模型设成同一个用途的默认，两次都成功，库里有两个默认，解析到哪个全看排序 |
| `llmgw_logical_models` | `uniq_llmgw_logical_claim_per_type` | 同一个调用方被两条模型同时认领 |
| `llmgw_model_catalog_entries` | `uniq_llmgw_catalog_entry_key` | 两条补登抢同一个标识或等价写法 |
| `llmgw_imagegen_model_configs` | `uniq_llmgw_imagegen_tenant_pattern` | 同一个匹配模式两条契约，生图的尺寸与参数翻译每次刷新可能不一样 |

| 集合 | 键（依次，全部升序） | 部分过滤器 |
|---|---|---|
| `llmgw_logical_models` | `TenantId`、`ModelType` | `IsDefaultForType` 等于 true |
| `llmgw_logical_models` | `TenantId`、`ModelType`、`DefaultForAppCallerCodes` | `DefaultForAppCallerCodes` 的类型是字符串 |
| `llmgw_model_catalog_entries` | `TenantId`、`Keys` | `Keys` 的类型是字符串 |
| `llmgw_imagegen_model_configs` | `TenantId`、`ModelIdPattern` | 无 |

四条全部是唯一索引，名字见上一张表。同样**不用手敲**：它们都在那份可执行清单里，
对着网关库跑一次脚本即可。

网关库通常与应用库分开，所以清单里这一段带着一道「当前库是不是网关库」的判断，
判据是库里已经有 `llmgw_` 开头的集合——对着应用库跑不会凭空建出一堆空集合。
**第一次建网关库时库还是空的**，这个判据必然不成立，照常规命令跑会打印跳过、一条也建不出来。
库是不是网关库只有执行的人知道，所以这时由他点名：

```bash
PRD_GATEWAY_DB=1 mongosh "<connection-uri>/<网关库名>" scripts/mongodb-indexes.js
```

点名之后这一段照跑，缺的集合由 `createIndex` 顺带建出来，空库一次到位。
库里已经有 `llmgw_` 集合时不需要这个变量。

后两条的部分过滤器不是可选项：认领与补登的键存在数组里，走多键唯一索引，而空数组在多键索引里
记成 `undefined`，不加这个过滤器的话所有「一个都没认领」的文档会互相撞车，索引根本建不起来。

建不出来通常说明存量里已经有冲突的两条。按上表那一列去界面上清掉多余的那条（取消默认 /
摘掉认领 / 删掉重复补登或重复契约），再建。

## 6. 回滚

索引导致写入或资源异常时：

1. 停止继续执行剩余变更。
2. 记录已创建、原地转换和重建的索引名及执行时间。
3. 仅删除本次新建且已确认可回滚的索引；已转换的唯一索引不得直接按普通新索引处理。
4. 已知旧定义重建失败时先确认脚本是否已恢复旧索引；若恢复也失败，按备份中的旧定义人工重建。
5. 恢复服务并核对查询与写入。
6. 将未解决问题登记到对应 `debt.*`。
