# CDS Agent P4-1 远端发布前验收与试用入口报告

日期：2026-05-19

## 结论

P4-1 完成。当前不需要为 P4-1 重复远端部署：远端 preview 运行在 `e9e710e94`，从该提交到本轮 P3-6 基线没有 `prd-api`、`prd-admin`、`cds` 运行时代码差异，只有文档和 smoke 证据变化。本轮实际完成的是发布前门禁校准、远端 API 可达性、远端 CDS Agent 工作台视觉验收，以及下一阶段阻塞点确认。

当前最高优先级阻塞不是部署，而是远端 R1 profile/provider gate：`runtime-status` 显示 `currentBlockingGate=R1`、`currentStep=N1`，需要让远端默认 Claude Code provider-switch runtime profile 进入可用状态后再跑 provider-backed one-cycle。

## 已验证范围

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| CDS self-update 预检 | pass，目标分支与本地 HEAD 匹配；目标提交未触碰 CDS 运行时代码 | `/tmp/cds-agent-p4-1-self-update-preflight.fixed.json` |
| 避免无效部署 | pass，远端 preview 后续提交无 `prd-api/prd-admin/cds` 运行时代码差异 | `git diff --quiet e9e710e94..HEAD -- prd-api prd-admin cds` exit 0 |
| Phase 3 验收包 | pass | `bash scripts/smoke-cds-agent-phase3-acceptance.sh` |
| 简洁面板静态门禁 | pass | `bash scripts/smoke-cds-agent-simple-panel.sh` |
| 工作流最小节点 | pass | `bash scripts/smoke-cds-agent-workflow-node.sh` |
| 知识库只读工具 | pass | `bash scripts/smoke-cds-agent-kb-readonly-tools.sh` |
| 远端根页面 | pass，HTTP 200 | `https://cds-agent-workbench-ui-codex-prd-agent.miduo.org/` |
| 远端 session API | pass，authenticated list success | `/api/infra-agent-sessions?limit=1` |
| 远端 runtime-status | pass，`desiredRuntimeAdapter=claude-agent-sdk`、`runtimeTransport=sidecar-runtime-adapter`、`instanceCount=3`、`healthyCount=2` | `/tmp/cds-agent-p4-1/runtime-status.json` |
| 远端视觉验收 | pass，19 个能力信号全覆盖 | `/tmp/cds-agent-p4-1-remote-workbench.png`、`/tmp/cds-agent-p4-1-remote-workbench.txt`、`/tmp/cds-agent-p4-1-remote-workbench.coverage.json` |

## 本轮修正

| 问题 | 根因 | 修正 |
| --- | --- | --- |
| self-update 预检误报 commit mismatch | CDS 返回 9 位短 SHA，本地脚本只取 8 位短 SHA 并做精确比较 | 改为用完整 HEAD 与 CDS 返回 commit 做前缀匹配 |
| alias 探针误报失败 | 预检默认探测已被治理策略禁止的 branch-local `claude-agent-sdk-runtime-v2-prd-agent` | 默认跳过被 guard 禁止的 branch-local alias 探针，仅保留显式 legacy diagnosis |
| 远端视觉脚本误报失败 | 脚本硬编码旧版页面文案 `模型需调整`、`Claude Agent SDK` | 改为能力信号组断言，覆盖简洁模式、专业模式、trace、事件、产物、SLA、workflow/KB、governance、runtime、sandbox、provider guidance |

## 远端状态

| 字段 | 当前值 |
| --- | --- |
| preview | `https://cds-agent-workbench-ui-codex-prd-agent.miduo.org/cds-agent` |
| preview commit | `e9e710e94` |
| services | `api-prd-agent`、`admin-prd-agent` running |
| runtime adapter | `claude-agent-sdk` |
| runtime transport | `sidecar-runtime-adapter` |
| runtime instances | `3` |
| healthy runtime instances | `2` |
| current blocking gate | `R1` |
| current step | `N1` |
| residual warning | `env-sidecar: Resource temporarily unavailable (claude-agent-sdk-runtime-v2-prd-agent:7400)` |

## 风险与处理

| 风险 | 判断 | 下一步 |
| --- | --- | --- |
| 旧 branch-local alias 仍在 runtime-status blocker 中出现 | 不是 P4-1 的页面/API 阻塞；但属于历史污染残留信号，不能忽略 | P4-2 前后继续用 runtime-status 和治理面板观察，不用普通 redeploy 解决 |
| R1 provider profile 未闭环 | 阻塞真实 provider-backed 只读巡检，不阻塞页面、治理、workflow、KB 入口验收 | P4-2 只做远端 R1 profile/provider-switch 校准和一次 provider-backed one-cycle |
| CDS control plane 当前 commit 旧于目标分支 | 目标提交未触碰 CDS runtime，本轮不需要为了文档/脚本重启 CDS | 等 P4-2 有真实运行时代码或远端试用需要时再做关键 self-update |

## 下一步

P4-2：远端 R1 provider-switch profile 闭环与试用入口。目标是在不新增 agent loop、不引入 remote host 用户路径的前提下，让远端默认 profile 能走 Claude Code cloud / cc-switch / Anthropic-compatible upstream，然后跑一次 provider-backed one-cycle，证明用户可以开始远端只读代码巡检。

预计：0.5-1 天。需要用户协助的唯一条件：如果远端系统没有任何可用 provider key/baseUrl/profile，必须由用户提供或确认已有的 provider 配置来源；除此之外不应要求 SSH、remote host、image 或 Anthropic 原生 profile。
