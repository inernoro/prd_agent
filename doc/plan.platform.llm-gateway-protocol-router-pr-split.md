# LLM Gateway 协议路由 PR 拆分 · 计划

> **版本**：v1.0 | **日期**：2026-07-10 | **状态**：规划中

## 背景

当前 `codex/llmgw-prod-release-tree-readiness` 分支已经承载 LLM Gateway 协议路由目标的多个阶段：多协议入口、GW Request IR、appCaller 注册表、GW 模型池权威、控制台观测、runtime gates、生产发布脚本和回滚脚本。

这些内容都与目标主线相关，但已经不适合整体作为一个 PR 进入审查。当前分支只能作为 staging 工作树，后续必须拆成可验证、可回滚、可汇报的独立合并单元。

## 当前规模

| 合并单元 | 文件数 | 行数变化 | 风险判断 |
|---|---:|---:|---|
| A 文档与目标架构 | 8 | +1695 / -10 | 风险最低，可先合 |
| B API 协议路由核心 | 18 | +9484 / -465 | 主线核心，需单独审 |
| C GW 控制台与配置权威 | 19 | +8181 / -134 | UI/API 体量大，需单独审 |
| D 发布 gate 与运维脚本 | 15 | +2662 / -40 | 涉及生产，必须单独审 |

## 拆分原则

1. 不再继续向 staging 分支追加新能力，除非是为了让现有拆分单元可编译、可测试、可回滚。
2. 每个 PR 只证明一个阶段目标，不用后续阶段的运行态证据包装当前阶段已完成。
3. 生产 `http-full` 不随任何代码 PR 自动开启。生产切换仍由 rollout ledger、runtime gates、备份和回滚演练共同 gate。
4. `/gw/v1/resolve` route matrix 只证明路由解析，不计入真实 LLM 请求日志、`appcaller_runtime_coverage`、`current_commit_http_transport` 或参数丢弃运行态 gate。
5. 不删除 inproc/legacy，直到 full-http 稳定窗口结束并有单独清理 PR。

## PR-A：文档与目标架构

目标：先把目标架构、边界、拆分和剩余 gate 写清楚，让后续实现 PR 有共同 SSOT。

文件范围：

| 文件 | 处理 |
|---|---|
| `doc/plan.platform.llm-gateway-protocol-router.md` | 保留 |
| `doc/plan.platform.llm-gateway-protocol-router-pr-split.md` | 保留 |
| `doc/plan.llm-gateway.full-cutover.md` | 仅保留与协议路由、route matrix 边界、发布 gate 有关的文档更新 |
| `doc/debt.llm-gateway.md` | 保留已知边界和暂缓项 |
| `doc/index.yml` | 保留索引同步 |
| `doc/guide.list.directory.md` | 保留目录同步 |
| `assets/prototypes/llmgw-architecture-drawing-brief.md` | 暂缓进入 PR，除非明确作为目标架构说明材料 |
| `assets/prototypes/llmgw-architecture-map.html` | 暂缓进入 PR，避免文档 PR 带入未验收视觉原型 |
| `changelogs/2026-07-09_llmgw-protocol-router.md` | 拆成与 PR-A 对应的精简 changelog，后续 PR 各自补片段 |

验证：

| 检查 | 命令或证据 |
|---|---|
| 文档命名 | 文件符合 `doc/rule.doc.naming.md` |
| 索引同步 | `doc/index.yml` 和 `doc/guide.list.directory.md` 均有条目 |
| 目标不冲突 | `plan.platform.llm-gateway-protocol-router` 负责目标协议路由，`plan.llm-gateway.full-cutover` 负责生产切换 gate |

回滚：

删除 PR-A 新增文档和索引条目即可，不影响代码和生产。

## PR-B：API 协议路由核心

目标：把 GW Native、OpenAI-compatible、Claude-compatible、Gemini-compatible 统一进入 GW Request IR，保证 appCaller 被动注册、路由策略、参数策略和日志字段可追踪。

文件范围：

| 文件 | 处理 |
|---|---|
| `prd-api/src/PrdAgent.Infrastructure/LlmGateway/GatewayRequest.cs` | 保留 IR 字段：ingress/source/appCaller/modelPolicy/modelPoolId/pinned/parameterPolicy |
| `prd-api/src/PrdAgent.Infrastructure/LlmGateway/GatewayResponse.cs` | 保留响应和 router trace 所需字段 |
| `prd-api/src/PrdAgent.Infrastructure/LlmGateway/IModelResolver.cs` | 保留 GW-owned 模型池解析契约 |
| `prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs` | 保留 GW registry 优先和 MAP fallback 退场门 |
| `prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs` | 拆审：只保留协议路由、精确模型、参数策略、provider attempts 与日志链路相关改动 |
| `prd-api/src/PrdAgent.LlmGateway/GatewayHttpEndpoints.cs` | 拆审：只保留四类协议入口、IR 转换、governance、route matrix 和兼容响应 |
| `prd-api/src/PrdAgent.Infrastructure/LlmGateway/Transformers/GeminiNativeTransformer.cs` | 保留 Gemini tools/function call 往返转换 |
| `prd-api/src/PrdAgent.Core/Models/LlmRequestLog.cs` | 保留日志字段扩展 |
| `prd-api/src/PrdAgent.Core/Interfaces/ILlmRequestLogWriter.cs` | 保留日志写入契约扩展 |
| `prd-api/src/PrdAgent.Infrastructure/LLM/LlmRequestLogWriter.cs` | 保留字段落库 |
| `prd-api/src/PrdAgent.Infrastructure/LLM/LlmRequestLogBackground.cs` | 保留后台更新字段 |
| `prd-api/src/PrdAgent.Core/Models/AppCallerRegistry.cs` | 保留 appCaller registry 字段 |
| `prd-api/src/PrdAgent.Core/Models/ModelGroup.cs` | 保留模型能力和价格快照字段 |
| `prd-api/tests/PrdAgent.Api.Tests/Gateway/GatewayKeyGateContractTests.cs` | 保留协议入口契约测试 |
| `prd-api/tests/PrdAgent.Api.Tests/Gateway/GeminiNativeTransformerTests.cs` | 保留 Gemini transformer 测试 |
| `prd-api/tests/PrdAgent.Api.Tests/Services/LlmGatewayTests.cs` | 保留 LlmGateway 行为测试 |
| `prd-api/tests/PrdAgent.Tests/ModelResolverTests.cs` | 保留 GW 池解析测试 |
| `prd-api/tests/PrdAgent.Tests/GatewayDataDomainGuardTests.cs` | 只保留 PR-B 相关静态守卫，控制台和发布 gate 守卫移到后续 PR |

验证：

| 检查 | 命令或证据 |
|---|---|
| 后端编译 | `cd prd-api && dotnet build --no-restore` |
| 协议契约 | `dotnet test prd-api/tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --no-restore --filter Gateway` |
| Resolver 行为 | `dotnet test prd-api/tests/PrdAgent.Tests/PrdAgent.Tests.csproj --no-restore --filter ModelResolver` |
| 静态守卫 | `dotnet test prd-api/tests/PrdAgent.Tests/PrdAgent.Tests.csproj --no-restore --filter GatewayDataDomainGuardTests` 的 PR-B 子集 |

回滚：

将 MAP `LlmGateway:Mode` 保持 `inproc` 或切回 `inproc`，协议入口代码可不被生产流量使用。不得删除 legacy/inproc。

## PR-C：GW 控制台与配置权威

目标：让 GW 控制台拥有 appCaller、模型池、平台、模型、Exchange、日志、审计、runtime gate 的观测和治理入口。

文件范围：

| 文件 | 处理 |
|---|---|
| `prd-llmgw/Program.cs` | 必须拆审：配置权威、appCaller、模型池、日志、审计、runtime gates 可按区域拆 commit |
| `prd-llmgw/Models/Dtos.cs` | 保留控制台 DTO |
| `prd-llmgw/Models/LlmRequestLogDoc.cs` | 保留日志文档映射 |
| `prd-llmgw/Mongo/BsonValueHelpers.cs` | 保留 Bson helper |
| `prd-llmgw/Security/GwApiKeyCrypto.cs` | 保留 GW-owned key 加密健康与轮换支撑 |
| `prd-llmgw-web/src/App.tsx` | 保留新页面路由 |
| `prd-llmgw-web/src/components/ConsoleLayout.tsx` | 保留导航 |
| `prd-llmgw-web/src/components/LogsView.tsx` | 保留日志筛选和入口上下文 |
| `prd-llmgw-web/src/components/GenerationDetailsDrawer.tsx` | 保留 router trace、attempts、成本和参数展示 |
| `prd-llmgw-web/src/lib/api.ts` | 保留控制台 API client |
| `prd-llmgw-web/src/lib/types.ts` | 保留类型 |
| `prd-llmgw-web/src/lib/logsHelpers.ts` | 保留展示 helper |
| `prd-llmgw-web/src/pages/AppCallersPage.tsx` | 保留 appCaller governance |
| `prd-llmgw-web/src/pages/ModelPoolsPage.tsx` | 必须拆审：GW-owned 池、成员、能力、价格和批量导入 |
| `prd-llmgw-web/src/pages/ModelsPage.tsx` | 保留模型能力维护 |
| `prd-llmgw-web/src/pages/PlatformsPage.tsx` | 保留平台密钥治理 |
| `prd-llmgw-web/src/pages/ExchangesPage.tsx` | 保留 Exchange 观测和密钥治理 |
| `prd-llmgw-web/src/pages/AuditsPage.tsx` | 保留操作审计 |
| `prd-llmgw-web/src/pages/OverviewPage.tsx` | 保留 runtime gate 和配置权威状态卡 |

验证：

| 检查 | 命令或证据 |
|---|---|
| 控制台后端编译 | `dotnet build prd-llmgw/prd-llmgw.csproj --no-restore` |
| 控制台前端构建 | `cd prd-llmgw-web && pnpm build` |
| API 静态守卫 | `GatewayDataDomainGuardTests` 的 PR-C 子集 |
| 页面验收 | `/logs`、`/app-callers`、`/model-pools`、`/models`、`/platforms`、`/exchanges`、`/audits`、`/` |

回滚：

控制台写入仅限 `llm_gateway` 自有集合或显式 claim 动作。若出问题，停用控制台入口或回滚控制台容器，不回滚 MAP 业务数据库。

## PR-D：发布 gate、备份和回滚脚本

目标：让生产 full-http 发布可被脚本 gate，而不是靠口头确认。该 PR 不应改变默认生产模式。

文件范围：

| 文件 | 处理 |
|---|---|
| `.github/workflows/llmgw-prod-stage.yml` | 保留生产 stage workflow，但需单独审查 runner、环境和 secrets |
| `exec_dep.sh` | 保留 http/canary/shadow sample gate，必须确认默认不切 full-http |
| `scripts/llmgw-prod-stage.sh` | 保留生产阶段 runner、备份、config-authority、rollout ledger |
| `scripts/llmgw-prod-external-backup.sh` | 保留外部备份 |
| `scripts/llmgw-config-authority-apply.py` | 保留配置权威执行脚本，默认只读 |
| `scripts/llmgw-config-authority-backup.sh` | 保留备份先行 |
| `scripts/llmgw-readiness-audit.py` | 保留发布前 readiness 聚合 |
| `scripts/llmgw-release-gate.py` | 保留 runtime gate 检查和 self-test |
| `scripts/llmgw-rollout-ledger.py` | 保留 rollout ledger 审计 |
| `scripts/llmgw-rollback-inproc.sh` | 保留回滚到 inproc |
| `scripts/llmgw-restore-shadow-safe.sh` | 保留 shadow 恢复 |
| `scripts/gw-smoke.py` | 只保留当前已验证能力；真实 runtime appCaller 矩阵另开 PR，不混入本 PR |
| `docker-compose.yml` | 仅保留必要 env 透传 |
| `cds-compose.yml` | 仅保留必要 env 透传 |

验证：

| 检查 | 命令或证据 |
|---|---|
| release gate 离线自测 | `python3 scripts/llmgw-release-gate.py --self-test` |
| readiness 离线审计 | `python3 scripts/llmgw-readiness-audit.py --print-json` |
| protocol audit | `python3 scripts/llmgw-protocol-router-audit.py` |
| rollback dry-run | `scripts/llmgw-rollback-inproc.sh` dry-run 证据 |
| 备份先行 | `llmgw-config-authority-backup.sh` 在 apply 前执行的静态守卫 |

回滚：

一条明确回滚路径：将 `LLMGW_MODE` 或 `LlmGateway__Mode` 改回 `inproc` 并重启 API。回滚不删除 `llm_gateway` 数据库，不回滚 MAP 业务集合。

## 暂缓项

| 项目 | 暂缓原因 | 后续进入 |
|---|---|---|
| `gw-smoke` 真实 appCaller runtime 矩阵 | 容易造成过量真实请求，需要先设计默认关闭、上限和成本提示 | PR-D 后续小 PR |
| video/ASR full canary | 外部平台开通、余额、密钥和模型健康不稳定，不应阻塞低风险文本/图片 PR | 生产 gate 阶段 |
| legacy/inproc 删除 | full-http 稳定窗口未完成 | 稳定 7 天后的清理 PR |
| 架构 HTML 原型 | 视觉材料未验收，容易污染文档 PR | 单独视觉/说明 PR 或删除 |

## 下一步执行清单

| 步骤 | 动作 | 完成标准 |
|---:|---|---|
| 1 | 从 staging 分支切出 PR-A 文档分支 | 只包含文档、索引和精简 changelog |
| 2 | 跑 PR-A 文档校验 | 命名、索引、目录一致 |
| 3 | 从 staging 分支切出 PR-B API 核心分支 | 只包含 API 协议路由和后端测试 |
| 4 | 跑 PR-B 后端验证 | `dotnet build` 和相关测试通过 |
| 5 | 从 staging 分支切出 PR-C 控制台分支 | 只包含 GW console API/web |
| 6 | 跑 PR-C 控制台验证 | `prd-llmgw` build 和 `prd-llmgw-web` build 通过 |
| 7 | 从 staging 分支切出 PR-D 发布 gate 分支 | 只包含 workflow、scripts、compose |
| 8 | 跑 PR-D 发布脚本自测 | release gate、readiness、rollback dry-run 通过 |

## 汇报口径

在四个 PR 都合入之前，不能汇报“LLM Gateway 全量迁移完成”。可汇报的状态是：

| 口径 | 是否允许 |
|---|---|
| 目标架构静态证据通过 | 允许 |
| 协议路由代码已进入审查 | 允许 |
| 控制台配置权威已进入审查 | 允许 |
| 生产 full-http 已完成 | 禁止，除非 runtime gates 全绿且 rollout ledger 有同 commit 证据 |
| legacy 已清理 | 禁止，除非 full-http 稳定窗口结束并有清理 PR |
