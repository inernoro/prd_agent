# CDS Agent Runtime 架构纠偏 · 有限计划

> 创建时间：2026-05-18 21:35 Asia/Shanghai
> 分支：`codex/cds-agent-workbench-ui`
> 目标：把 CDS Agent 从“外部 agent host / env-driven recovery”纠正回 “CDS-managed runtime/container/sandbox” 架构。

## 1. 纠偏目标

本轮只修正方向和事实源，不实现新的 runtime。

正确主线：

```text
MAP -> CDS -> CDS-managed Claude SDK runtime/container/sandbox
```

错误主线：

```text
MAP -> CDS -> external agent host
用户或操作者手工提供 CDS_REMOTE_HOST_* / SSH private key / sidecar image 作为产品主路径
```

`ssh root@62.146.168.225` 可以作为 CDS operator/debug fallback 的可用资源线索，但不能成为普通用户路径，也不能继续写成当前产品下一步。

## 2. 反思结论

“下一步口径”已经被修正超过 3 次，根源不是单个文档措辞，而是事实源仍把 operator/debug 参数当成产品主路径。

因此本轮停止继续堆文案，改为同时校准：

| 层级 | 纠偏要求 |
| --- | --- |
| 架构文档 | 明确 CDS 是容器、分支、runtime/sandbox 管理控制面 |
| 当前进度文档 | 第一屏不得要求用户补 `CDS_REMOTE_HOST_*`、SSH 私钥或 image |
| 本地 progress 输出 | 当前下一步指向纠偏计划，不指向 env handoff |
| Smoke/审计 | 检查文档、progress、refresh 三者不再把 env 作为主路径 |

## 3. 有限任务列表

| # | 任务 | 预计时间 | 成功标准 | 状态 |
| --- | --- | ---: | --- | --- |
| 1 | 建立本纠偏计划 | 10 分钟 | 计划列明任务数、ETA、测试和停止条件 | done |
| 2 | 修正主进度第一屏 | 15-20 分钟 | 第一屏明确 CDS-managed runtime 是主线，env/SSH/image 是 operator fallback | done |
| 3 | 修正执行账本当前结论 | 10-15 分钟 | 账本记录 remote-host 路线是实现层泄漏 | done |
| 4 | 校准 progress/refresh 输出 | 10-15 分钟 | 本地输出不再把补 env 当产品下一步 | done |
| 5 | 更新一致性检查 | 5-10 分钟 | 检查脚本断言 CDS-managed runtime 口径 | done |
| 6 | 冒烟测试 | 10-15 分钟 | 文档一致性、progress consistency、goal audit 可解释当前状态 | done |
| 7 | 视觉测试决策 | 5 分钟 | 明确是否需要页面截图；仅当页面文案已跟随数据源变化时执行 | done |

预计总耗时：65-90 分钟。

## 4. 问题与修正方式

| 问题 | 原因 | 修正 |
| --- | --- | --- |
| 把 `remote host` 写成主路径 | 把 CDS 底层执行资源暴露成产品架构 | 改成 CDS-managed runtime capacity；host 只作 operator fallback |
| 把 `CDS_AGENT_SIDECAR_IMAGE` 写成用户输入 | 把发布/部署细节当成用户路径 | 改成 CDS 默认 runtime image / BuildProfile / container profile 责任 |
| 进度面板要求补 env | 本地脚本事实源沿用 debug wrapper | 下一步改为执行本纠偏计划和修正 CDS-managed runtime 事实源 |
| 反复文档修正 | 根因在事实源/数据结构，不只是文案 | 本轮把 consistency check 和 goal audit 一起校准 |

## 5. 冒烟测试

本轮只跑本地/只读检查：

```bash
scripts/check-cds-agent-progress-consistency.sh
CDS_AGENT_GOAL_AUDIT_REPORT=/tmp/cds-agent-goal-audit-runtime-correction.json scripts/audit-cds-agent-goal.sh
```

成功标准：

```text
D1 progress consistency = pass
goalStatus = not_complete
当前 blocker = CDS-managed runtime 未恢复
不再把“补 CDS_REMOTE_HOST_* / SSH / image”作为产品主下一步
```

## 6. 视觉测试

本轮不立即跑视觉测试。触发条件：

```text
1. 主进度文档、progress board、refresh 输出已完成纠偏
2. runtime-status / CDS Agent 页面数据源也改成同一口径
3. 需要确认页面没有把 SSH/env/image 显示为主下一步
```

触发后测试：

```text
打开 CDS Agent 页面 -> 截图执行面板 -> 检查任务总览、当前阶段、下一步、ETA
```

## 7. 停止条件

本轮到以下状态即停止，不继续扩展实现：

```text
文档和本地事实源明确恢复到 CDS-managed runtime 架构
旧 remote-host/env 路径被标为 operator fallback
一致性检查通过
剩余实现任务被列入下一轮，而不是本轮继续做
```

## 8. 本轮验证结果

截至 2026-05-18 21:53 Asia/Shanghai：

```text
bash -n scripts/* correction targets = pass
scripts/check-cds-agent-progress-consistency.sh = pass
audit D0/D1/N6 = pass
audit goalStatus = not_complete
audit expected blocker = P0 branch isolation/shared pool is not recovered
```

解释：

```text
本轮完成的是架构口径和本地事实源纠偏。
goal audit 仍然返回 not_complete 是正确结果，因为 CDS-managed runtime/shared pool 还没有按新主线实现或恢复。
它不再把“补 SSH/env/image”作为产品主下一步。
```
