# design.cds.replica-set — 复制集模式（一个入口，多个版本并行）

> 状态：设计定稿 + MVP 实施中 | 归属：CDS | 关联：`design.cds.control-data-split.md`、`design.cds.multi-project.md`、`guide.cds.multi-branch-db.md`

---

## 管理摘要

复制集模式让一条分支的**某一个服务**（不是整条分支）同时跑多个历史版本：入口域名不变，流量由 CDS forwarder 按权重/粘性分流到不同版本的容器；每个版本还有自己的直达子域。启动秒级（全部复用已保留的不可变镜像，零构建）；一键可退回普通模式（收掉多余版本，行为与今天完全一致）；需要时可为某个版本一键隔离数据库（先克隆当前数据再切换，隔离库保留可查）。

一句话：把"回滚"从时间机器升级为"多版本并排开着比"，且随时能收回来。

## 产品定位与用户场景

| 场景 | 今天 | 复制集之后 |
|---|---|---|
| 新旧版本对比验收 | 回滚看旧版 → 再部署新版，来回切 | 两个版本同时在线，直达链接各看各的 |
| 灰度试错 | 无 | 入口 90/10 分流，出问题把权重拉回 0 |
| 实验性改动怕写坏库 | 共享库直接被写坏（隔离事故台账通道 4/8） | 一键隔离库（带数据克隆），实验版写自己的库 |
| 演示保稳定 | 演示中途 push 会替换容器 | 演示钉在成员版本的直达链上，主线随便部署 |

## 四条硬要求（用户拍板）与对应设计

1. **快速启动**：成员只能从 `DeploymentVersion` 的 reusable 快照（不可变镜像 `@sha256:` / `:sha-*`）物化——docker pull + run，无 git、无构建。不可复用的版本直接不出现在候选列表。
2. **能退回普通**：`dissolve`（解散）= 移除全部成员容器 + 删除复制集配置 + 路由表回到单条。分支回到与未启用时逐字节一致的状态。另有 `promote`：把某成员版本提升为主版本（内部走已有的 `/deploy {versionId}` 回滚机制），随后自动解散。
3. **简单实用**：主容器就是天然的"主成员"（不重建、不迁移）；新成员默认权重 0（只挂直达链、不接主入口流量），拉权重才分流；无审批、无额外概念。
4. **单服务粒度 + UI 特殊化**：复制集挂在 `BranchEntry.replicaSets[profileId]` 上，5 个容器可以只把 1 个复制集化，其余不受影响。资源卡带堆叠徽章特殊标识；分支抽屉新增「复制集」页签统一操作。

## 核心模型

```
BranchEntry.replicaSets?: Record<profileId, ProfileReplicaSet>

ProfileReplicaSet {
  profileId, enabled, primaryWeight,      // 主容器（branch.services[profileId]）即主成员
  members: ReplicaMember[],               // 额外并排版本
  createdAt, updatedAt
}

ReplicaMember {
  id ('rs' + 6位短id), versionId,          // 指向 DeploymentVersion（内容寻址、不可变）
  label?, weight (0-100; 0=不接主入口流量),
  image, commitSha,                        // 物化快照
  containerName, hostPort, status,         // 运行态（provisioning/running/stopped/error）
  dbMode ('shared' | 'isolated'), isolatedDbSuffix?,
  createdAt
}
```

要点：

- **主成员零成本**：主容器不进 members，`primaryWeight` 单独记。启用复制集 = 只写一条配置，什么容器都不动 → "启用"本身零秒。
- **成员容器命名** `cds-<branchId>-<profileId>-<memberId>`，profile id 后缀 `--<memberId>` 派生，网络别名随之隔离，不与主容器 DNS 撞车；复用 `ContainerService.runService` 全部既有逻辑（pull、分支网、readiness）。
- **成员状态不进 `branch.services`**：避免污染部署循环、发布器约定路由、服务卡列表等所有按 services 遍历的消费方（`services` 的消费方极多，进去必踩涟漪）。成员运行态记在 `ReplicaMember` 自身，分支删除/停止路径显式级联收割成员容器。

## 流量分配（forwarder 数据面）

`RouteRecord` 增加 `replicaGroup` / `replicaMemberId` 两个可选字段（不影响存量路由）：

- 发布器（`forwarder-route-publisher`）对复制集化的 profile：主路由照发（weight=primaryWeight，memberId='primary'），每个 running 成员再发一条同 host 同 prefix 的路由（weight=member.weight，memberId=member.id），同组标 `replicaGroup = <branchId>:<profileId>`。
- 每个成员追加直达 host：`<previewSlug>-<memberId>.<root>`（复用命名子域机制，≤63 字符守卫同款）。
- 解析器（`route-resolver`）：候选按现有规则排序后，若最优命中属于某 replicaGroup，则在**同组同优先级**候选里选择：
  1. 粘性命中：query `__rs` > header `x-cds-replica` > cookie `cds_rs`，值 = memberId；
  2. 否则按 weight 加权随机（weight 全 0 时回主成员）。
- forwarder-main 在选中复制集路由后 `Set-Cookie: cds_rs=<memberId>`（Lax，30 分钟），保证同一浏览器会话不横跳。websocket upgrade 只读 cookie 不设置。
- 权重全部只在数据面生效：改权重 = 改配置 → 2s 内路由表重发 → 生效，无容器操作。

nginx 位置不变：外部 nginx 只前置反代到 forwarder（历史蓝绿方案已废弃并留档，不再回去动 nginx upstream）。

## 一键隔离数据库（保留）

- 前提：项目 infra 为共享实例（现状），成员 `dbMode=isolated` 时：
  1. 计算隔离库名：复用 `db-scope-isolation.ts` 的 env key 白名单，把库名加 `_rs_<memberId>` 后缀；
  2. **先克隆**：对 mongo 走 `mongodump --archive | mongorestore`（容器内执行），mysql/mariadb 走 `mysqldump | mysql`，postgres 走 `CREATE DATABASE ... TEMPLATE`（同实例最快路径）；
  3. 克隆完成才启动成员容器（env 已指向隔离库）。
- **保留语义**：成员下线/复制集解散不 drop 隔离库；在复制集页签的「数据快照」区可见，手动删除才清理。GC 策略后续与 dbScope per-branch 残留库一起做。
- MVP 边界：克隆是停快照（不追增量）；克隆期间主库有写入不会同步过去——页签上明示"克隆时间点"。

## 用户没提但必须替他想到的边界

| 边界 | 设计决策 |
|---|---|
| 资源失控 | 每个 profile 成员上限 3；成员容器继承 profile 的 cgroup resources 限额 |
| 部署冲突 | 复制集只管成员；主容器照常被新部署替换（主成员天然滚动）。若新部署改了 pathPrefixes，发布器按最新 profile 生成组路由 |
| 分支删除 | teardown 级联：先收成员容器，再走既有分支清理；隔离库按保留语义留下，墓碑页不受影响 |
| 调度器/自动休眠 | 复制集化的分支视同 color-marked（不被 scheduler 驱逐）；解散后恢复常规热度管理 |
| 会话粘性失效 | 成员被移除时其 cookie 失配 → 解析器自动回落权重选择，不 404 |
| 观测 | 成员路由携带 branchId，HTTP 日志照记；成员卡显示直达链 + 容器状态 + 日志入口（复用 container-logs 按容器名） |
| 权限 | 复用分支操作权限；不新增角色概念（与空间/团队工程解耦，后者按既定阶段推进） |
| API 标签 | 新增路由全部登记 `resolveApiLabel()`（CDS 规则 0.1） |

## 接口设计（控制面）

```
GET    /api/branches/:branchId/replica-sets                     # 全部复制集 + 候选版本
POST   /api/branches/:branchId/replica-sets/:profileId          # 启用（零成本，只写配置）
DELETE /api/branches/:branchId/replica-sets/:profileId          # 解散=退回普通（收割成员容器）
POST   /api/branches/:branchId/replica-sets/:profileId/members  # 添加成员 {versionId, label?, weight?, dbMode?}
PATCH  .../members/:memberId                                    # 改权重/标签
DELETE .../members/:memberId                                    # 下线成员（容器移除，隔离库保留）
POST   .../members/:memberId/promote                            # 提升为主版本（走 deploy {versionId}），随后解散
```

## 分阶段落地

| 阶段 | 内容 | 状态 |
|---|---|---|
| MVP-1 | 类型 + ReplicaSetService + API + forwarder 分流 + 成员物化 + 抽屉页签/卡片徽章 | 已上线（2026-07-23 CDS 自更新） |
| MVP-2 | 一键隔离数据库（克隆三适配）+ 数据快照列表 | 已上线 |
| MVP-3 | 「一个 + 号」简化（用户 2026-07-23 拍板，对标 Railway）：+ 副本 = 当前版本同版本实例、权重自动均分；历史版本降级为次级入口 | 已上线 |
| 波4 | **数据库保护罩**（用户拍板）：数据库资源卡上的盾形按钮，一键隔离该分支数据库——整库克隆 + 分阶段真实进度条（枚举表/导出/导入/校验行数对比，让用户「亲眼看见才相信」）+ 克隆完成后的一致性校验报告 | 设计中 |
| 波5 | **数据回写**（用户拍板）：实验期间写进隔离库的数据合并回主库。mysql 走 binlog（克隆时记 GTID/位点，回写按 db 过滤重放 + 库名改写）；mongodb 走 oplog/change stream（克隆时记 ts，按 ns 过滤重放）；postgres 走逻辑复制槽。冲突策略先做「隔离库赢 + 冲突清单人工确认」 | 设计中 |
| 后续 | 成员健康探测联动权重、隔离库 GC、比例分流的会话级 A/B 报表 | 规划 |

## 风险

- 加权随机使 forwarder 解析不再纯确定：仅在 replicaGroup 存在时启用，存量路径逐字节不变；单测覆盖分布与粘性。
- 成员容器绕过 build-gate：成员启动零编译（纯 pull+run），按极速版同口径不占构建槽；回退源码编译的路径在成员物化中被禁止（直接报错），杜绝绕闸。
- 镜像被 GC：物化前 `docker image inspect`/pull 校验，拉不到即成员进 error 态并给明确原因，不静默。
