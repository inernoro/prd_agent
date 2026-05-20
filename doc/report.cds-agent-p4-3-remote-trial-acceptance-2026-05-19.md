# CDS Agent P4-3 远端试用入口与发布验收包

日期：2026-05-19

## 结论

P4-3 完成。远端试用入口、复跑方式、结果查看、失败排查和发布验收边界已经收口。当前不需要 SSH、remote host env、镜像仓库或用户手动提供 Anthropic 原生 profile；普通试用路径只通过 CDS Agent 工作台进入。

当前推荐试用范围是：只读代码巡检、运行过程观察、停止/超时验证、产物查看、trace 复盘。写代码、写知识库、创建 PR、apply/commit 仍不进入默认路径。

## 试用入口

| 项 | 内容 |
| --- | --- |
| 页面 | `https://cds-agent-workbench-ui-codex-prd-agent.miduo.org/cds-agent` |
| 当前分支 | `codex/cds-agent-workbench-ui` |
| 已验收 runtime commit | `6b2f1552e` |
| 当前文档 commit | `7511ea723` |
| 默认用途 | 只读代码巡检 |
| 默认安全边界 | hardened-readonly，不暴露 Bash/Edit/Write |
| runtime owner | CDS-managed `claude-agent-sdk` |
| loop owner | official Claude Agent SDK adapter |

## 普通用户 3 步试用

| 步骤 | 操作 | 预期结果 |
| --- | --- | --- |
| 1 | 打开 CDS Agent 工作台，确认处于简洁模式 | 页面显示目标、任务、运行按钮、状态、结果和产物入口 |
| 2 | 选择仓库/ref，输入一个明确的只读巡检任务 | 不要求用户理解 runtime、profile、sidecar、host 或 provider secret |
| 3 | 点击运行，等待结果或点击停止 | 页面展示 `sessionId`、`traceId`、状态、耗时、`timeoutAt`、`lastEventSeq`、事件、结果和 artifacts |

推荐试用 prompt：

```text
请只读巡检当前仓库的 README.md 和主要项目结构，输出：
1. 仓库/ref
2. 你实际读取的文件
3. 是否发现高风险问题
4. 下一步建议

不要修改文件，不要执行写入命令，不要创建 PR。
```

## 研发复跑命令

| 场景 | 命令 | 说明 |
| --- | --- | --- |
| P4 provider one-cycle | `CDS_HOST=https://cds-agent-workbench-ui-codex-prd-agent.miduo.org SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 bash scripts/smoke-cds-agent-one-cycle.sh` | 真实 provider 调用，只有 profile/code 改动后才需要重跑 |
| S1 只读代码巡检 | `CDS_HOST=https://cds-agent-workbench-ui-codex-prd-agent.miduo.org SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 bash scripts/smoke-cds-agent-official-sdk-run.sh` | 验证官方 SDK adapter 能完成只读巡检 |
| S2/S3 controls | `CDS_HOST=https://cds-agent-workbench-ui-codex-prd-agent.miduo.org SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 bash scripts/smoke-cds-agent-official-sdk-controls.sh` | 验证危险工具阻断和 stop |
| 远端视觉 | `CDS_HOST=https://cds-agent-workbench-ui-codex-prd-agent.miduo.org bash scripts/smoke-cds-agent-remote-workbench-visual.sh` | 验证工作台可观测信号 |
| 本地基础门禁 | `bash scripts/smoke-cds-agent-simple-panel.sh` | 不触发 provider，适合开发中快速验证 |

复跑原则：先跑本地和静态门禁；只有运行时代码、profile、provider 或远端页面入口变化时，才跑 provider one-cycle。不要用重复部署替代问题定位。

## 结果怎么看

| 看什么 | 位置 | 合格标准 |
| --- | --- | --- |
| 运行状态 | 简洁面板状态区 | running/completed/failed/stopped/timeout 状态清晰 |
| trace | 运行详情或诊断区 | 有 `traceId`，能关联 MAP session 与 CDS runtime |
| 事件 | Timeline / events | `lastEventSeq` 增长，运行中能看到 SDK 事件同步 |
| 超时 | 状态卡 | 有 `timeoutAt`，失败时不静默卡住 |
| 停止 | Stop 按钮和最终状态 | 停止后最终状态为 stopped，后台不继续消耗 |
| 结果 | 结果区域 | 有 finalText 或明确失败原因 |
| 产物 | Artifacts | 有可点击入口，能回看 trace/report/screenshot |

## 失败排查入口

| 现象 | 优先看哪里 | 处理 |
| --- | --- | --- |
| 页面打不开 | preview root 和 `/cds-agent` | 确认远端服务是否 running，不先重跑 provider |
| 卡在运行中无事件 | runtime SSE ingest、`lastEventSeq`、CDS session events | 先看 MAP 是否导入 CDS 事件，不直接判定模型失败 |
| provider 报错 | `runtime-status`、R1 report、profile test | 确认 CDS-managed provider-switch profile 是否仍可用 |
| `error_max_turns` | session final status 和 error kind | 当作 `sdk_turn_limit`，缩窄 prompt 或提高任务拆分，不静默重试 |
| 危险工具被拒绝 | controls report | hardened-readonly 下这是正确结果 |
| 需要写文件/PR | writable profile 和审批链路 | 不在默认试用路径启用，进入后续 P4-5/P5 再评估 |

## 发布验收边界

| Gate | 必须满足 | 当前证据 |
| --- | --- | --- |
| MAP/CDS 控制面未偏离 | MAP 不直连 agent host；CDS 管理 runtime/container/sandbox | 唯一架构文档 §1、§2、§14 |
| 官方 SDK adapter 主路径 | 自研 loop 不作为默认执行路径 | P4-2 A0 pass |
| 远端 provider-backed 只读巡检 | S1 pass，能返回真实 finalText | `/tmp/cds-agent-p4-2-one-cycle-accepted/s1-report.json` |
| 危险工具默认阻断 | S2 pass，dangerous approvals/tools 为 0 | `/tmp/cds-agent-p4-2-one-cycle-accepted/controls-report.json` |
| stop 可用 | S3 pass，最终状态 `stopped` | `/tmp/cds-agent-p4-2-one-cycle-accepted/controls-report.json` |
| 可观察性可见 | 视觉 coverage 19 个信号全覆盖 | `/tmp/cds-agent-p4-2-one-cycle-accepted/workbench-visual.coverage.json` |
| 验收报告齐全 | P4-1/P4-2/P4-3 均有 Markdown/HTML/PDF | `doc/report.cds-agent-p4-*.pdf` |

## 当前不开放的能力

| 能力 | 状态 | 原因 |
| --- | --- | --- |
| 代码写入 | 非默认 | 必须启用 writable profile、MAP approval、diff 和回滚边界 |
| 创建 PR | 非默认 | 需要人工审批和发布策略确认 |
| 知识库写入/apply | 非默认 | Phase 2 本地已验证 draft/diff/apply，但远端试用默认仍只读 |
| commit | 非默认 | 必须在写入审批链路和仓库权限边界完成后开放 |
| 多运行时 OpenAI/Google/Codex adapter | planned-blocked | 需要同一套事件、审批、取消、workspace、artifact 验收后才可路由 |

## 交接给用户的最短说明

1. 打开 `https://cds-agent-workbench-ui-codex-prd-agent.miduo.org/cds-agent`。
2. 选择仓库/ref，输入只读巡检任务。
3. 点击运行，在面板查看 trace、耗时、事件、结果和产物；需要中断时点击停止。

如果失败，先看页面上的失败原因、`traceId` 和事件，不要先要求配置 SSH、镜像、remote host env 或 Anthropic 原生 profile。

## 下一步

P4-4：发布/合并策略评估。需要用户确认是把 `codex/cds-agent-workbench-ui` 合并到 main，还是继续保留 preview 试用一轮。进入 P4-4 前不需要再做 provider/profile 修复。
