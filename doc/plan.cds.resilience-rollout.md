# CDS 高可用运行验证 · 计划

> **版本**：v2.0 | **日期**：2026-07-17 | **状态**：规划中

## 目标

把已经落地的调度器、资源限制、Janitor、executor dispatcher 和 Nginx 模板从“代码与单测可用”推进到真实多节点运行可用。架构决策以 `design.cds.resilience.md` 为准，本文不再记录已完成实现的逐文件日记。

## 当前事实

- 单机 scheduler、热冷分支、LRU 驱逐、pin、原子保存和代理 touch 已有实现与单测。
- 容器资源限制、CDS Master 容器化和 Janitor 已有代码。
- 多 executor 快照、容量感知派发和 Nginx 配置生成器已有实现。
- 尚无足够证据证明两台以上 executor、故障迁移和动态入口在真实环境长期稳定。

## Phase 1：单机资源与清理验证

1. 在真实 compose 为 API、Web 和基础设施配置资源上限，确认 Docker 实际限制与页面展示一致。
2. 启用 scheduler，验证访问 touch、空闲降冷、容量超限 LRU、pin 和唤醒。
3. 启用 Janitor，先比较 dry-run，再执行一次 sweep，确认不会删活跃 worktree、volume 或运行分支。
4. 观察 Master 容器至少 48 小时，覆盖正常重启、SIGTERM flush 和异常恢复。

通过条件：资源、分支状态和清理结果均由 API 可观察；重启后状态不丢失，也不依赖手工修改状态文件。

## Phase 2：真实多节点派发

1. 部署至少一台 scheduler 和两台 enabled executor。
2. 验证容量感知、least-branches、draining、offline 和快照超时分支。
3. 同一分支重复 dispatch 必须幂等返回原 executor。
4. executor 不可达时，调度结果必须明确失败或选择替代节点，不能返回幽灵成功。
5. 远程 executor 能获得正确 repo/ref、环境配置和项目隔离网络。

通过条件：连续创建和部署多个分支后，分配符合策略；任一 executor 下线不会让控制面卡死或把新任务继续派给离线节点。

## Phase 3：入口与故障迁移

- 将生成的 Nginx 配置写入受控目录，执行语法检查、原子切换和 reload；失败时保留上一份有效配置。
- 增加 Webhook 预热能力，验证新提交到达后目标分支可以在首个用户请求前进入 warming 或 hot。
- 实现 executor 故障后的重新派发：清理旧租约、在目标节点恢复 worktree、部署并切入口。
- 实现过载分支迁移，保留事件、审计和回滚，不以删除旧节点数据作为迁移第一步。
- `state.json` 单点问题不在本计划复制解决，统一依赖 `debt.cds.state-json.md` 的 Mongo 权威退场路线。

## 验收矩阵

| 场景 | 断言 |
| --- | --- |
| 容量满 | 非 pinned 的最冷分支被降冷，活跃请求不受影响 |
| 全部 pinned | 明确拒绝新唤醒并给出容量原因，不误杀 pinned 分支 |
| executor draining | 不接新分支，存量分支按策略迁移或保持 |
| executor offline | 心跳超时后停止派发，恢复流程有唯一 owner |
| Nginx 配置错误 | 语法检查阻断 reload，旧入口继续可用 |
| Master 重启 | 状态、租约和事件恢复，不重复启动同一分支 |
| Janitor 扫描 | 只删除达到 TTL 且无租约、无运行容器的资源 |

## 完成标准

- 两 executor 环境连续运行和故障演练通过。
- 分支派发、迁移、入口切换和回滚均有事件与可读证据。
- 所有破坏性清理默认 dry-run，执行有明确确认与范围。
- 运行手册能够让新操作者复现部署、扩容、drain、故障迁移和恢复。

## 关联文档

- `doc/design.cds.resilience.md`
- `doc/debt.cds.state-json.md`
- `doc/guide.cds.cluster-setup.md`
- `doc/report.cds.self-update-timing-audit.md`
