# CDS state.json 影子存储 · 债务台账

> **版本**：v0.4 | **日期**：2026-07-27 | **状态**：开发中

## 总览

| 指标 | 当前值 |
|------|--------|
| open | 3（#3 / #4 / #5） |
| in-progress | 0 |
| paid | 2（#1 / #2，2026-07-09） |

**2026-07-09 缓解补记**（本轮偿还前的台账外缓解，与 `debt.cds.performance.md` #4 同根）：
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
| #2 | branch activity log（ProjectActivityLog ring buffer）按整对象 save | save 频率提高时阻塞主循环 | **paid（2026-07-09）**：拆独立 collection `cds_activity_logs`（复合 `_id=${projectId}__${at}__${log.id}`，log.id 非全局唯一故用复合键），同 #1 的 diff-based 写与 legacy 回退。索引由 `init()` 自动创建（`{projectId:1, at:-1}` / `{receivedAt:-1}`，沿 split store 既有惯例；no-auto-index 规则针对 prd-api 应用库，不适用 CDS 自持库。DDL 记录见 `doc/guide.platform.mongodb-indexes.md` CDS 段） |
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

**根因判断**：宿主机资源耗尽（kafka/mongo 相继死亡）→ 自用 mongo 不可用 → state persist 失败 → master 宕机。当时生产运行 `95d1c24`（复制集第 25 轮），已逐行排除该 commit 的三处改动与本事故的因果（均有异常兜底且不在崩溃路径）。

**暴露的结构性债务**：
- （#5 本体）master 把自用 mongo 当强依赖，mongo 死亡波及全局且不能自愈拉回（35 分钟窗口远超任何合理重启退避）。偿还方向：state persist 失败降级为「内存态 + json fallback + 告警」而非放任 master 死亡；master 存活性看门狗（进程级，独立于 systemd 默认退避）。
- 中断派发自动补发机制已存在但被 `CDS_DEPLOY_DISPATCH_RETRY_ENABLED` 门禁默认关闭——与 `doc/debt.cds.selfupdate-prebuilt.md` 开放债务 #1 的偿还方向重合，评估默认开启。

## 相关

- `cds/CLAUDE.md` —— `CDS_STORAGE_MODE=mongo-split` 是默认值
- 2026-05-14 commit / PR：webhook buffer 上限从 200 → 1000、新增项目级生命周期调度
  → 都加重了 state.json 单文件压力，需要尽早开工 Phase 1
- `cds/src/services/state.ts` —— StateService 主体
