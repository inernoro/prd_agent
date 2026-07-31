# CDS state.json 影子存储 · 债务台账

> **版本**：v0.4 | **日期**：2026-07-27 | **状态**：开发中

**一句话**：单文件状态存储作为影子存储仍在写，本文记它的债务、偿还路线与一次生产事故档案。
**谁该读**：接手状态存储迁移的工程师。
**读完能做什么**：知道影子存储还剩哪些依赖，以及事故是怎么发生的。

---

## 总览

| 指标 | 当前值 |
|------|--------|
| open | 3（#3 / #4 / #5，#5 已部分偿还） |
| in-progress | 0 |
| paid | 2（#1 / #2，2026-07-09） |

**2026-07-09 缓解补记**（本轮偿还前的台账外缓解，与 [debt.cds.performance.md](./debt.cds.performance.md) #4 同根）：
- JSON 存储 `save()` 从「每次同步 stringify + fsync + 写 .bak」改为 dirty + setImmediate 合并异步落盘（.bak 60s 节流 + flush + shutdown 兜底）——「save 阻塞主循环」的痛点大幅缓解（commit `d9fb5dc`）。
- 容器日志黑匣子（另一条隐性膨胀源，本台账原未登记）加 per-branch 10 条/2MB 双闸 + 启动孤儿裁剪。
- mongo-split 层原有 `compactGlobalRestToFit` 12MB 裁剪兜底仍在。

模块范围：`cds/src/services/state.ts` 及所有调用 `stateService.save()` 的写入路径。

## 背景

CDS 在 P4 阶段引入了 MongoDB split store（`CDS_STORAGE_MODE=mongo-split`），fresh
install 默认走 mongo。但代码层面 `state.json` 仍然是 in-memory state 的兜底持久层：
- `StateService` 仍然把整张 state 加载进内存
- 任何 `save()` 调用同时写 mongo 和 state.json（如果 mongo 不可用则只写 json）
- `state.json` 体积随历史数据线性增长（webhook deliveries ring buffer 上限刚从 200 调到 1000）

2026-05-14 用户明确指示："本系统尽量去掉 state.json 形式，如果没有改进，列进技术债务，
去掉 state.json这个影子，属于过时设计，甚至会撑爆mongodb"。本台账登记后续偿还计划。

## 债务清单

| 编号 | 债务 | 影响 | 状态 |
|---|---|---|---|
| #1 | webhook deliveries ring buffer 按一次性 `save()` 整数组刷盘 | 启动加载慢 / save 抖动 | **paid（2026-07-09）**：拆独立 collection `cds_webhook_deliveries`（`_id=delivery.id`，diff-based bulkWrite 只写变化条目；内存 ring buffer 淘汰经 diff 产生 deleteOne 天然上限，不用 capped collection）。global doc 不再含此字段，旧数据 legacy 回退读，零迁移脚本 |
| #2 | branch activity log（ProjectActivityLog ring buffer）按整对象 save | save 频率提高时阻塞主循环 | **paid（2026-07-09）**：拆独立 collection `cds_activity_logs`（复合 `_id=${projectId}__${at}__${log.id}`，log.id 非全局唯一故用复合键），同 #1 的 diff-based 写与 legacy 回退。索引由 `init()` 自动创建（`{projectId:1, at:-1}` / `{receivedAt:-1}`，沿 split store 既有惯例；no-auto-index 规则针对 prd-api 应用库，不适用 CDS 自持库。DDL 记录见 [doc/guide.platform.mongodb-indexes.md](./guide.platform.mongodb-indexes.md) CDS 段） |
| #3 | 项目级 `defaultDeployModes` / `autoPublishAfterMinutes` / `autoStopAfterMinutes` 等元信息混在 state 顶级 | 任何改设置都要重写整个 state.json | open（Phase 3） |
| #4 | mongo-split 模式仍保留 state.json fallback，意外回滚到 json 模式时数据可能落后 mongo | 容易踩到"为什么我新建的分支不见了"陷阱 | open（Phase 4） |
| #5 | CDS master 对自用 mongo（`cds-infra-mongodb`）无可用性降级：mongo 死亡时 state 持久化直接失败，master 随后整体宕机且无快速拉回 | 2026-07-27 生产事故（见下）：约 35 分钟全局 502，期间所有分支预览 / webhook / check-run 回写全部中断 | open |

## 偿还路线

1. [x] **Phase 1**：webhook deliveries 拆独立 collection（2026-07-09）。
2. [x] **Phase 2**：activity log 同上（2026-07-09）。
3. [ ] **Phase 3**：把 Projects / BuildProfiles / RoutingRules 也拆成独立 collection（注：`cds_branches` 与 `cds_projects` 在 mongo-split 已是独立 collection，本条剩 BuildProfiles / RoutingRules 与项目元信息字段的进一步收敛）。
4. [ ] **Phase 4**：删除 state.json 写路径，只保留 migration 读取（回滚数据一致性风险高，需专项设计）。

**回滚注意（Phase 1+2 之后）**：新的 webhook/activity 日志不再写进 global doc；若回滚到拆分前的旧版 CDS，将丢失拆分后新增的这两类**诊断**日志（非控制面数据，分支/项目/配置不受影响）。

## 事故档案：2026-07-27 生产 CDS 全局宕机约 35 分钟（债务 #5 的实证）

**时间线**（均 UTC，取自 CDS server-events 与外部健康探测）：

1. 06:29 分支部署 `dr_b0a5600677ae4e8640007f2b` 开始（prd-agent 复制集分支，构建阶段正常）。
2. 06:30:29 起 `cds-infra-metersphere-kafka` 连续 die（exitCode=1，两轮重启均失败）——宿主资源压力的首个信号。
3. ~06:32 该部署在 `state-flush` 阶段失败，错误 `cds.state.persist`：「部分服务启动失败: api/admin/llmgw-web，但 CDS 状态持久化失败，本次不报告成功」。
4. 06:30:35 后 server-events 完全静默——master 进程死亡；外部探测 06:33 起 `/api/health` 持续 502（Cloudflare 回源被拒）。
5. 07:07:46 master 进程被重新拉起（pid 14252）；07:07:49 第一件事即 `docker run started infra cds-infra-mongodb` → 07:07:56 healthy——**自用 mongo 在宕机窗口内是死的**，state persist 失败与之直接对应。
6. 07:07:52 「stale webhook deploy dispatch interrupted」+「部署重试已关闭（未设 `CDS_DEPLOY_DISPATCH_RETRY_ENABLED`），跳过 1 个中断派发的自动补发」——中断的部署不会自动补发，需人工重触发。
7. 07:08 看门狗把 `dr_b0a5600` 心跳过期收敛为 failed（PR check 红）；07:09 人工重触发 `dr_5d089e2c` 一次成功，分支服务全部恢复。

**根因（已由宿主侧 SSH 取证确认，2026-07-27）：根盘 100% 写满**。

```
/dev/sda1  338G  338G  362M  100% /
  -> cds-infra-cds-state-mongo 写 /data/db/diagnostic.data/metrics.interim.temp 失败（FileStreamFailed）并退出
  -> CDS master connect ECONNREFUSED 127.0.0.1:10097 / MongoServerSelectionError
  -> cds-master.service failed，restart counter 58（systemd 反复拉起反复失败）
```

**触发这最后几 GB 的动作**：本次 push 只改 `cds/**`，CI 的「Detect changed components」据此**跳过**了 prd-admin / prd-api / llmgw 三个组件镜像构建（该 workflow run 中三个 build job 均为 `skipped`）；CDS 部署按 SHA 拉 `ghcr.io/.../prdagent-admin:sha-95d1c24...` 扑空 → 事件打出 `prebuilt image missing, auto fallback to source-build mode 'static'` → 在宿主上**同时源码构建 admin + api + llmgw-web**，把已经逼近满盘的根盘推过临界点。

**恢复动作**（人工经 SSH 完成）：清 journal / APT 缓存 / 悬空镜像 / 构建缓存 → 磁盘 100% → 93%；清理中停止状态的 `cds-infra-cds-state-mongo` **容器**被 `docker container prune` 连带删除（**数据卷 `cds-state-mongo-data` 未丢**），用原卷重建容器后 `systemctl reset-failed cds-master && systemctl start cds-master` 恢复；最终磁盘 85%、公网 `/healthz` 200。

**分析纪律教训（务必记住）**：本 AI 在拿到宿主数据前，仅凭 CDS API 读到「磁盘 85%、内存可用 44GB」就判定「不是磁盘打满」——**那是人工清理完之后的读数**。事后测量不能用来否定事故当时的状态；没有宿主时间序列时，只能说「当前不紧张」，不能推断「当时没满」。

**已排除的怀疑（实测取证，勿再重复排查）**：
- **未释放的数据库克隆不是本次原因**：全量盘点 55 个分支，隔离快照仅剩 1 条（`prd-agent-main` 的 `prdagent_rs_guard_1` / `cds-rsdb-prdagent_rs_guard_1`，即 [doc/debt.cds.md](./debt.cds.md) #28 已登记的存量实例，其 `replicaSets` 已空——按「回切=隔离库转快照保留」设计留存）。该实例硬上限 `--memory 1536m`，磁盘占用量级与 159GB 的 containerd 不可比；孤儿容器扫描（dryRun + includeStopped）候选为 0。
- 生产当时运行 `95d1c24`（复制集第 25 轮），已逐行排除该 commit 三处改动与本事故的因果（均有异常兜底且不在崩溃路径）。

**磁盘构成（宿主实测，已用 285GB）**：

| 内容 | 大小 | 占比 |
|---|---:|---:|
| `/var/lib/containerd`（overlayfs 103G + content 56G，**5099 个镜像** / 108 容器） | 159GB | 56% |
| `/root/inernoro/prd_agent`（`.cds-worktrees` 45.5G + `.cds-cache` 7.4G + `.cds-repos` 2.2G） | 57GB | 20% |
| `/var/lib/docker`（volumes 46.4G，其中 **319 个 dangling 卷**；containers 日志 3.5G） | 50GB | 18% |

**取证缺口**：`InfraLifecycleWatcher` 的 die/oom 事件缓冲区是**内存态**，master 重启即清空——事后无法从 CDS 侧判定自用 mongo 死因（本次靠宿主 mongo 日志才定位到 FileStreamFailed）。取证器（[debt.cds.md](./debt.cds.md) #17）需要持久化才能支撑跨重启复盘。

**暴露的结构性债务（按优先级，均对照 `cds/src/services/janitor.ts` 现状核对过）**：

| P | 债务 | 现状（代码事实） | 偿还方向 | 状态 |
|---|---|---|---|---|
| P0 | **janitor 清不掉 CDS 自己造的镜像**——磁盘打满的真正引擎 | `defaultDockerPrune` 只跑 `image prune -f`（**仅悬空**）+ `builder prune --keep-storage 10GB`。而 CDS 按 `sha-<40hex>` 给每个部署版本打 tag，台账里有 **414 条 deployment version**；这些镜像**有 tag 故永不悬空**，janitor 每小时跑一次也一个都清不掉 → 宿主 5099 个镜像 / containerd 159GB | 按 CDS **自己的版本台账**做保留策略：每个 profile 保留最近 N 版（建议 3–5）+ 当前运行版，超出者显式 `docker rmi`。不能靠 docker 的悬空判定，也不能用 `image prune -af`（会连回滚镜像一起清） | **已偿还**（2026-07-27）：`image-retention.ts` 按台账保留最近 N 代 + 在用镜像回收其余；生产实测 deferred 4598 → 0，磁盘回到 37% |
| P0 | 磁盘只告警不刹车 | `sweep()` 里 `usedPercent >= diskWarnPercent(80)` 只 `console.warn`，无任何升级动作 | 三档阈值：75% 提示 / 85% 主动回收（升级保留策略、清依赖卷）/ 90% **暂停新分支构建与部署派发**，并写站内告警而非只打 console | **已偿还**（2026-07-27）：`disk-guard.ts` 四档（ok/notice/reclaim/freeze），freeze 拒绝构建部署派发，回收强度随档位上调 |
| P1 | 组件未变更却回落宿主源码构建（本次的临门一脚） | CI 因组件代码未变而跳过镜像构建是**正确**的；错在 CDS 把「按 SHA 拉镜像扑空」一律当成「需要在宿主全量重编」 | 拉取失败时先复用「该组件最近一次有镜像的版本 / 当前正在跑的镜像」，只有组件代码确实变更且镜像缺失才允许宿主源码构建；宿主源码构建串行化 + 并发闸，禁止三个重编同时打满 | **已偿还**（2026-07-28）：`prebuilt-reuse.ts` —— 拉不到镜像时先按 git diff 判该组件子树有无变更，无变更复用上一版镜像，判不出来才重编 |
| P1 | 容器日志无上限 | 全仓 `docker run` 参数中**没有任何** `--log-opt max-size/max-file` | 所有托管容器统一加 `--log-opt max-size=50m --log-opt max-file=3`（`/var/lib/docker/containers` 现已 3.5GB） | **已偿还**：托管容器统一 `--log-opt max-size=50m --log-opt max-file=3`；2026-07-28 补上 bootstrap 建的 CDS 状态库 mongo（全仓最后一个漏网） |
| P1 | （#5 本体）master 把自用 mongo 当强依赖 | mongo 死亡 → state persist 失败 → master 反复启动失败（restart counter 58），35 分钟无自愈 | state persist 失败降级为「内存态 + json fallback + 告警」而非放任 master 死亡；关键前置检查磁盘余量，满盘时进只读保命模式 | **部分偿还**（2026-07-28）：`boot-retry.ts` 启动期退避重试（约 90s 忍耐窗口）+ 放弃前磁盘诊断直指真凶，systemd 重启风暴消除。**仍欠**：运行期 persist 失败的只读保命模式（写失败已不杀进程——store 的写队列只记 `lastWriteError` 不抛进程，但没有显式只读态与 UI 提示） |
| P2 | janitor 看不见孤儿 worktree 与依赖卷 | sweep 只遍历 `stateService.getAllBranches()`；孤儿 infra 容器**只报不删**；`cds-nm-*` 依赖卷、319 个 dangling 卷完全不在清理范围。生产 55 个分支全部无 `executorId`，按 TTL 只有 3 个够格删——而宿主 `.cds-worktrees` 已 45.5GB | 增加「磁盘上的 worktree 目录 ↔ 台账分支」双向对账（目录无对应分支 = 孤儿，可删）；`cds-nm-*` 依赖卷纳入 dangling 回收 | **已偿还并生产验证**（2026-07-28）：`orphan-worktree.ts` 双向对账，三重护栏（够老 / 无容器挂载 / 单轮上限）。上线后经三轮生产实测定位（命令用错 → 丢 stdout → Go 模板转义）才真正跑通，实测 `removed 20 / deferred 45`，磁盘 37%→35%，按每轮 20 个自动收敛。三次故障表现均为「不删」，护栏未失守。**仍欠**：`cds-nm-*` 依赖卷纳入回收 |
| P2 | 无全局 prune 互斥 | janitor 内部是串行 for，但与人工/其他路径无锁——人工恢复时即撞上 `a prune operation is already running` | 全局 prune 锁（同一时刻只允许一个回收操作） | **已偿还**（2026-07-28）：`reclaim-lock.ts` CDS 侧回收互斥，拿不到锁跳过本轮不排队。边界：管不到宿主上的人工 prune |
| P2 | 关键容器无保护标记 | janitor 自身**安全**（不跑 `container prune` / `volume prune`），但 `cds-infra-cds-state-mongo` 停止后被人工 `docker container prune` 连带删除 | 给关键容器/卷打 `cds.protected=true`，并在运维手册明确「禁止裸跑 container/volume prune」 | **代码已偿还、生产待迁移**（2026-07-28）：CDS 状态库 mongo + 全部 infra 打 `cds.protected=true`，孤儿收割器按标记豁免；安全清理命令见下方运维须知。**存量容器仍是裸的**——docker 不能给已存在的容器补 label，而现网走的是「复用已有容器」路径，`exec_cds.sh` 现在会体检并打印重建命令，实际重建待低峰期人工执行（见下方运维须知） |
| P2 | 中断派发不自动补发 | 机制已存在但被 `CDS_DEPLOY_DISPATCH_RETRY_ENABLED` 默认关闭 | 与 [doc/debt.cds.selfupdate-prebuilt.md](./debt.cds.selfupdate-prebuilt.md) 开放债务 #1 合并偿还，评估默认开启 | **已偿还**（2026-07-27，走事前避免而非事后补偿）：`deploy-drain.ts` 自更新重启前排空在途部署 + 排空期间关闭部署入口；刻意不打开 `CDS_DEPLOY_DISPATCH_RETRY_ENABLED`（那道闸是治重试风暴关的） |

## 运维须知：安全的 Docker 清理命令（2026-07-28 补）

事故当天 `cds-infra-cds-state-mongo` 停止后被人工 `docker container prune` 连带删除，
CDS 状态库随之消失。关键容器现已打上 `cds.protected=true`，人工清理请一律带过滤：

```bash
# 清停止容器：排除受保护的（CDS 状态库、全部 infra）
docker container prune --filter "label!=cds.protected=true"

# 清卷：CDS 自己从不跑 volume prune，人工执行前务必确认没有受保护容器正在使用
docker volume ls --filter "dangling=true"
```

裸跑 `docker container prune` / `docker volume prune` 一律禁止。

**注意：上面的过滤只对「带标记的容器」有效，而生产那台的状态库容器目前还没有标记。**
docker 无法给已存在的容器补 label 或改日志限额，只能重建；现网部署走的是「复用已有容器」
路径，带标记的 `docker run` 从不执行。`exec_cds.sh` 现在每次启动会体检并打印可直接粘贴的
重建命令（端口 / 镜像 / 数据卷从容器实际配置读出）。**在完成这次重建之前，人工清理不要
依赖 `label!=cds.protected=true` 过滤，请先确认状态库容器不在待删列表里。**
重建本身会中断 CDS 控制面十几秒，数据在具名卷 `cds-state-mongo-data` 里不会丢，
执行后跑 `./exec_cds.sh restart`。
CDS 侧的回收（悬空镜像 / per-SHA 镜像 / 孤儿 worktree）已有进程内互斥锁，
但那把锁管不到宿主上的人——人工清理与 janitor 仍可能撞上 docker 的全局 prune 锁，
撞到时等一分钟重试即可，不要强行反复执行。

## 相关

- `cds/CLAUDE.md` —— `CDS_STORAGE_MODE=mongo-split` 是默认值
- 2026-05-14 commit / PR：webhook buffer 上限从 200 → 1000、新增项目级生命周期调度
  → 都加重了 state.json 单文件压力，需要尽早开工 Phase 1
- `cds/src/services/state.ts` —— StateService 主体
