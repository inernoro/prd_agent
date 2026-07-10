# LLM Gateway 生产加固与架构收口 · 计划

> **版本**：v1.5 | **日期**：2026-07-10 | **状态**：开发中
>
> **审计基线**：本文中的生产数字均为 `2026-07-10` 只读快照，不是实时状态。实施任何阶段前必须重新取证。
> **关联文档**：`design.platform.llm-gateway.migration-retrospective.md`（历史复盘）、`plan.platform.llm-gateway-protocol-router.md`（目标协议路由）、`debt.llm-gateway.md`（债务台账）

## 一、管理摘要

LLM Gateway 已完成两项关键切换：生产 AI 请求的默认执行通道运行于独立 `llmgw-serve`，MAP 通过 HTTP 调用 GW；全部已注册 appCaller 的正常路由配置也已由 GW-owned 模型池承接，MAP fallback 计数为 0，网关外直接创建上游 LLM client 的静态基线为空。这证明执行层和已注册配置权威迁移有效，但不等于所有协议、模态、成本、安全和高可用治理已经完成。

本计划处理剩余差距：发布编排、深度 readiness、服务冗余、预算、取消、幂等、数据保留、multipart 生命周期和服务鉴权从“可运行”提升为“可长期治理”；再用受控协议矩阵补齐文本之外的真实证据。最终目标是 MAP 只拥有业务协议与业务生命周期，GW 独占 AI 请求的协议适配、路由、模型池、平台、密钥、预算和请求日志。

三层结论必须始终分开：

| 层次 | 结论 | 不得夸大的部分 |
|---|---|---|
| 已确认 | 生产四个 GW 相关镜像运行同一提交；默认执行通道为 HTTP；已注册 appCaller 的配置权威检查为 ready | 不等于所有多模态和外部协议都已做同提交真实验收 |
| 当前边界 | 同提交真实日志只覆盖 4 个 appCaller，shadow 只有 1 条；生产 API 仍直连单个 serving，发布首探针存在启动时序竞争 | 不得用 11 条成功文本请求推导全系统长期稳定，也不得把独立数据库解释成完全物理隔离 |
| 目标态 | MAP 只负责业务，GW 负责所有 AI 治理，并具备可执行的高可用、成本、安全和数据生命周期门禁 | 完成前不得把保留的 `inproc` 破玻璃能力或测试通过等同于生产能力全绿 |

当前不建议因本计划立即回滚生产。整改采用先止血、再收口权威、最后提升协议与治理质量的顺序，不在同一发布中同时改路由、数据保留、服务鉴权和协议行为。

当前建议顺序只有一条主线，不并行扩大改动面：

| 顺序 | 先做什么 | 为什么排在这里 | 完成后才能做什么 |
|---:|---|---|---|
| 1 | 固化发布前置配置：Compose project、经 gateway 的 serving URL、readiness 对象探针 key | 当前生产 `.env` 会覆盖新默认值；不先迁移会绕过主备或让实例永久不就绪 | 发布 Phase 3 同提交镜像 |
| 2 | 发布深度 readiness、readiness wait、provider audit scope 和 serving 主备 | 这些问题已造成真实假失败；主备可先消除单点，又不扩大非原子预算的并发面 | 做受控停主实例摘流演练 |
| 3 | 落日志索引、保留期和 multipart 清理 | 防止数据增长和敏感对象残留；必须先 dry-run，不触发上游费用 | 再接原子预算、取消和幂等 |
| 4 | 落原子预算、scoped key、取消和非幂等保护 | 先把外部系统接入和付费风险变成可治理契约；预算原子化后才允许 serving 双活 | 扩大外部协议与真实流量范围 |
| 5 | 执行四入口多模态受控矩阵 | 最后才需要少量真实上游调用，且每类都有预算和停止条件 | 才能宣称“关键能力均有同提交生产证据” |

### 1.1 当前可说与不可说

| 问题 | 当前可以确认 | 当前不能确认 |
|---|---|---|
| GW 是否已经承载生产请求 | 是。生产默认模式为 `http`，正常请求经过独立 `llmgw-serve` | 不能据此宣称所有协议和多模态均已验证 |
| 模型池是否已经归 GW | 已注册且可运行 appCaller 的配置权威已归 GW，MAP fallback 为 0 | 新 caller、外部系统和残留迁移工具仍需持续门禁，不能靠约定保证 |
| GW 是否已经完全独立于 MAP | 数据治理边界已拆分，GW 有独立数据库和日志所有权 | 仍依赖 MAP Mongo 中的资产存储配置，不是完全物理隔离 |
| 当前能否继续运行生产 | 可以，不建议仅因本计划回滚当前 full-http | 在 readiness、主备和预算闭环完成前，不应扩大到无约束外部接入或双活 |
| 是否已经达到“零惊吓” | 已消除直连、配置回退和部分数据串库风险 | 发布时序、单点、预算、取消、幂等、保留期和多模态证据尚未全部关闭 |

### 1.2 必须提醒业务所有者的隐性后果

1. 控制台看到 `transport=http` 只能证明请求经过 GW，不能单独证明模型池、预算、密钥和配置权威都归 GW；必须同时看 config-authority、fallback 和路由日志。
2. “两个容器都启动”不等于高可用。生产 API 若仍指向 `llmgw-serve:8091`，备用实例不会承载故障转移，必须先迁移旧 `.env`。
3. “health 200”不等于可生成。Mongo、对象存储、密钥解密或路由不可用时，浅 health 仍可能为 200，必须以深度 readiness 作为摘流和发布依据。
4. “预算已配置”不等于不会超额。当前预算不是原子预占，并发请求或双活会扩大穿透窗口，原子预算完成前只能采用主备模式。
5. “取消页面任务”不等于停止计费。取消信号未贯穿上游时，请求仍可能在后台生成并产生费用。
6. “请求超时”不等于上游未受理。图片和视频等非幂等提交如果自动重试，可能重复生成和重复扣费，必须引入 unknown-outcome 和幂等状态查询。
7. “数据库分开”不等于依赖完全分开。serving 仍从 MAP 配置域获取资产存储信息，MAP Mongo 故障仍可能影响 GW readiness。
8. “一次真实调用成功”只能证明该时间、该供应商、该模型和该请求形态成功，不能外推余额、权限、流式、多模态和下一次调用仍然成功。

以上事项不是要求业务方逐项人工检查，而是要求实现为发布脚本、运行时 readiness、数据库约束和自动化测试。业务方只需要审批昂贵真实调用预算，以及是否进入下一阶段。

## 二、生产事实及影响

### 2.1 审计快照

| 事实 | `2026-07-10` 快照 | 产生的问题 |
|---|---|---|
| 生产发布提交 | `ef267452903c37770162c5101d1f027ec3377c82`；`api / llmgw / llmgw-serve / llmgw-web` 镜像、health commit 和 rollout ledger 一致 | 当前版本身份可信；后续发布仍必须重新做三方一致性检查，不能把服务器源码目录当版本权威 |
| 执行模式 | API 显式配置 `LlmGateway__Mode=http`；已注册调用方的 MAP fallback 开关均为禁用；隔离运行同一生产镜像并移除 Mode 后按预期拒绝启动 | 正常流量不会因漏配静默回到 inproc；破玻璃回滚仍需保持显式、审计和版本级可恢复 |
| appCaller 状态 | `active=3`、`configured=15`、`disabled=1`、`discovered=0`；`autoWithoutPool=0` | 已注册配置权威已收口；新 caller 的首次注册、状态提升和默认池策略仍要长期防止漂移 |
| appCaller 数据约束 | 重复数为 0；已建立大小写不敏感的 `(AppCallerCode, RequestType)` 唯一索引；1 条历史重复已归档并有操作审计 | 当前重复风险已关闭；后续 schema 或 collation 变更必须保留该不变量 |
| 配置权威报告 | `status=ready`、`mapFallbackObjectsRemaining=0`、`activeMissingGatewayPool=0`、`activeBoundPoolWithoutUsableMember=0`、readiness 100% | 已注册 caller 的池、平台和 exchange 可由 GW 解析；这不证明未注册外部系统已完成 scope、预算和权限配置 |
| 同提交真实请求 | 11 条全部 succeeded；`transport=http` 10 条，`inproc` 1 条为 shadow 对照；覆盖 4 个 appCaller；无 stale running | 证明当前短文本、auto/pool/pinned 路由可运行；样本面不足以证明 vision、图片、视频、ASR 和长流式无问题 |
| 同提交 shadow | 1 条真实 inproc/HTTP 对照，`critical=0`、`httpFail=0` | 只能证明该样本一致，不能替代长期流量覆盖或多模态契约测试 |
| 健康写回 | GW 池 `LastSuccessAt` 在部署后更新，MAP 池时间停留在部署前 | 证明本次探活写入 GW 库而非 MAP；仍需失败写回、并发写回和长期监控证据 |
| serving health | 连续 3 次返回 200、commit 一致；ServingKeyIntegrity 对 5 个启用平台为 OK | 现有 health 仍偏浅，未覆盖 Mongo、对象存储、路由可用性和实例摘流 |
| serving 地址 | 生产 `.env` 仍显式设置 `LLMGW_SERVE_BASE_URL=http://llmgw-serve:8091` | 该值会覆盖新 Compose 默认值，使 API 继续绕过 gateway upstream，双实例主备形同虚设 |
| readiness 资产探针 | 当前生产未配置稳定的对象存储 probe key | 新 fail-closed readiness 若直接启用会持续返回非 200，导致两个 serving 都无法进入服务 |
| 发布编排 | 第一次 `http-full` 因临时 release worktree 改变 Compose 项目名，provider audit 找不到 Mongo；第二次部署后首探针出现一次瞬时 502，约 25 秒后恢复 | 发布脚本依赖隐含 Compose identity，且 recreate 后没有 readiness wait；未来可能把正常冷启动误判为发布失败，或在真实未就绪时继续后续 gate |
| provider audit | 全量审计把两个未绑定、当前不可用的 APIyi 视频池当 blocker；本次通过派生“仅已绑定生产池”审计完成 Gate，并保留原始报告 | 审计作用域与生产流量作用域不一致，可能产生假阻塞；脚本需原生区分 blocking 与 deferred，不能长期靠手工派生证据 |
| 生产磁盘与备份 | 根盘使用率 45%；新全量备份有 SHA256 和 `mongorestore --dryRun` 证据；保留和磁盘监控 timer 已启用 | 原 90% 紧急风险已关闭；timer、阈值告警和恢复演练仍需作为持续运维能力而非一次性动作 |
| 付费验证边界 | 本次约 13 次低 token 文本调用；未触发图片、视频、ASR 付费验证 | 成本受控，但多模态真实证据明确缺失；后续每种昂贵能力必须有调用上限和停止条件 |

### 2.2 事实边界

- 上表是 `2026-07-10`、提交 `ef267452...` 的审计快照。实施阶段必须重新执行只读数据库、磁盘、容器、health 和日志查询，并把新时间写入证据。
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
| R06 | P1 | 未关闭 | 安全合规 | 月预算依赖日志估算、无原子预占；成本证据缺失时放行 | 并发越过预算或账单与网关估算不一致 | 原子预算预占、结算和释放闭环，缺成本策略可配置 fail-closed |
| R07 | P1 | 未关闭 | 用户体验 | 客户端断开后上游请求继续 | 用户以为取消，但后台继续生成并计费 | 提供显式 cancel 语义；可取消能力传播 CancellationToken，不可取消任务显示费用提示 |
| R08 | P1 | 未关闭 | 安全合规 | multipart 对象 rehydrate 后未发现清理生命周期 | 原始图片、音频长期残留，带来成本和隐私风险 | 成功、失败、超时均有清理策略，另有兜底生命周期任务和保留审计 |
| R09 | P1 | 未关闭 | 性能容量 | GW 日志、shadow、审计缺少完整查询索引且无限保留 | 查询与预算统计持续变慢，数据库空间不可控 | 建立查询索引、分层保留与归档策略，敏感正文有独立保留期 |
| R10 | P1 | 未关闭 | 运维可用性 | health 浅、serving 单实例、recreate 后立即探测 | health 200 时真实请求仍可能全失败；单点故障无冗余；发布产生瞬时 502 假失败 | readiness 覆盖 Mongo、对象存储、key integrity 和路由；脚本等待 readiness；至少两实例并验证摘流 |
| R11 | P1 | 未关闭 | 安全合规 | 服务间使用共享 Gateway Key，appCallerCode 可由调用方声明 | 外部系统可能冒用其他 caller 的池、预算或权限 | 每个接入方独立 key，key 与允许的 source/appCaller/scope 绑定 |
| R12 | P2 | 未关闭 | 兼容性 | 默认 `default-drop` 丢弃不支持参数 | 请求返回 200，但调用者要求的参数没有生效 | 控制台和响应元数据可见 dropped 参数；关键调用默认 strict |
| R13 | P2 | 未关闭 | 正确性 | 流式客户端反序列化失败时跳过 chunk | 文本、thinking 或 tool arguments 不完整但整体不报错 | chunk 解析失败转显式错误或可恢复事件，并有跨 chunk 合同测试 |
| R14 | P2 | 未关闭 | 正确性 | 图片、视频等非幂等提交遇到超时后重试 | 上游已受理但本地未知时重复生成、重复计费 | requestId/idempotency key、提交状态查询和 unknown-outcome 状态闭环 |
| R15 | P2 | 未关闭 | 兼容性 | 协议 canary 只测短文本 | 4/4 通过被误解为 tools、stream、vision、图片、ASR 全兼容 | 建立按协议和能力分层的受控矩阵，昂贵能力有硬调用上限 |
| R16 | P1 | 未关闭 | 运维可用性 | 发布脚本从工作树目录隐式推导 Compose 项目名 | release worktree 名变化后审计连接到错误项目，造成假失败或误操作目标 | 生产 Compose project name 成为显式 SSOT，所有脚本从同一配置读取并有自测 |
| R17 | P1 | 未关闭 | 正确性 | provider audit 把未绑定池与生产承载池同级阻断 | 不影响当前流量的外部余额或开通状态阻塞整个发布，迫使人工派生证据 | 审计原生输出 bound blockers 与 unbound deferred；发布 Gate 只消费前者但保留全量报告 |
| R18 | P1 | 未关闭 | 正确性 | 同提交真实证据只覆盖 4 个 appCaller 和 1 条 shadow | 新 caller、多模态或低频路径可能在用户首次使用时才暴露问题 | 低成本文本用契约测试覆盖；vision、图片、ASR 各一次受控真测；视频单列预算并由用户启用后再测 |
| R19 | P1 | 未关闭 | 运维可用性 | 生产 serving URL 由旧 `.env` 固定到单实例 | 新主备部署看似存在，实际 API 仍绕过 gateway upstream，主实例退出即全量失败 | 发布前迁移并校验 URL 指向 gateway；从 API 容器验证主实例退出后请求仍可到备用实例 |
| R20 | P1 | 未关闭 | 运维可用性 | 深度 readiness 依赖稳定对象存储 probe key，但生产尚未配置 | 发布后两个 serving 持续不就绪，gateway 返回 502/503 | 从现有系统对象中选择专用稳定探针并验证存在；发布脚本缺 key 时 fail-fast |
| R21 | P1 | 未关闭 | 安全合规 | 月预算非原子，双 serving 同时承载流量会扩大并发超额窗口 | 两实例各自通过检查后同时消费，实际费用突破 appCaller 预算 | Phase 3 只上主备；原子预算预占完成后才改为双活 |
| R22 | P1 | 未关闭 | 架构边界 | serving readiness 仍检查 MAP Mongo，资产存储配置仍来自 MAP AppSettings | 独立 `llm_gateway` 数据库被误解为完全物理独立；MAP 配置或 Mongo 故障仍可能阻断 GW | 把 GW 所需资产存储配置迁入 GW-owned 配置域；MAP Mongo 从 serving 必要依赖和 readiness 中退出 |
| R23 | P2 | 未关闭 | 性能容量 | 平台 `MaxConcurrency` 目前没有形成跨实例原子并发门 | 上游并发限制可能被多个 serving 同时突破，触发限流、熔断和费用抖动 | 建立按 platform/model 的分布式并发令牌，并通过双实例竞争测试 |

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
| 生产证据 | 全量备份目录 `/root/backups/llmgw-prod-before-ef26745-20260710T183737+0800`；数据库归档有 SHA256 与 restore dry-run；根盘 45%，两个 timer active/enabled |

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
| 当前进度 | 75%：实现、最终 build/test、Compose/preflight、provider audit、nginx 主备、容器 readiness 故障注入和本地主备故障转移均通过；生产 env 迁移、同提交发布和生产摘流尚未完成 |

### Phase 4：P1 数据生命周期与成本安全

| 项目 | 内容 |
|---|---|
| 完成定义 | 日志索引与分层保留、multipart 清理、原子预算、显式取消、非幂等提交保护、接入方独立 key 和 appCaller scope 绑定完成 |
| 验证 gate | 查询命中索引；过期日志和对象自动清理；并发预算不超额；取消停止可取消上游；重复 requestId 不重复提交；跨 scope 返回 403 |
| 回滚边界 | 保留期先 dry-run 后启用；对象先标记后删除；新 key 短期双 key 轮换；预算故障默认 fail-closed，破玻璃必须审计 |
| 初始进度 | 0% |

### Phase 5：P2 协议与多模态验收

| 项目 | 内容 |
|---|---|
| 完成定义 | 覆盖 GW Native、OpenAI、Claude、Gemini 的 stream、tools、thinking、vision、图片和 ASR；流式解析错误显式化；dropped 参数可见 |
| 验证 gate | 每个能力先有合同测试，再做一次受控真实验证；图片、ASR 各有明确预算；视频独立预算，每 provider 默认最多一次；失败后必须先证明条件发生变化才能重试 |
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
| Phase 0 | Codex | completed | 100% | 生产执行约 10m | 0 | 释放 18.067 GiB；根盘 45%；备份校验、恢复 dry-run、timer 和阈值测试通过 | 持续由 timer 监控和保留 |
| Phase 1 | Codex | completed | 100% | 已完成 | 0 | 生产重复 0、唯一索引、readiness 100%、fallback 0、autoWithoutPool 0 | 持续监控新 caller 与 schema 漂移 |
| Phase 2 | Codex | completed | 100% | 已完成 | 0 | mode fail-closed、生产显式 http、GW 健康写回、同提交部署、缺 Mode 隔离启动拒绝均有证据 | 持续防止配置回退 |
| Phase 3 | Codex | in-progress | 75% | 持续统计 | 0 | build 0 error；网关测试 611 项通过；五组件 readiness 故障注入、生产拓扑 preflight、provider audit 和本地主备故障转移通过 | 备份并迁移生产 env，同提交发布后完成真实摘流 |
| Phase 4 | Codex | pending | 0% | 0h | 0 | 数据、预算、取消、幂等、鉴权审计 | 生命周期 dry-run、并发预算、取消和 scope 测试通过 |
| Phase 5 | Codex | pending | 0% | 0h | 本次约 13 次低 token 文本调用 | 同提交受控能力矩阵通过且未超预算 |

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

- 本次文档更新只读取已经完成的生产证据，不修改生产配置、不执行数据库迁移、不新增模型请求。
- `inproc` 暂时保留为破玻璃回滚能力，删除必须另立计划，并以 full-http 稳定期和版本级回滚为前置。
- 任何生产数字在实施前重新取证，不直接沿用本文快照。
- 不在文档、证据或日志中记录 API key、密码、JWT、数据库连接串和可复用密钥材料。
- 本计划负责生产加固顺序和 gate；`plan.platform.llm-gateway-protocol-router.md` 继续负责四协议与模型池目标设计；迁移复盘只记录历史事实。
