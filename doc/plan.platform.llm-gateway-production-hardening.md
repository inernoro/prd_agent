# LLM Gateway 生产事实、隐性风险与架构修正 · 计划

> **版本**：v1.9 | **日期**：2026-07-11 | **状态**：已落地
>
> **审计基线**：本文中的生产数字均为 `2026-07-11` 快照，不是实时状态。最终复核确认生产 `api / llmgw / llmgw-serve / llmgw-serve-b / llmgw-web`、health、runtime gate 和 rollout ledger 均为 `bad1b3b296b29a314c1ff94f177b2e8f37bcb82e`。registry 运行时权威修正、无费用治理验收和受控多模态验收均已在生产闭环。
> **关联文档**：`design.platform.llm-gateway.migration-retrospective.md`（历史复盘）、`plan.platform.llm-gateway-protocol-router.md`（目标协议路由）、`debt.llm-gateway.md`（债务台账）

## 一、管理摘要

LLM Gateway 已完成三项关键切换：生产 AI 请求的默认执行通道运行于独立 `llmgw-serve`，MAP 通过 HTTP 调用 GW；全部已治理 appCaller 的正常路由配置由 GW-owned 模型池承接，MAP fallback 计数为 0；动态 appCaller 运行时只受 canonical code 与 GW registry 约束，不再要求先修改 MAP 静态注册表。网关外直接创建上游 LLM client 的静态基线为空。

本计划处理剩余差距：发布编排、深度 readiness、服务冗余、预算、取消、幂等、数据保留、multipart 生命周期和服务鉴权从“可运行”提升为“可长期治理”；再用受控协议矩阵补齐文本之外的真实证据。最终目标是 MAP 只拥有业务协议与业务生命周期，GW 独占 AI 请求的协议适配、路由、模型池、平台、密钥、预算和请求日志。

三层结论必须始终分开：

| 层次 | 结论 | 不得夸大的部分 |
|---|---|---|
| 已确认 | 生产四个 GW 相关镜像运行同一提交；默认执行通道为 HTTP；已注册 appCaller 的配置权威检查为 ready | 不等于所有多模态和外部协议都已做同提交真实验收 |
| 当前边界 | 同提交受控证据覆盖四协议、3 个 active appCaller、图片、Vision 和 ASR；视频按用户要求未在本批次重测 | 不得用一次成功推导长期稳定，也不得把独立数据库解释成完全物理隔离 |
| 目标态 | MAP 只负责业务，GW 负责所有 AI 治理，并具备可执行的高可用、成本、安全和数据生命周期门禁 | 完成前不得把保留的 `inproc` 破玻璃能力或测试通过等同于生产能力全绿 |

当前不建议因本计划立即回滚生产。整改采用先止血、再收口权威、最后提升协议与治理质量的顺序，不在同一发布中同时改路由、数据保留、服务鉴权和协议行为。

当前发布状态必须拆成两句话描述，禁止再用“已发布”覆盖不同阶段：

| 层次 | 当前事实 | 结论 |
|---|---|---|
| 代码与制品 | PR #1070 已合并，`origin/main=bad1b3b296b29a314c1ff94f177b2e8f37bcb82e`；CI、CDS 和四类不可变镜像均成功 | Phase 4 代码与制品完成 |
| 生产发布 | 五个生产容器均运行 `bad1b3b29...`；runtime gate `passed=13 retained=2 blocked=0 waiting=0` | full-http、动态 registry、治理与维护发布门均生效 |
| registry 与治理验收 | 动态 caller 成功注册；预算原子预占、分布式并发、生命周期 dry-run、主备切换、scoped key 和临时数据清理全部 PASS | 新外部 caller 可被动注册，但仍须由管理员配置状态、池、预算和 scope 后再长期承载 |

这一区分直接修正“PR 合并等于正式环境完成”的隐性误判。Phase 3 已满足镜像、正式 stage、深度 readiness、主备摘流和版本一致性检查；Phase 4 仍必须重新走同一条发布链，不能复用 Phase 3 的生产结论。

当前建议顺序只有一条主线，不并行扩大改动面：

| 顺序 | 先做什么 | 为什么排在这里 | 完成后才能做什么 |
|---:|---|---|---|
| 1 | 已合并并发布 registry 权威修正 | PR #1070 与生产 `bad1b3b29...` 已完成 | 外部系统可按 canonical appCallerCode 被动注册 |
| 2 | 已运行一次无费用生产治理验收 | 六项治理行为全部 PASS，临时 caller/key 计数为 0 | 可继续以脚本作为后续维护发布回归门 |
| 3 | 已一次执行 Vision、图片、ASR 各一条真实请求 | `--skip-text-seeds` 批次一次完成，三类日志均为 succeeded | 非视频多模态具备同提交生产证据 |
| 4 | 审批生命周期 apply 策略 | 当前 dry-run 为 0 命中，但开启删除属于数据策略决定，不能随发布自动打开 | 启用敏感正文清理和 multipart 兜底删除 |
| 5 | 视频保持独立预算和单次上限 | 用户已要求避免过量视频测试，且视频当前不是发布阻塞项 | 明确启用后再补，不与普通回归混跑 |

### 1.1 当前可说与不可说

| 问题 | 当前可以确认 | 当前不能确认 |
|---|---|---|
| GW 是否已经承载生产请求 | 是。生产默认模式为 `http`，正常请求经过独立 `llmgw-serve` | 不能据此宣称所有协议和多模态均已验证 |
| 模型池是否已经归 GW | 已注册且可运行 appCaller 的配置权威已归 GW，MAP fallback 为 0 | 新 caller、外部系统和残留迁移工具仍需持续门禁，不能靠约定保证 |
| GW 是否已经完全独立于 MAP | 数据治理边界已拆分，GW 有独立数据库和日志所有权 | 仍依赖 MAP Mongo 中的资产存储配置，不是完全物理隔离 |
| 当前能否继续运行生产 | 可以；Phase 3 full-http、主备和回滚演练已经完成 | Phase 4 上线前不应扩大到无约束外部接入或双活 |
| 是否已经达到“零惊吓” | 已消除直连、配置回退、数据串库、发布单点、主备切换和动态 registry 双权威风险 | 保留期仍未启用；视频未在本批次重测；GW 仍依赖 MAP 资产配置域 |

### 1.2 必须提醒业务所有者的隐性后果

1. 控制台看到 `transport=http` 只能证明请求经过 GW，不能单独证明模型池、预算、密钥和配置权威都归 GW；必须同时看 config-authority、fallback 和路由日志。
2. “两个容器都启动”不等于高可用。当前已经完成停主实例由备用接管的演练；后续每次改 Compose、LB 或 serving URL 都必须重跑，不能永久继承这次结论。
3. “health 200”不等于可生成。Mongo、对象存储、密钥解密或路由不可用时，浅 health 仍可能为 200，必须以深度 readiness 作为摘流和发布依据。
4. “预算已配置”不等于预算结算永久准确。生产已验证并发原子预占只放行一条请求，但真实 provider 成本回填、退款和长期月账仍需持续对账。
5. “浏览器断开”不等于取消。目标语义是只有显式 cancel 才传播取消令牌；普通断开仍让服务端完成落库，避免产生孤儿状态。
6. “请求超时”不等于上游未受理。图片和视频等非幂等提交如果自动重试，可能重复生成和重复扣费，必须引入 unknown-outcome 和幂等状态查询。
7. “数据库分开”不等于依赖完全分开。serving 仍从 MAP 配置域获取资产存储信息，MAP Mongo 故障仍可能影响 GW readiness。
8. “一次真实调用成功”只能证明该时间、该供应商、该模型和该请求形态成功，不能外推余额、权限、流式、多模态和下一次调用仍然成功。

以上事项不是要求业务方逐项人工检查，而是要求实现为发布脚本、运行时 readiness、数据库约束和自动化测试。业务方只需要审批昂贵真实调用预算，以及是否进入下一阶段。

## 二、生产事实及影响

### 2.1 审计快照

| 事实 | `2026-07-10` 快照 | 产生的问题 |
|---|---|---|
| 生产发布提交 | `bad1b3b296b29a314c1ff94f177b2e8f37bcb82e`；五个生产容器、health commit 和 rollout ledger 一致 | 当前版本身份可信；后续发布仍必须重新做三方一致性检查，不能把服务器源码目录当版本权威 |
| registry 权威 | 动态 appCaller 只按 canonical 格式、modelType 后缀和 GW registry 治理，不再要求 MAP 静态常量 | 新 caller 首次出现为 discovered；必须配置治理策略后再作为长期入口 |
| 执行模式 | API 显式配置 `LlmGateway__Mode=http`；已注册调用方的 MAP fallback 开关均为禁用；隔离运行同一生产镜像并移除 Mode 后按预期拒绝启动 | 正常流量不会因漏配静默回到 inproc；破玻璃回滚仍需保持显式、审计和版本级可恢复 |
| appCaller 状态 | `active=3`、`configured=15`、`disabled=1`、`discovered=0`；`autoWithoutPool=0` | 已注册配置权威已收口；新 caller 的首次注册、状态提升和默认池策略仍要长期防止漂移 |
| appCaller 数据约束 | 重复数为 0；已建立大小写不敏感的 `(AppCallerCode, RequestType)` 唯一索引；1 条历史重复已归档并有操作审计 | 当前重复风险已关闭；后续 schema 或 collation 变更必须保留该不变量 |
| 配置权威报告 | `status=ready`、`mapFallbackObjectsRemaining=0`、`activeMissingGatewayPool=0`、`activeBoundPoolWithoutUsableMember=0`、readiness 100% | 已注册 caller 的池、平台和 exchange 可由 GW 解析；这不证明未注册外部系统已完成 scope、预算和权限配置 |
| 同提交受控请求 | 当前提交 19 条，全部 succeeded；18 条 `transport=http`，1 条为内部发布探针；覆盖四入口协议、3 个 active appCaller、图片、Vision 和 ASR | 证明受控业务经过 HTTP；内部探针不能解释成 MAP 业务回退，仍需修正 transport 元数据 |
| 同提交 shadow | 1 条真实 inproc/HTTP 对照，`critical=0`、`httpFail=0` | 只能证明该样本一致，不能替代长期流量覆盖或多模态契约测试 |
| 健康写回 | GW 池 `LastSuccessAt` 在部署后更新，MAP 池时间停留在部署前 | 证明本次探活写入 GW 库而非 MAP；仍需失败写回、并发写回和长期监控证据 |
| serving health | 主、备实例健康；带 key 的 deep readiness 为 ready；ServingKeyIntegrity 为 OK | 当前主备可靠性已演练，但每次拓扑或密钥变更后仍需重跑，浅 health 不替代 deep readiness |
| serving 故障转移 | 停止主 serving 后，经 gateway 的 health 和 readyz 仍由备用实例返回 200；主实例恢复后双实例健康 | Phase 3 单点风险已关闭；Phase 4 原子预算和分布式并发门上线前仍不启用无约束双活 |
| 发布编排 | `http-full` stage 成功，runtime gate `passed=13 retained=2 blocked=0 waiting=0`；维护提交可从成功发布历史保留干净 shadow 证据，同提交四协议为 4/4 | 发布链已能输出机器可读证据；后续不得跳过 stage 或手工拼接完成结论 |
| 生产治理验收 | 预算原子预占、provider 并发、生命周期 dry-run、主备 failover、scoped key 和临时数据清理全部 PASS | 治理行为已验证；长期保留策略仍需独立审批后 apply |
| 临时验收清理 | `llmgw-acceptance*` caller 和临时 key 计数均为 0 | 无费用验收未留下生产配置垃圾 |
| provider audit | 已区分已绑定生产池 blocker 与未绑定 deferred，正式 stage 只由前者阻断并保留全量报告 | 该历史假阻塞已关闭；新增 provider 类型时仍需验证分类规则不漂移 |
| 生产磁盘与备份 | 根盘使用率 45%；新全量备份有 SHA256 和 `mongorestore --dryRun` 证据；保留和磁盘监控 timer 已启用 | 原 90% 紧急风险已关闭；timer、阈值告警和恢复演练仍需作为持续运维能力而非一次性动作 |
| 付费验证边界 | 最终批次只执行图片、Vision、ASR 各一次；视频为 0；协议 canary 每批最多 4 条低 token 请求 | 成本受控；后续昂贵能力仍必须有调用上限和停止条件 |

### 2.2 事实边界

- 上表是 `2026-07-11`、提交 `bad1b3b296...` 的审计快照。后续维护发布必须重新执行只读数据库、磁盘、容器、health 和日志查询，并把新时间写入证据。
- 生产历史上曾通过图片、视频和 ASR 的受控 canary；这能证明当时的具体上游路径可用，不能证明上游余额、开通状态和协议今天仍然有效。
- `transport=http` 证明执行经过 GW；本次另有 config-authority 100% 和 fallback 0 证明已注册 caller 的配置权威收口。两类证据必须同时存在，不能只看 transport。
- release gate `pass` 证明当次配置的门已通过；当门槛被显式降为零时，不得把它解释成长期样本门已经满足。

## 三、隐性风险矩阵

| ID | 级别 | 状态 | 维度 | 风险 | 隐性结果 | 关闭条件 |
|---|---|---|---|---|---|---|
| R01 | P0 | 已关闭 | 运维可用性 | 生产磁盘曾达 90%，备份约 40 GB | 备份、Mongo 写入、镜像拉取或容器启动突然失败 | 已降至 45%，保留、告警 timer、校验和及恢复 dry-run 已落地；持续监控不得撤销 |
| R02 | P0 | 已关闭 | 正确性 | configured/discovered appCaller 曾可能读取 MAP 路由配置 | 日志显示 HTTP，但模型池仍由 MAP 决定，形成“迁移完成”假象 | config-authority ready、fallback 0、所有可运行 caller 有 GW 池；静态和运行时门禁持续生效 |
| R03 | P0 | 已关闭 | 运维可用性 | 缺少 `LLMGW_MODE` 时历史行为会默认 `inproc` | 后续漏配环境变量会静默退回旧执行架构 | fail-closed 代码和单测已部署；同一生产镜像隔离运行时移除 Mode，按预期拒绝启动 |
| R04 | P1 | 已关闭 | 正确性 | appCaller 缺少复合唯一索引 | 并发登记产生重复，状态或池绑定发生不确定读取 | 重复归档、审计和大小写不敏感复合唯一索引已在生产验证 |
| R05 | P1 | 已关闭 | 正确性 | GW 路由读取 GW 池，但成功/失败健康度仍可能写 MAP `model_groups` | 坏节点健康状态不更新，重复首选、增加延迟和费用 | 合同测试通过，生产快照显示 GW 时间更新而 MAP 停留在部署前；后续保持监控 |
| R06 | P1 | 已缓解 | 安全合规 | 月预算依赖日志估算、无原子预占；成本证据缺失时放行 | 并发越过预算或账单与网关估算不一致 | 生产假上游竞争已证明原子预占；真实 provider 成本回填、退款和月账对账仍需长期观测 |
| R07 | P1 | 代码已关闭，待生产 | 用户体验 | 客户端断开后上游请求继续 | 用户以为取消，但后台继续生成并计费 | 已提供显式 cancel；普通断开不取消，显式取消传播 CancellationToken；生产验收后关闭 |
| R08 | P1 | 代码已关闭，待生产 | 安全合规 | multipart 对象 rehydrate 后未发现清理生命周期 | 原始图片、音频长期残留，带来成本和隐私风险 | 已实现请求 finally 清理、manifest 状态和生命周期兜底；先 dry-run 后启用 |
| R09 | P1 | 代码已关闭，待启用 | 性能容量 | GW 日志、shadow、审计缺少完整查询索引且无限保留 | 查询与预算统计持续变慢，数据库空间不可控 | 查询索引和分层保留已实现；TTL 与敏感正文清理默认关闭，生产 dry-run 后启用 |
| R10 | P1 | 已关闭 | 运维可用性 | health 浅、serving 单实例、recreate 后立即探测 | health 200 时真实请求仍可能全失败；单点故障无冗余；发布产生瞬时 502 假失败 | 深度 readiness、等待门、主备和生产停主接管演练均通过 |
| R11 | P1 | 代码已关闭，待换发 | 安全合规 | 服务间使用共享 Gateway Key，appCallerCode 可由调用方声明 | 外部系统可能冒用其他 caller 的池、预算或权限 | scoped key、控制台页面、source/appCaller/protocol/scope 403 和审计已实现；MAP 共享 key 暂作迁移兼容 |
| R12 | P2 | 未关闭 | 兼容性 | 默认 `default-drop` 丢弃不支持参数 | 请求返回 200，但调用者要求的参数没有生效 | 控制台和响应元数据可见 dropped 参数；关键调用默认 strict |
| R13 | P2 | 未关闭 | 正确性 | 流式客户端反序列化失败时跳过 chunk | 文本、thinking 或 tool arguments 不完整但整体不报错 | chunk 解析失败转显式错误或可恢复事件，并有跨 chunk 合同测试 |
| R14 | P2 | 代码已关闭，待生产 | 正确性 | 图片、视频等非幂等提交遇到超时后重试 | 上游已受理但本地未知时重复生成、重复计费 | raw requestId 指纹、running/completed/replay/unknown/conflict 状态机已实现；生产重复提交验证后关闭 |
| R15 | P2 | 未关闭 | 兼容性 | 协议 canary 只测短文本 | 4/4 通过被误解为 tools、stream、vision、图片、ASR 全兼容 | 建立按协议和能力分层的受控矩阵，昂贵能力有硬调用上限 |
| R16 | P1 | 已关闭 | 运维可用性 | 发布脚本从工作树目录隐式推导 Compose 项目名 | release worktree 名变化后审计连接到错误项目，造成假失败或误操作目标 | 显式 Compose project 和 tree precheck 已通过正式发布验证 |
| R17 | P1 | 已关闭 | 正确性 | provider audit 把未绑定池与生产承载池同级阻断 | 不影响当前流量的外部余额或开通状态阻塞整个发布，迫使人工派生证据 | bound blocker 与 deferred 已区分，正式 stage gate 通过 |
| R18 | P1 | 已缓解 | 正确性 | 同提交受控证据曾以短文本为主，缺少多模态真测 | 新 caller、多模态或低频路径可能在用户首次使用时才暴露问题 | Vision、图片、ASR 已各一次受控真测；视频继续单列预算并由用户启用后再测 |
| R19 | P1 | 已关闭 | 运维可用性 | 生产 serving URL 由旧 `.env` 固定到单实例 | 新主备部署看似存在，实际 API 仍绕过 gateway upstream，主实例退出即全量失败 | 生产经 gateway upstream，停主后备用实例接管验证通过 |
| R20 | P1 | 已关闭 | 运维可用性 | 深度 readiness 曾依赖未配置的稳定对象存储 probe key | 发布后两个 serving 持续不就绪，gateway 返回 502/503 | 深度 readiness 和 key integrity 在正式 stage 中持续为 ready |
| R21 | P1 | 已关闭 | 安全合规 | 月预算非原子，双 serving 同时承载流量会扩大并发超额窗口 | 两实例各自通过检查后同时消费，实际费用突破 appCaller 预算 | 生产无费用竞争验收证明两并发请求仅一条到达假上游，另一条被预算 429 拒绝 |
| R22 | P1 | 未关闭 | 架构边界 | serving readiness 仍检查 MAP Mongo，资产存储配置仍来自 MAP AppSettings | 独立 `llm_gateway` 数据库被误解为完全物理独立；MAP 配置或 Mongo 故障仍可能阻断 GW | 把 GW 所需资产存储配置迁入 GW-owned 配置域；MAP Mongo 从 serving 必要依赖和 readiness 中退出 |
| R23 | P2 | 已关闭 | 性能容量 | 平台 `MaxConcurrency` 目前没有形成跨实例原子并发门 | 上游并发限制可能被多个 serving 同时突破，触发限流、熔断和费用抖动 | 生产无费用并发验收仅放行一条请求，另一条 429；结束后验收租约为 0 |
| R24 | P1 | 已缓解 | 运维可用性 | 不可变大镜像拉取仍使用固定 30 秒超时 | 网络稍慢即在真正部署前反复失败，形成“运行很久但生产没有变化”的假进度 | 本次通过长时限完成不可变镜像发布；通用脚本仍应把下载阶段与超时做成显式参数 |
| R25 | P2 | 已关闭 | 运维可用性 | 深度 `/readyz` 受服务 key 保护，公网无 key 返回 401 | 操作者可能把安全拒绝误判为实例不健康，或为了方便而错误开放 readiness | 公网 `/healthz` 200、受保护接口无 key 401、stage 带 key readiness 均已生产验证 |
| R26 | P1 | 已关闭 | 架构边界 | serving 已把新 appCaller 写入 GW registry，但 `LlmGateway.TryValidateAppCaller` 仍要求命中 MAP 静态注册表 | 外部系统或新 MAP 功能完成被动注册后仍返回 `APP_CALLER_INVALID`，形成“数据归 GW、准入仍归 MAP”的双权威 | 运行时只校验 canonical code 和 modelType 后缀；生产动态 caller、预算、并发和 scoped key 验收通过 |
| R27 | P2 | 未关闭 | 可观测性 | 当前提交有 1 条发布探针日志标为 `inproc` 且 source/ingress 为空 | 操作者可能把内部探针误判为 MAP 业务回退，造成错误回滚判断 | 发布探针统一写 `sourceSystem=release-probe`、`ingressProtocol=gw-native`、`transport=http`，控制台可单独过滤 |
| R28 | P2 | 未关闭 | 正确性 | appCaller 只保存一个 `LastObservedModelPolicy`；同一 caller 合法混用 auto 与 pinned 时会被后一次请求改写并触发策略漂移 | 发布 preflight 或一次 pinned 验收可让 runtime gate 在下一次请求后反复变红 | 改为按 route mode 累计观测，或只对禁止策略判漂移；不要用单一 last value 代表合法混合流量 |
| R29 | P2 | 未关闭 | 运维可用性 | 维护发布默认要求新 commit 自身拥有 24 小时 shadow，已经 full-http 的小版本无法天然产生该证据 | 同镜像反复重建、重复 smoke/canary，增加维护时间和上游费用 | 将首次切流 gate 与 full-http 维护发布 gate 分开；维护发布继承最近成功 shadow，并强制同 commit HTTP、四协议、active caller、配置权威和回滚证据 |

六个风险维度均不得遗漏：正确性、兼容性、性能容量、安全合规、运维可用性、用户体验。每次更新计划时，新增风险必须归入其中一个维度并给出关闭条件。

## 四、最重要的架构修正

最重要的修正不是再增加一层 HTTP，也不是把 MAP 模型池复制到新数据库，而是建立唯一配置权威：MAP 只表达业务意图和关联上下文，GW 独立决定协议归一、appCaller 身份、模型池、路由、供应商、预算、密钥和请求审计。任何正常路径只允许读取一份 GW-owned 配置；MAP fallback 只能作为有审计的破玻璃回滚，不能成为长期兼容分支。

架构修正按重要性排序如下：

| 优先级 | 修正 | 解决的根问题 | 机器约束 |
|---:|---|---|---|
| A | 单一配置权威与 fail-closed | 防止“经过 GW 但仍由 MAP 决策”的伪迁移 | GW 外直连 baseline 0；MAP fallback 0；无有效 GW 池即拒绝 |
| B | 深度 readiness、显式发布身份和主备 | 防止浅 health、错误 Compose project、单实例和冷启动时序造成生产中断 | 五组件 readiness；固定 project name；API 只经 gateway；停主不断流 |
| C | 原子预算、scoped key、取消与幂等 | 防止外部接入后越权、超额、后台计费和重复生成 | 原子 reserve/settle/release；key scope；cancel；requestId 状态机 |
| D | 数据生命周期与物理依赖解耦 | 防止日志无限增长、multipart 敏感对象残留和 MAP 故障连带 GW | TTL/归档；对象清理；GW-owned 存储配置；移除 MAP Mongo 必要依赖 |
| E | 四协议与多模态受控证据 | 防止用短文本成功外推全部能力 | 合同测试先行；每种昂贵能力有调用上限和停止条件 |

### 4.1 当前生产架构

```text
MAP 业务生命周期
  -> ILlmGateway
  -> llmgw-serve HTTP
  -> appCaller registry
  -> configured/active appCaller 使用 GW-owned 模型池
  -> provider adapter
  -> provider
```

当前架构已完成执行路径独立化和已注册配置权威收口。最重要的后续纠偏不再是再次修改 HTTP transport，而是把“单实例可运行”升级为“依赖可判定、实例可摘流、发布可重复、成本可预占、请求可取消、非幂等调用可追踪”的治理闭环。

这里的“独立”必须分两层理解：请求日志、appCaller、模型池、平台、exchange 和 key 已归 `llm_gateway`；但 serving 仍读取 MAP AppSettings，并依赖 MAP Mongo 提供资产存储配置。当前是数据治理独立，不是依赖层完全物理独立。物理隔离只有在 GW 所需配置迁入 GW-owned 配置域、MAP Mongo 从 serving 必要依赖中退出后才成立。

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

### 4.4 四条不可混淆的边界

| 边界 | 正确归属 | 禁止做法 |
|---|---|---|
| 业务生命周期 | MAP 创建 run、会话、画布、素材和业务状态，并把关联 ID 传给 GW | 把业务 run 或前端协议搬进 GW |
| AI 调度生命周期 | GW 完成 appCaller 识别、协议归一、池路由、provider 尝试、预算、日志和审计 | MAP 根据 provider/model 自己选择上游后再通知 GW |
| 配置权威 | GW 数据库保存 appCaller、池、平台、exchange、key 和路由策略 | MAP 与 GW 各维护一份长期可写配置并依赖人工同步 |
| 日志所有权 | MAP 写业务日志，GW 写模型请求与 provider attempt；用关联 ID 联查 | 把 GW 请求日志继续写回 MAP 集合，或让 MAP 日志替代网关审计 |

## 五、建议顺序与 Gate

顺序遵循四个原则：先避免发布和单点故障，再治理数据与付费风险，最后做昂贵协议验收；先补机器可执行 Gate，再增加真实调用；任何阶段失败只回滚本阶段，不同时重构相邻层；已关闭的配置权威风险不反复迁移。

### Phase 0：P0 运维止血

| 项目 | 内容 |
|---|---|
| 完成定义 | 生成备份清单、校验最近可恢复备份、定义日/周/月保留数量、归档或删除超期备份、配置磁盘告警 |
| 验证 gate | 根盘使用率低于 75%；最近备份有校验和和恢复演练记录；80%/90% 告警可触发 |
| 回滚边界 | 未确认备份完整性前禁止删除；删除只针对已确认超期副本，不修改 Mongo 数据 |
| 当前进度 | 100% |
| 生产证据 | 最新加固前备份 `/root/backups/llmgw-prod-before-config-authority-20260710T232327+0800`，包含 prdagent 关键模型集合与完整 `llm_gateway`，哈希校验通过；根盘 45%，两个 timer active/enabled |

### Phase 1：P0 路由权威收口

| 项目 | 内容 |
|---|---|
| 完成定义 | 合并重复 appCaller；建立复合唯一索引；实现状态语义；将全部真实 caller 绑定 GW-owned 池；正常路径禁止 MAP 路由读取 |
| 验证 gate | 重复数为 0；configured/active 均有有效 GW 池；配置权威 readiness 100%；MAP fallback 计数为 0；GW 与 MAP 健康写回不再串库 |
| 回滚边界 | 数据迁移前备份 `llmgw_app_callers` 和路由集合；回滚恢复绑定数据，不切回共享数据库 |
| 当前进度 | 100%：生产重复归档、唯一索引、池绑定、fallback 退场、操作审计与同提交运行态检查均通过 |

### Phase 2：P1 路由正确性

| 项目 | 内容 |
|---|---|
| 完成定义 | GW 池健康状态读写同库；生产模式必须显式设置；破玻璃回滚与普通启动分离 |
| 验证 gate | 健康成功/失败合同测试断言 `llm_gateway` 更新；删除生产 mode 后启动失败；显式回滚演练可恢复服务 |
| 回滚边界 | 保留版本级 `inproc` 能力，但不允许配置缺失自动触发 |
| 当前进度 | 100%：代码、单测、同提交部署、显式 `http`、GW 健康写回，以及同一生产镜像缺 Mode 隔离启动拒绝证据均通过 |

### Phase 3：P1 发布确定性与可用性

| 项目 | 内容 |
|---|---|
| 完成定义 | 固化 Compose project SSOT；发布 recreate 后等待深度 readiness；provider audit 原生区分 bound blocker 与 unbound deferred；serving 至少主备双实例并可摘流；生产旧 env 不得覆盖新拓扑 |
| 验证 gate | release worktree 名变化不改变部署目标；冷启动不再产生首探针 502；缺 probe key 时发布前 fail-fast；任一依赖失败时 readiness 非 200 且实例被摘流；主实例退出不影响请求 |
| 回滚边界 | Phase 4 原子预算完成前只允许主备，不允许双活；主备失败可回单实例，不改变数据库和路由配置 |
| 当前进度 | 100%：生产四类镜像统一为 `92fac961...`；full-http gate 14/14；带 key readiness、同提交协议证据、停主接管和恢复后双实例健康均通过 |

### Phase 4：P1 数据生命周期与成本安全

| 项目 | 内容 |
|---|---|
| 完成定义 | 日志索引与分层保留、multipart 清理、原子预算、显式取消、非幂等提交保护、接入方独立 key 和 appCaller scope 绑定完成 |
| 验证 gate | 查询命中索引；过期日志和对象自动清理；并发预算不超额；取消停止可取消上游；重复 requestId 不重复提交；跨 scope 返回 403 |
| 回滚边界 | 保留期先 dry-run 后启用；对象先标记后删除；新 key 短期双 key 轮换；预算故障默认 fail-closed，破玻璃必须审计 |
| 当前进度 | 75%：索引、生命周期 dry-run、multipart 清理、Decimal128 原子预算、显式取消、raw 幂等、scoped key 页面与 platform/model 分布式并发租约已实现；本地 Mongo 并发和契约测试通过。尚待合并、生产发布、生命周期 dry-run 与 scoped key 换发 |

### Phase 5：P2 协议与多模态验收

| 项目 | 内容 |
|---|---|
| 完成定义 | 覆盖 GW Native、OpenAI、Claude、Gemini 的 stream、tools、thinking、vision、图片和 ASR；流式解析错误显式化；dropped 参数可见 |
| 验证 gate | 每个能力先有合同测试，再做一次受控真实验证；图片、ASR 各有明确预算；视频独立预算，每 provider 默认最多一次；失败后必须先证明条件发生变化才能重试 |
| 回滚边界 | 协议能力按入口或 appCaller 灰度；不因单一高级字段失败回滚整个 GW transport |
| 当前进度 | 25%：四入口短文本和核心合同测试已通过；同提交生产已有四协议 canary。vision、图片、ASR 的同提交单次真测尚未执行；视频按独立预算保留 |

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
| Phase 0 | Codex | completed | 100% | 生产执行约 10m | 0 | 释放 18.067 GiB；根盘 45%；备份校验、恢复 dry-run、timer 和阈值测试通过 | 持续由 timer 监控和保留 |
| Phase 1 | Codex | completed | 100% | 已完成 | 0 | 生产重复 0、唯一索引、readiness 100%、fallback 0、autoWithoutPool 0 | 持续监控新 caller 与 schema 漂移 |
| Phase 2 | Codex | completed | 100% | 已完成 | 0 | mode fail-closed、生产显式 http、GW 健康写回、同提交部署、缺 Mode 隔离启动拒绝均有证据 | 持续防止配置回退 |
| Phase 3 | Codex | completed | 100% | 已完成 | 最新受控请求 8 条 | `92fac961...` 同提交发布；gate 14/14；主备摘流和恢复通过 | 每次拓扑发布重跑同一 gate |
| Phase 4 | Codex | in-progress | 75% | 本轮持续统计 | 0 | 构建通过；Mongo 预算、幂等、scope、并发竞争 5 项通过；网关矩阵 268 项通过；控制台密钥页构建通过 | 合并后发布同一提交，运行生命周期 dry-run、生产竞争与 scoped key 换发 |
| Phase 5 | Codex | in-progress | 25% | 待生产提交 | 0 | 四入口短文本与协议合同已有证据 | vision、图片、ASR 各一次受控真测；视频不批量重试 |

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

整改完成的最终判定：生产主要请求持续显示 `transport=http`；所有允许真实流量的 appCaller 使用 GW-owned 路由；MAP 正常路径无模型池读取；发布、预算、鉴权、健康、幂等和数据保留门均可执行；四入口和关键模态有受控证据；不存在以单次文本成功、零阈值发布门或浅 health 替代长期稳定性结论的表述。

## 八、实施约束

- Phase 4 与 registry 权威代码已发布；生产数字只记录已完成事实，不把本地测试写成生产能力。
- `inproc` 暂时保留为破玻璃回滚能力，删除必须另立计划，并以 full-http 稳定期和版本级回滚为前置。
- 任何生产数字在实施前重新取证，不直接沿用本文快照。
- 发布状态必须分别汇报代码合并、制品完成、生产切换和运行验收，四者不得合并成一个“已发布”。
- 不在文档、证据或日志中记录 API key、密码、JWT、数据库连接串和可复用密钥材料。
- 本计划负责生产加固顺序和 gate；`plan.platform.llm-gateway-protocol-router.md` 继续负责四协议与模型池目标设计；迁移复盘只记录历史事实。
