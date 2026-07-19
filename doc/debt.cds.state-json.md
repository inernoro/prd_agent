# CDS state.json 影子存储 · 债务台账

> **版本**：v0.3 | **日期**：2026-05-14 | **状态**：开发中

## 总览

| 指标 | 当前值 |
|------|--------|
| open | 2（#3 / #4） |
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

## 偿还路线

1. [x] **Phase 1**：webhook deliveries 拆独立 collection（2026-07-09）。
2. [x] **Phase 2**：activity log 同上（2026-07-09）。
3. [ ] **Phase 3**：把 Projects / BuildProfiles / RoutingRules 也拆成独立 collection（注：`cds_branches` 与 `cds_projects` 在 mongo-split 已是独立 collection，本条剩 BuildProfiles / RoutingRules 与项目元信息字段的进一步收敛）。
4. [ ] **Phase 4**：删除 state.json 写路径，只保留 migration 读取（回滚数据一致性风险高，需专项设计）。

**回滚注意（Phase 1+2 之后）**：新的 webhook/activity 日志不再写进 global doc；若回滚到拆分前的旧版 CDS，将丢失拆分后新增的这两类**诊断**日志（非控制面数据，分支/项目/配置不受影响）。

## 相关

- `cds/CLAUDE.md` —— `CDS_STORAGE_MODE=mongo-split` 是默认值
- 2026-05-14 commit / PR：webhook buffer 上限从 200 → 1000、新增项目级生命周期调度
  → 都加重了 state.json 单文件压力，需要尽早开工 Phase 1
- `cds/src/services/state.ts` —— StateService 主体
