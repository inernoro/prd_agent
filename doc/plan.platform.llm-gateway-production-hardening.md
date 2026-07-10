# LLM Gateway 生产加固与架构收口 · 计划

> **版本**：v1.1 | **日期**：2026-07-10 | **状态**：开发中
>
> **审计基线**：本文中的生产数字均为 `2026-07-10` 只读快照，不是实时状态。实施任何阶段前必须重新取证。
> **关联文档**：`design.platform.llm-gateway.migration-retrospective.md`（历史复盘）、`plan.platform.llm-gateway-protocol-router.md`（目标协议路由）、`debt.llm-gateway.md`（债务台账）

## 一、管理摘要

LLM Gateway 已完成一项关键切换：生产 AI 请求的默认执行通道运行于独立 `llmgw-serve`，MAP 通过 HTTP 调用 GW，网关外直接创建上游 LLM client 的静态基线为空。这证明执行层迁移有效，但不等于目标架构全部完成。

本计划处理剩余差距：全部正式 appCaller、模型池和路由配置退出 MAP 权威；生产模式、健康检查、预算、数据保留和服务鉴权从“可运行”提升为“可长期治理”。最终目标是 MAP 只拥有业务协议与业务生命周期，GW 独占 AI 请求的协议适配、路由、模型池、平台、密钥、预算和请求日志。

三层结论必须始终分开：

| 层次 | 结论 | 不得夸大的部分 |
|---|---|---|
| 已确认 | 生产 AI 执行通道运行于独立 GW HTTP | 不等于每个调用方的模型池都由 GW 决定 |
| 未完成 | 只有 `active` appCaller 已被生产退场门保护，其他状态仍可能读取 MAP 路由配置 | 不得宣称全部配置权威已经迁移 |
| 目标态 | MAP 只负责业务，GW 负责所有 AI 治理 | 完成前不得把保留的 MAP fallback 当成目标设计 |

当前不建议因本计划立即回滚生产。整改采用先止血、再收口权威、最后提升协议与治理质量的顺序，不在同一发布中同时改路由、数据保留、服务鉴权和协议行为。

## 二、生产事实及影响

### 2.1 审计快照

| 事实 | `2026-07-10` 快照 | 产生的问题 |
|---|---|---|
| 生产发布提交 | `09a21f19611f9f4517ee4f8a73cd69c37fd3e6e1` | 生产运行态需要继续以镜像、health commit 和 rollout ledger 三方一致为准 |
| 最新 `origin/main` | `d17c931bc...`，生产提交是其祖先 | 后续发布必须重新确认 main 增量没有改变 GW 行为，不能直接把生产工作树当版本权威 |
| appCaller 状态 | `active=3`、`configured=15`、`disabled=1` | 只有 active 调用方被明确禁止 MAP fallback，配置权威尚未全量收口 |
| appCaller 重复记录 | `literary-agent.illustration.text2img::generation` 存在两条 configured 记录 | 并发首次登记可能产生重复；读取第一条记录时路由可能不确定 |
| full-http 发布门 | 最终证据把 `minCoverageHours/minPerApp/minTotal` 设为 `0`；全局 shadow 仅 5 条，覆盖约 `0.038h` | 证明维护窗口内可运行，不构成原计划的长期稳定性证明 |
| 切换后真实请求 | `report-agent.generate::chat` 至少 35 条 HTTP succeeded；未发现超过 5 分钟的 running | 文本执行链有真实成功证据，但该 caller 为 configured，模型池权威仍可能来自 MAP |
| 多模态切换后覆盖 | 本次快照未看到同一切换窗口内足够的 vision、图片、视频、ASR 真实业务样本 | 不能用短文本成功替代多模态长期兼容结论 |
| GW 数据集合 | 请求日志约 1800 条、shadow 约 3428 条，相关集合基本只有 `_id` 索引 | summary、预算和筛选会随数据量增长退化为集合扫描 |
| 生产磁盘 | 根盘约 70 GB，已用约 63 GB，使用率约 90%；`/root/backups` 约 40 GB | 下一次备份、镜像拉取或数据库增长可能触发磁盘故障 |
| serving 部署 | 单个 `llmgw-serve` 实例；health 只返回进程、commit 和时间 | 单实例故障会影响全部 AI 请求；health 200 不代表数据库、密钥和模型池可用 |

### 2.2 事实边界

- 上表是审计快照。实施阶段必须重新执行只读数据库、磁盘、容器、health 和日志查询，并把新时间写入证据。
- 生产历史上曾通过图片、视频和 ASR 的受控 canary；这能证明当时的具体上游路径可用，不能证明上游余额、开通状态和协议今天仍然有效。
- `transport=http` 证明执行经过 GW，不证明 router 最终没有读取 MAP 模型池。
- release gate `pass` 证明当次配置的门已通过；当门槛被显式降为零时，不得把它解释成长期样本门已经满足。

## 三、隐性风险矩阵

| ID | 级别 | 维度 | 风险 | 隐性结果 | 关闭条件 |
|---|---|---|---|---|---|
| R01 | P0 | 运维可用性 | 生产磁盘 90%，备份约 40 GB | 备份、Mongo 写入、镜像拉取或容器启动突然失败 | 备份完整性确认、保留策略落地、磁盘低于 75% 且有 80%/90% 告警 |
| R02 | P0 | 正确性 | configured/discovered appCaller 仍可能读取 MAP 路由配置 | 日志显示 HTTP，但模型池仍由 MAP 决定，形成“迁移完成”假象 | 所有真实调用方只读取 GW-owned 池，MAP 路由读取有静态和运行时门禁 |
| R03 | P0 | 运维可用性 | 缺少 `LLMGW_MODE` 时默认 `inproc` | 后续漏配环境变量会静默退回旧执行架构 | 生产缺少显式 `http` 时拒绝启动，回滚必须使用独立破玻璃开关 |
| R04 | P1 | 正确性 | appCaller 缺少复合唯一索引 | 并发登记产生重复，状态或池绑定发生不确定读取 | 清理重复数据并建立 `(AppCallerCode, RequestType)` 唯一索引 |
| R05 | P1 | 正确性 | GW 路由读取 GW 池，但成功/失败健康度仍可能写 MAP `model_groups` | 坏节点健康状态不更新，重复首选、增加延迟和费用 | GW-owned 池的健康读写均落 `llm_gateway`，合同测试证明数据库一致 |
| R06 | P1 | 安全合规 | 月预算依赖日志估算、无原子预占；成本证据缺失时放行 | 并发越过预算或账单与网关估算不一致 | 原子预算预占、结算和释放闭环，缺成本策略可配置 fail-closed |
| R07 | P1 | 用户体验 | 客户端断开后上游请求继续 | 用户以为取消，但后台继续生成并计费 | 提供显式 cancel 语义；可取消能力传播 CancellationToken，不可取消任务显示费用提示 |
| R08 | P1 | 安全合规 | multipart 对象 rehydrate 后未发现清理生命周期 | 原始图片、音频长期残留，带来成本和隐私风险 | 成功、失败、超时均有清理策略，另有兜底生命周期任务和保留审计 |
| R09 | P1 | 性能容量 | GW 日志、shadow、审计缺少查询索引且无限保留 | 查询与预算统计持续变慢，数据库空间不可控 | 建立查询索引、分层保留与归档策略，敏感正文有独立保留期 |
| R10 | P1 | 运维可用性 | health 浅、serving 单实例 | health 200 时真实请求仍可能全失败；单点故障无冗余 | readiness 覆盖 Mongo、对象存储、key integrity 和路由，至少两实例并验证摘流 |
| R11 | P1 | 安全合规 | 服务间使用共享 Gateway Key，appCallerCode 可由调用方声明 | 外部系统可能冒用其他 caller 的池、预算或权限 | 每个接入方独立 key，key 与允许的 source/appCaller/scope 绑定 |
| R12 | P2 | 兼容性 | 默认 `default-drop` 丢弃不支持参数 | 请求返回 200，但调用者要求的参数没有生效 | 控制台和响应元数据可见 dropped 参数；关键调用默认 strict |
| R13 | P2 | 正确性 | 流式客户端反序列化失败时跳过 chunk | 文本、thinking 或 tool arguments 不完整但整体不报错 | chunk 解析失败转显式错误或可恢复事件，并有跨 chunk 合同测试 |
| R14 | P2 | 正确性 | 图片、视频等非幂等提交遇到超时后重试 | 上游已受理但本地未知时重复生成、重复计费 | requestId/idempotency key、提交状态查询和 unknown-outcome 状态闭环 |
| R15 | P2 | 兼容性 | 协议 canary 只测短文本 | 4/4 通过被误解为 tools、stream、vision、图片、ASR 全兼容 | 建立按协议和能力分层的受控矩阵，昂贵能力有硬调用上限 |

六个风险维度均不得遗漏：正确性、兼容性、性能容量、安全合规、运维可用性、用户体验。每次更新计划时，新增风险必须归入其中一个维度并给出关闭条件。

## 四、最重要的架构修正

### 4.1 当前生产架构

```text
MAP 业务生命周期
  -> ILlmGateway
  -> llmgw-serve HTTP
  -> active appCaller 使用 GW 模型池
  -> configured/discovered appCaller 仍可能读取 MAP 路由配置
  -> provider
```

当前架构完成了执行路径独立化，但路由权威仍按 appCaller 状态分叉。最重要的纠偏不是再次修改 HTTP transport，而是让所有允许承载真实流量的状态都只使用 GW 配置。

### 4.2 目标架构

```text
MAP / 外部系统
  -> GW ingress adapter
  -> GW Request IR
  -> appCaller registry
  -> GW router
  -> GW-owned model pools
  -> provider adapter
  -> upstream
```

| MAP 保留 | GW 独占 |
|---|---|
| 会话、业务 run、画布、素材、报告、工作流和业务状态机 | appCaller registry、模型池、平台、模型、Exchange、上游 key |
| MAP 业务 API 和前端协议 | GW Native、OpenAI、Claude、Gemini ingress adapter 和 Request IR |
| 业务日志 | GW 请求日志、provider attempts、shadow、预算、路由和操作审计 |
| `requestId/sessionId/runId/appCallerCode` 关联上下文 | 同一关联字段的路由与供应商视角 |

### 4.3 appCaller 状态语义

| 状态 | 配置要求 | 是否可接真实流量 | 路由失败行为 |
|---|---|---|---|
| `discovered` | 仅被动登记 | 仅当 requestType 存在已启用的 GW 默认池时可低权限运行 | 无 GW 默认池则拒绝，不读取 MAP |
| `configured` | 绑定 GW-owned 池或明确使用 GW 默认池 | 可 | GW 配置无效时 fail-closed，不读取 MAP |
| `active` | configured 条件 + owner、预算、限流和生产验证 | 可 | 全程 fail-closed，并进入发布 gate |
| `disabled` | 无 | 否 | 拒绝 |
| `archived` | 历史记录只读 | 否 | 拒绝 |

MAP fallback 只允许存在于明确的迁移工具或破玻璃回滚流程，不得成为任何正常状态的长期运行语义。

## 五、整改顺序与 Gate

### Phase 0：P0 运维止血

| 项目 | 内容 |
|---|---|
| 完成定义 | 生成备份清单、校验最近可恢复备份、定义日/周/月保留数量、归档或删除超期备份、配置磁盘告警 |
| 验证 gate | 根盘使用率低于 75%；最近备份有校验和和恢复演练记录；80%/90% 告警可触发 |
| 回滚边界 | 未确认备份完整性前禁止删除；删除只针对已确认超期副本，不修改 Mongo 数据 |
| 当前进度 | 100% |
| 生产证据 | `20260710T101800Z_backup-retention.executed.json`、`20260710T101900Z_disk-monitor-threshold-test.txt`；根盘 43%，备份目录 6.9 GB，两个 timer active/enabled |

### Phase 1：P0 路由权威收口

| 项目 | 内容 |
|---|---|
| 完成定义 | 合并重复 appCaller；建立复合唯一索引；实现状态语义；将全部真实 caller 绑定 GW-owned 池；正常路径禁止 MAP 路由读取 |
| 验证 gate | 重复数为 0；configured/active 均有有效 GW 池；每类 requestType 至少一个真实请求的 routerTrace 标记 GW source；MAP fallback 计数为 0 |
| 回滚边界 | 数据迁移前备份 `llmgw_app_callers` 和路由集合；回滚恢复绑定数据，不切回共享数据库 |
| 当前进度 | 75%：实现、编译、针对性测试和临时 Mongo 迁移演练通过；待生产备份、数据迁移和 routerTrace Gate |

### Phase 2：P1 路由正确性

| 项目 | 内容 |
|---|---|
| 完成定义 | GW 池健康状态读写同库；生产模式必须显式设置；破玻璃回滚与普通启动分离 |
| 验证 gate | 健康成功/失败合同测试断言 `llm_gateway` 更新；删除生产 mode 后启动失败；显式回滚演练可恢复服务 |
| 回滚边界 | 保留版本级 `inproc` 能力，但不允许配置缺失自动触发 |
| 当前进度 | 50%：实现、编译和针对性测试通过；待同 commit 部署、生产启动拒绝和健康写回取证 |

### Phase 3：P1 可用性与数据治理

| 项目 | 内容 |
|---|---|
| 完成定义 | 深度 readiness、serving 冗余、日志索引与保留期、multipart 清理和兜底生命周期任务落地 |
| 验证 gate | 任一依赖失败时 readiness 非 200 且实例被摘流；查询有索引命中证据；过期日志和对象可自动清理 |
| 回滚边界 | 索引可独立回滚；保留期先 dry-run 统计再启用；对象清理先标记后删除 |
| 初始进度 | 0% |

### Phase 4：P1 成本与安全

| 项目 | 内容 |
|---|---|
| 完成定义 | 原子预算、显式取消、非幂等提交保护、接入方独立 key 和 appCaller scope 绑定完成 |
| 验证 gate | 并发预算测试不超额；取消后可取消上游停止；重复 requestId 不重复提交；跨 scope 请求返回 403 |
| 回滚边界 | 新 key 支持短期双 key 轮换；预算故障默认 fail-closed，可通过审计过的破玻璃策略临时放行 |
| 初始进度 | 0% |

### Phase 5：P2 协议验收

| 项目 | 内容 |
|---|---|
| 完成定义 | 覆盖 stream、tools、thinking、vision、图片和 ASR；流式解析错误显式化；dropped 参数可见 |
| 验证 gate | 每个能力有合同测试和一次受控真实验证；视频独立预算，每 provider 默认最多一次；失败后必须先证明条件发生变化才能重试 |
| 回滚边界 | 协议能力按入口或 appCaller 灰度；不因单一高级字段失败回滚整个 GW transport |
| 初始进度 | 0% |

## 六、进度追踪规则

进度只能由可核对 gate 推动，禁止按运行时长、提交数量或主观感觉填写。

| 进度 | 判定 |
|---:|---|
| 0% | 未开始，只有问题和验收定义 |
| 25% | 实现与迁移脚本完成，尚未通过本地校验 |
| 50% | 本地构建、单元和合同测试通过 |
| 75% | 预览、dry-run 或非破坏性迁移演练通过 |
| 100% | 生产验证、证据归档和回滚确认全部完成 |

每个持续超过 30 分钟的阶段维护以下表格；超过 2 小时必须记录累计耗时、外部付费调用次数和停止条件。

| Phase | Owner | 状态 | 进度 | 累计耗时 | 付费调用 | 当前证据 | 下一停止条件 |
|---|---|---|---:|---:|---:|---|---|
| Phase 0 | Codex | completed | 100% | 生产执行约 10m | 0 | 释放 18.067 GiB；根盘 43%；备份校验、恢复 dry-run、timer 和阈值测试通过 | 持续由 timer 监控和保留 |
| Phase 1 | Codex | in-progress | 75% | 持续统计 | 0 | serving 开关传播、状态策略、归档去重和唯一索引实现；62 项针对性测试和临时 Mongo 迁移演练通过 | 生产备份后迁移，重复为 0，全部 caller 只读 GW |
| Phase 2 | Codex | in-progress | 50% | 持续统计 | 0 | mode fail-closed、GW 健康写库实现；针对性测试通过 | 同 commit 生产取证通过 |
| Phase 3 | 待认领 | pending | 0% | 0h | 0 | 数据与部署快照 | readiness、索引、保留期 dry-run 通过 |
| Phase 4 | 待认领 | pending | 0% | 0h | 0 | 预算与鉴权审计 | 并发预算、取消和 scope 测试通过 |
| Phase 5 | 待认领 | pending | 0% | 0h | 0 | 最小文本 canary | 受控能力矩阵通过且未超预算 |

连续 3 次同类失败、累计 2 小时无功能净进展或触达付费上限时立即停止，先汇总根因，不继续重复请求。

## 七、测试与验收总门

| 层级 | 必须验证 |
|---|---|
| 静态守卫 | 网关外直连 baseline 为 0；正常 resolver 不引用 MAP 模型池；生产配置缺失不默认 inproc |
| 数据迁移 | 重复合并幂等；唯一索引可建；旧状态和池绑定有迁移报告与回滚备份 |
| 合同测试 | GW 池健康写回、appCaller 状态机、预算并发、key scope、取消、stream chunk、幂等提交 |
| 运行态 | readiness 依赖检查、双实例摘流、日志索引命中、对象清理 dry-run、磁盘告警 |
| 业务回归 | 文本、流式、tools、thinking、vision、图片、ASR；视频仅在独立预算批准后一次性验证 |
| 发布证据 | commit、镜像、health、ledger 一致；每个 gate 保留机器可读结果；回滚命令已演练 |

整改完成的最终判定：生产主要请求持续显示 `transport=http`；所有允许真实流量的 appCaller 使用 GW-owned 路由；MAP 正常路径无模型池读取；预算、鉴权、健康和数据保留门均可执行；不存在以零阈值发布门替代长期稳定性结论的表述。

## 八、实施约束

- 本计划创建时不修改生产配置、不执行数据库迁移、不触发模型请求。
- `inproc` 暂时保留为破玻璃回滚能力，删除必须另立计划，并以 full-http 稳定期和版本级回滚为前置。
- 任何生产数字在实施前重新取证，不直接沿用本文快照。
- 不在文档、证据或日志中记录 API key、密码、JWT、数据库连接串和可复用密钥材料。
- 本计划负责生产加固顺序和 gate；`plan.platform.llm-gateway-protocol-router.md` 继续负责四协议与模型池目标设计；迁移复盘只记录历史事实。
