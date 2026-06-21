# debt.cds-performance — CDS 性能债务台账（构建越来越慢 / 前端缓慢）

> 状态：active ｜ owner：CDS ｜ 创建：2026-06-21
> 背景：用户反馈"近几百次构建，运行时间越来越长（以前几分钟，现在 10 分钟以上）"，且"前端还是非常缓慢，彻查是不是 mongodb 索引问题"。本台账记录根因排查结论与"逐步解决"的剩余步骤。

## 根因排查结论（按影响排序）

| # | 根因 | 证据 | 严重度 | 状态 |
|---|------|------|--------|------|
| 1 | **Docker 悬空镜像 + 构建缓存无限堆积**：每次分支 `docker build` 产生中间层，分支删除只清容器/卷不清镜像层与 build cache，几百次后吃满磁盘/IO，每次构建都在膨胀的层上做 context 计算 | 分支删除路径 `branches.ts` 只删 container + volume，无 image/builder prune；janitor 只删过期分支不清 docker 垃圾 | 关键 | **已修首步**：janitor 每次 sweep 安全清理悬空镜像 + 构建缓存（保留 10GB，不碰容器/卷/有 tag 镜像）。见 `cds/src/services/janitor.ts` defaultDockerPrune |
| 2 | **每分支独立基础设施容器删除时未停**：删分支只删应用服务，per-branch mongo/redis/mysql 仍在跑，累计吃满内存/CPU（实测主机 CPU 100%、load ~20/18 核） | 删除循环只遍历 `entry.services`（应用容器） | 关键 | **待做**：删分支时一并停 per-branch infra 容器（需先确认命名约定，中风险） |
| 3 | 无定期 `docker system prune`，悬空网络/卷/缓存长期堆积 | janitor 识别过期分支但不触发 docker 清理 | 高 | 已被 #1 首步部分覆盖（镜像 + 构建缓存）；卷/网络仍未自动清（卷涉数据，谨慎） |
| 4 | **MongoDB 索引**：当前 activity log 等热数据走内存环形缓冲（暂不慢）；若按 mongo-split 迁到独立集合且按 projectId/branchId/ts 查询将走全表扫描 | `mongo-split-store.ts` 仅 `cds_branches` 建 `{projectId:1}`，activity/webhook 无复合索引 | 中（当前非主因，迁移后变关键） | **待做**：迁移前补 `(projectId, ts)`/`(projectId, branchId, ts)` 复合索引；遵守 `no-auto-index.md` 由 DBA 手动建 |
| 5 | 仪表盘热路径 `GET /api/branches` 对每项目 activity log 做 O(N) 过滤聚合 | `branches.ts:~3499` 循环 projects×200 | 中 | **待做**：getActivityLogs 加 5s TTL 记忆化 |

## 回答用户两个问题

- **"是不是 mongodb 索引问题？"**：当前**不是主因**（热数据在内存环形缓冲）。前端缓慢主要来自**主机资源被 docker 垃圾 + 残留 infra 容器拖满**（CPU 100%）。mongo 索引是**迁移后的将来风险**，应提前补但单靠它解决不了现状。
- **"为什么构建越来越长？"**：**Docker 层 + 构建缓存累积 + 残留 infra 容器**三者叠加 → 磁盘/IO/CPU 逐次恶化。首步已清悬空镜像 + 构建缓存；剩余步（停残留 infra、卷清理、索引、热路径缓存）按上表逐步推进。

## 逐步解决路线

1. [x] janitor 安全清理悬空镜像 + 构建缓存（本次，非破坏性，默认开 `config.janitor.dockerPrune`）
2. [ ] 删分支时停 per-branch infra 容器（确认命名约定后）
3. [ ] getActivityLogs 5s TTL 记忆化（热路径降负载）
4. [ ] mongo-split 迁移 activity/webhook 到独立集合时，DBA 手动建复合索引
5. [ ] 评估卷/网络的安全自动清理（涉数据，需白名单 `cds.precious`）

## 相关
- `cds/src/services/janitor.ts` — 本次首步落地
- `cds/.claude/rules/` / `no-auto-index.md` — 索引由 DBA 手动建
- 主仓 `CLAUDE.md` 规则 #11 / CDS 自部署
