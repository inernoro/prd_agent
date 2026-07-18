# LLM 网关旧路径物理退场 · 计划

> **版本**：v2.0 | **日期**：2026-07-17 | **状态**：规划中

## 目标

在生产 `Mode=http`、配置权威和六类协议验收已经稳定的基础上，物理删除 MAP 进程内网关及传统解析兜底，使所有模型调用只经过独立 LLM Gateway。本文只保留尚未完成的退场动作和发布门禁；已落地架构以 `design.llm-gateway-physical-isolation.md` 为准，风险与证据缺口以 `debt.llm-gateway.md` 为准。

## 当前事实

- 生产执行迁移已经完成：`Mode=http`，active MAP fallback 已关闭，直连棘轮 baseline 为 0，配置权威为 ready。
- MAP 业务日志仍归 MAP；Gateway 账号、审计、请求日志和 shadow 证据归 `llm_gateway` 数据域。
- 旧 `LlmGateway.cs`、`ShadowLlmGateway.cs` 和 legacy resolver 仍在仓库中，只承担显式回滚保险，不承载正常生产流量。
- GitHub 手动 workflow 只有进入 default branch 后才会出现在 `workflow_dispatch` 入口；生产演练不能引用尚未进入默认分支的工作流。

## 唯一未完成阶段

### S6：删除进程内旧路径

1. 删除 `LlmGateway.cs` 中的进程内网关实现及对应装配。
2. 删除 `ShadowLlmGateway.cs`；shadow 比对继续由独立 Gateway 侧能力承担。
3. 删除 `ModelResolver.FindLegacyModelAsync` 及传统模型配置兜底。
4. 删除只服务于 inproc、shadow 或 legacy resolver 的配置键、测试和兼容分支。
5. 更新架构文档、债务台账、发布脚本与棘轮测试，确保旧路径不能被重新引入。

不满足下列门禁时不得开始删除：

- 同一 release commit 的 HTTP transport、四协议、active caller 和配置权威证据完整。
- 关键 shadow 单元达到约定样本数和覆盖时长，`critical=0`、`httpFail=0`。
- serving 多实例或等价可用性已经验证，健康检查、鉴权和滚动发布证据有效。
- `activeAppCallerMapFallbackReady=true`，`mapFallbackObjectsRemaining=0`，默认池和绑定池均可解析到可用成员。
- 回滚脚本已在目标环境 dry-run，并确认可以通过发布版本回退；删除后不再以运行时开关恢复 inproc。

## 发布与复测矩阵

| 维度 | 必须覆盖 | 通过条件 |
| --- | --- | --- |
| Gateway 健康与安全 | healthz、Gateway key、限流、密钥完整性 | 健康提交匹配；未授权请求拒绝；专用密钥有效 |
| 四协议 | gw-native、openai-compatible、claude-compatible、OpenRouter 原始协议 | send、stream、raw、client-stream 的语义和流式事件保真 |
| 路由 | auto、pool、pinned | 解析到预期池、平台和模型，选择 A 不得执行 B |
| MAP 文本入口 | Report、Desktop、开放平台、ModelLab、Arena | 真实业务入口产生 HTTP 或 shadow 证据 |
| 多模态入口 | 生图、图生图、视觉理解、视频、ASR、字幕 | 真实 raw 入口成功，不以文本或 resolve-only 样本替代 |
| 数据域 | MAP 日志、Gateway 日志、账号与审计 | 两侧各归其数据库，并可通过 requestId、sessionId、appCallerCode 关联 |
| 发布回滚 | readiness、release gate、rollout ledger、回退演练 | 同 commit 证据齐全，失败阻断，回退版本可用 |

## 真实入口覆盖契约

下列标识被自动化守卫读取，修改前必须同步测试和取证脚本：

- `prd-agent-desktop.chat.sendmessage::chat`
- `open-platform-agent.proxy::chat`
- `open-api.proxy::chat`
- `open-api.proxy::generation`
- `prd-agent-web.model-lab.run::chat`
- `prd-agent.arena.battle::chat`
- `report-agent.generate::chat`

补样本必须经过 MAP 真实业务入口。`scripts/llmgw-map-shadow-seed.py` 的文本入口默认保持低成本；按缺口显式启用 `--include-desktop-chat-run`、`--include-open-platform`、`--include-open-api-chat`、`--include-open-api-image`、`--include-model-lab-run`、`--include-arena-run` 或 `--include-report-agent-generate`。图片、视频和 ASR 使用各自 include 参数，不能用文本样本冒充 raw gate。

## 执行顺序

1. 用 `scripts/llmgw-readiness-audit.py` 聚合静态守卫、关键 xUnit、serving probe、CDS runtime 和 shadow coverage。
2. 用 `scripts/llmgw-protocol-router-audit.py` 固化协议、配置权威和发布脚本一致性。
3. 用 `scripts/llmgw-release-gate.py` 校验当前 release commit 的线上证据；禁止降低 gate 代替补样本。
4. 先备份配置权威，再运行 `scripts/llmgw-config-authority-apply.py`；默认 dry-run，执行必须显式传 `--execute`。
5. 分小提交删除旧实现、旧装配和旧配置，每个提交保持编译、测试和静态棘轮通过。
6. 发布后再次执行四协议真机、核心 active caller 和多模态抽样；将证据写入 rollout ledger。
7. 稳定窗口通过后关闭本计划，并把最终架构事实更新到设计文档。

## 完成标准

- 仓库中不再存在可被 DI 或配置启用的 inproc、shadow 或 legacy resolver 路径。
- MAP 没有直接构造上游模型客户端的新增或存量例外。
- 所有 active appCaller 都由 Gateway 权威配置解析，MAP 不保存可执行的模型兜底。
- 自动化测试覆盖四协议、三种路由、多模态 raw、数据域和回滚失败路径。
- 生产验证与当前 commit 一致，失败时依赖版本回退，而不是静默切回进程内实现。

## 关联文档

- `doc/design.llm-gateway-physical-isolation.md`
- `doc/design.platform.llm-gateway.migration-retrospective.md`
- `doc/debt.llm-gateway.md`
- `doc/debt.llm-gateway-isolation.md`
- `llmgw/docs/README.md`
