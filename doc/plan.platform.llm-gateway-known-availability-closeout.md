# LLM Gateway 已知可用性收口 · 计划

> **版本**：v1.0 | **日期**：2026-07-12 | **状态**：开发中

## 1. 目标

本计划只解决“在当前已知生产条件下，LLM Gateway 能稳定维护、独立运行并完成一次可解释验收”。生产已经处于 `full-http`，因此本轮不是再次迁移，也不重新等待七天或二十四小时。

完成标准只有五条：

1. 维护版本不再被首次切流的同 commit shadow 窗口阻塞。
2. 同一最终 commit 只部署一次；失败后先诊断和继续验收，不反复重建容器。
3. `llmgw-serve` 的基础 readiness 与必要运行配置不再依赖 MAP 配置数据库。
4. GW 日志、审计、shadow 和 multipart 对象有明确、可执行的保留策略。
5. 最终生产验收按固定矩阵各执行一次，禁止自动重试和无限采样。

## 2. 当前生产事实

| 事实 | 当前结论 |
|---|---|
| MAP AI 传输模式 | `full-http` |
| API / 控制台 / serving 镜像 | 已钉同一生产 commit |
| serving 拓扑 | `llmgw-serve` 与 `llmgw-serve-b` 均健康 |
| 配置权威 | active appCaller 的 GW 配置权威 gate 已 ready，MAP fallback 对象为 0 |
| 协议入口 | GW Native、OpenAI-compatible、Claude-compatible、Gemini-compatible 已存在 |
| 直连棘轮 | baseline 为 0，MAP 业务代码不允许新增上游 client |
| 剩余问题 | 维护发布语义、MAP 配置域物理依赖、保留策略启用和一次性最终验收 |

## 3. 有限执行清单

| PR | 目标 | 主要改动 | 合并 Gate | 当前状态 |
|---|---|---|---|---|
| PR-A | 发布可靠性 | 首次切流与维护发布分离；历史 full-http 证据可审计继承；新 commit 仍强制镜像一致、HTTP health、四协议、runtime gates；修正 auto/pinned 路由误报和探针 `inproc` 伪日志 | 后端 build、发布脚本合同测试、ledger 自测、CI 与审查全绿 | 已合并 PR #1076 |
| PR-B | 解除 MAP 关键依赖 | 把 serving 必需的资产存储和运行配置迁入 GW-owned 配置域；readiness 不再把 MAP Mongo 当必要依赖 | MAP 配置库不可用时 GW health/readiness 与非 MAP 依赖请求仍可用 | 已合并 PR #1077 |
| PR-C | 生命周期与最终验收 | 启用分层保留与清理；提供一次性验收命令和有限证据清单；只在三 PR 合并后部署最终 commit | 六类请求各最多一次、无自动重试；生产回滚命令和数据备份有效 | 开发中 |

不新增第四个实现 PR。计划文档、测试和 changelog 分别随对应 PR 合并。

### 3.1 发布阻塞修正

三批实现 PR 合并后的首次生产发布发现：PR-A 的 `--maintenance-from-commit` 仍调用通用全迁移 audit，导致历史 `http-full success` 被今天新增的证据字段反向判定失败，维护发布事实上不可执行。允许增加一个仅含发布脚本和合同测试的纠错 PR，不得包含运行代码、模型调用、数据库或 UI 变更。纠错后的维护基线审计只验证：历史 `http-full success`、stage/release-gate 文件存在且 commit/mode/fallback 一致、shadow `critical/httpFail=0`、同 commit 无后续 rollback/failed；新 commit 的 health、协议、配置权威和 runtime gate 仍由维护发布重新验证。

## 4. PR-A 设计

### 4.1 两类发布

- 首次切流：继续要求同 commit shadow、阶段顺序、观察窗口和回滚演练。
- 维护发布：必须显式提供一个已经完成 `http-full` 且之后未发生 rollback/failed 的基线 commit。脚本先审计基线完整证据，再允许新 commit 发布。
- 维护发布只继承 shadow/首次切流证据，不继承新代码运行事实。新 commit 必须重新通过镜像 commit、health、鉴权边界、GW route self-test、D 层 smoke、四协议 canary、配置权威和 runtime gates。
- 视频、ASR、图片等高成本能力不在每次维护发布中重复调用；它们只在 PR-C 的最终矩阵各调用一次。

### 4.2 路由漂移

appCaller 同时出现管理员配置的 `auto` 和合法的单次 `pinned` 请求时，不应因为“最后一条请求覆盖上一条”而报告漂移。GW 保存 observed policy/pool/parameter 集合：配置值只要出现在集合中即视为吻合；旧数据没有集合时继续兼容 `LastObserved*`。

### 4.3 探针日志

发布探针必须显式写入：

- `GatewayTransport=http`
- `SourceSystem=release-probe`
- `IngressProtocol=gw-native`
- `IsHealthProbe=true`

探针可以排除在业务统计之外，但不能伪装成 `inproc` 或真实用户请求。

## 5. PR-B 设计边界

PR-B 只迁移 serving 必需配置，不迁移 MAP 业务数据：

| 归 GW | 仍归 MAP |
|---|---|
| 对象存储访问配置、GW runtime 配置、multipart rehydrate 所需配置、GW readiness | 业务 run、会话、画布、素材生命周期、业务权限 |

验收时主动制造 MAP 配置数据库不可达条件，断言 GW `/gw/v1/healthz`、`/gw/v1/readyz` 和不依赖 MAP 业务数据的协议请求不被阻断。任何仍需 MAP 数据的兼容路径必须明确标记，不能进入基础 readiness。

## 6. PR-C 生命周期

默认保留策略在代码审计后以配置形式固化，目标值如下：

| 数据 | 默认保留 |
|---|---:|
| 请求元数据与 token/耗时/路由结果 | 90 天 |
| request/response/thinking 敏感正文 | 7 天 |
| shadow comparison | 30 天 |
| 登录与操作审计 | 180 天 |
| 成功 multipart 临时对象 | 24 小时 |
| 失败或状态未知 multipart 临时对象 | 72 小时 |

删除前必须先 dry-run 输出数量和最老时间；生产启用后必须有索引状态和最近一次清理结果。不得依赖人工长期运行脚本。
控制台只读接口 `/gw/lifecycle/status` 是上述状态的运维入口；最终付费验收在该接口未返回最近一次 `applied` 且 TTL 索引未全部 ready 时必须 fail-closed。

## 7. 一次性最终验收

只在 PR-A、PR-B、PR-C 全部合并后，对最终 `main` commit 做一次备份、一次生产部署、一次矩阵验收：

| 能力 | 最大上游请求数 | 必须证明 |
|---|---:|---|
| 文本 | 1 | 返回成功，GW 日志 `transport=http` |
| 流式 | 1 | SSE 有内容与 done，GW 日志可关联 |
| 图片 | 1 | 生成结果可读，尺寸与业务请求一致 |
| Vision | 1 | 多模态输入可解析，返回成功 |
| ASR | 1 | multipart hash/rehydrate 正确，返回文本 |
| 视频 | 1 | submit 成功；只轮询已有 task，不重复 submit |

失败处理是“停止、归因、修复”，不是自动重试。只有发生了明确代码或配置变更，才允许人工批准补跑失败的单格；补跑仍不得扩大到全矩阵。

## 8. 发布与回滚

1. PR-A、PR-B 只在 CDS 验证并合并，不分别发布生产。
2. PR-C 合并后从最新 `main` 取得最终 40 位 SHA。
3. 先备份 `llm_gateway`、MAP 关键配置集合、生产 `.env` 和 compose。
4. 用 `fast.sh --commit <sha>` 与 `exec_dep.sh --commit <sha>` 发布同一 commit 的 API、GW 控制台、两份 serving 和 GW web。
5. 若 API 核心 AI 流程异常，将 `LLMGW_MODE` 改回 `inproc` 并只重启 API；数据库不回滚。

## 9. 明确不做

- 不删除 inproc/legacy 代码。
- 不增加第五种协议或新模型池功能。
- 不做多主机高可用改造。
- 不重做控制台视觉设计。
- 不进行周期性 shadow 等待、批量视频测试或自动付费重试。
- 不在三个 PR 之外顺手修复其他模块。

## 10. 最终交付物

- 三个已合并 PR 及 CI/审查结论。
- 最终生产 commit 与一次部署记录。
- 六类能力的有限验收矩阵与对应 requestId。
- 当前生产模式、镜像 commit、runtime gates、日志保留状态和回滚命令。
- 未完成项只允许进入 `debt.llm-gateway.md`，不得继续扩展本计划。
