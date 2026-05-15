# CDS state.json 影子存储 · 债务台账

> **版本**：v0.1 | **日期**：2026-05-14 | **状态**：open / 待规划

## 总览

| 指标 | 当前值 |
|------|--------|
| open | 4 |
| in-progress | 0 |
| paid | 0 |

模块范围：`cds/src/services/state.ts` 及所有调用 `stateService.save()` 的写入路径。

## 背景

CDS 在 P4 阶段引入了 MongoDB split store（`CDS_STORAGE_MODE=mongo-split`），fresh
install 默认走 mongo。但代码层面 `state.json` 仍然是 in-memory state 的兜底持久层：
- `StateService` 仍然把整张 state 加载进内存
- 任何 `save()` 调用同时写 mongo 和 state.json（如果 mongo 不可用则只写 json）
- `state.json` 体积随历史数据线性增长（webhook deliveries ring buffer 上限刚从 200 调到 1000）

2026-05-14 用户明确指示："本系统尽量去掉 state.json 形式，如果没有改进，列进技术债务，
去掉 state.json这个影子，属于过时设计，甚至会撑爆mongodb"。本台账登记后续偿还计划。

## open 债务

| 编号 | 债务 | 影响 | 偿还方向 |
|---|---|---|---|
| #1 | webhook deliveries ring buffer 上限 1000 仍按一次性 `save()` 把整数组刷盘，state.json 大项目下可能数 MB | 启动加载慢 / save 抖动 | 拆 collection：`cds_webhook_deliveries`，配 mongo capped collection（max=1000）；只追加写、不全量刷 |
| #2 | branch activity log（ProjectActivityLog ring buffer）同样按整对象 save，自动调度器加入后写入量上升 | save 频率提高时阻塞主循环 | 同 #1 拆 collection，或改成 append-only 日志文件按天 rotate |
| #3 | 项目级 `defaultDeployModes` / `autoPublishAfterMinutes` / `autoStopAfterMinutes` 等元信息混在 state 顶级 | 任何改设置都要重写整个 state.json | 拆 `cds_projects` collection；StateService 改成 thin lookup |
| #4 | mongo-split 模式仍保留 state.json fallback，意外回滚到 json 模式时数据可能落后 mongo | 容易踩到"为什么我新建的分支不见了"陷阱 | 把 state.json 降级为只读快照（startup migration only），写路径不再回写 |

## 偿还路线建议

1. **Phase 1**（低风险）：拆 webhook deliveries 到独立 collection，state.json 不再含此字段。
2. **Phase 2**：activity log 同上。
3. **Phase 3**：把 Projects / BuildProfiles / RoutingRules 也拆成独立 collection。
4. **Phase 4**：删除 state.json 写路径，只保留 migration 读取。

## 相关

- `cds/CLAUDE.md` —— `CDS_STORAGE_MODE=mongo-split` 是默认值
- 2026-05-14 commit / PR：webhook buffer 上限从 200 → 1000、新增项目级生命周期调度
  → 都加重了 state.json 单文件压力，需要尽早开工 Phase 1
- `cds/src/services/state.ts` —— StateService 主体
