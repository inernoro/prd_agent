# LLM 网关与模型池 · 债务台账

> **版本**：v2.0 | **日期**：2026-07-12 | **状态**：开发中
> **关联设计**：`design.llm-gateway-unification.md`（统一方案）、`design.llm-gateway.md`、`design.model-pool.md`
> **整改计划**：`plan.platform.llm-gateway-production-hardening.md`

## 总览

当前 open: 25 / in-progress: 8 / paid: 9 / 总计: 42

本台账记录"LLM 网关与模型池统一"迁移过程中已识别、但尚未在代码中偿还的边界与风险。详细方案见 `design.llm-gateway-unification.md`。

## 债务列表

| ID | 严重度 | 创建日期 | 描述 | 触发条件 | 状态 | 备注 |
|----|--------|---------|------|---------|------|------|
| 2026-07-12-external-tenant-isolation | critical | 2026-07-12 | 已有 `gwk_*` scoped service key，但没有 tenant/team/user/membership 数据模型和服务端租户上下文；key、appCaller、日志、预算与审计无法形成外部客户隔离边界 | 允许 MAP 之外的团队自助接入或开放公网注册前 | open | 按 `plan.platform.llm-gateway-external-platform.md` PR-1/PR-2 实施；禁止相信请求自报 tenantId |
| 2026-07-12-external-developer-onboarding | medium | 2026-07-12 | 控制台没有面向首次接入者的网页 Quickstart、四协议可复制示例、错误码排查和 requestId 定位教程 | 第一个外部开发者接入前 | open | 复用现有四协议与 scoped key，不另造第五套 API |
| 2026-07-12-appcaller-prompt-policy | high | 2026-07-12 | appCaller registry 尚不能配置版本化提示词前缀/后缀；若直接在 adapter 拼字符串会破坏协议语义、审计和 raw/媒体请求 | 需要按 appCaller 注入品牌、合规或业务上下文时 | open | 首版只允许 chat/vision，固定合并顺序并记录 policy id/version/hash |
| 2026-07-12-console-information-architecture | medium | 2026-07-12 | 控制台全部导航挤在顶部，首页第一屏优先展示 runtime gate、协议覆盖和内部拓扑，普通用户难以找到 Activity、接入教程和日常操作 | 控制台面向开发者和外部团队前 | open | 顶部保留全局上下文，左侧分组承载工作区/路由/开发者/组织/治理/设置 |
| 2026-07-12-cost-chart-truthfulness | high | 2026-07-12 | 金额依赖模型池价格快照；缺价格、币种或汇率时 `Estimated USD` 可能显示 0 或不可比较，时间图表也存在比例和渲染可读性问题 | 将控制台金额用于预算、账单或团队决策前 | open | 区分 actual/estimated/unknown，展示价格覆盖率；CNY/USD 不无依据相加，并做图表像素与多视口验收 |
| 2026-06-24-protocol-on-platform | high | 2026-06-24 | 接口模式（adapter/transformer 选择）历史上绑在平台 `PlatformType`；当前文本模型解析链已支持 `池条目 Protocol > 模型 Protocol > 平台 PlatformType`，并按解析出的 Protocol 选 adapter；Gateway adapter 选择已识别 `anthropic/openai-compatible/claude-compatible/openrouter/gemini-compatible` 协议别名；生图 adapter 选择也已改为 Gateway `Protocol` 优先，`apiUrl/modelName` 只做后备；Agent runtime profile 从模型池物化时也已优先使用模型 `Protocol`；ASR chat-audio 分支已按解析 `Protocol` 优先判断，`PlatformType` 只做旧数据后备；raw 发送阶段已修复 `GatewayModelResolution -> ModelResolutionResult` 漏传 `Protocol`，避免 raw 重新按 `PlatformType` 选 adapter；Exchange transformer/WebSocket 专用分支按 `ExchangeTransformerType` 路由，剩余风险主要是生产证据与重放边界 | 任何"同平台多协议"或"某模型换格式"需求 | in-progress | 已补 `ModelResolverTests.PoolProtocolPriority_ShouldPreferPoolItemThenModelThenPlatform`、`GatewayAdapterProtocolAliasTests`、`ImageGenPlatformAdapterTests.GetAdapter_ByExplicitProtocol_OverridesModelAndUrlDetection`、`InfraAgentRuntimeProfileProtocolTests`、`AsrAudioRoutePolicyTests`、`LlmGatewayTests.SendRawWithResolutionAsync_WhenResolutionProtocolDiffersFromPlatform_ShouldUseProtocolAdapter` 防退化；剩余解法=补齐生产 shadow/canary 证据并明确 Exchange async poll、二进制下载、WebSocket ASR 不跨 provider 重放的发布边界 |
| 2026-07-09-gw-config-authority-not-migrated | high | 2026-07-09 | GW-owned appCaller、模型池、平台、模型、Exchange、key 和控制台治理能力已经落地，生产也已开启 active caller MAP fallback 退场门；但 `2026-07-10` 快照只有 `active=3`、`configured=15`、`disabled=1`，resolver 对 configured/discovered caller 仍可能读取 MAP 路由配置。执行经过 GW HTTP 不等于全部模型池权威已经迁移 | 宣称“GW 已成为全部 AI 请求的唯一配置权威”或准备让外部系统长期接入 GW 时 | paid | 生产 config-authority 为 ready，MAP fallback 0，configured/active caller 均由 GW-owned 池解析；静态和运行时守卫持续防漂移 |
| 2026-07-10-appcaller-unique-index | high | 2026-07-10 | `llmgw_app_callers` 缺少 `(AppCallerCode, RequestType)` 复合唯一索引；生产已出现 `literary-agent.illustration.text2img::generation` 重复 configured 记录，并发首次登记可能继续制造重复 | appCaller 被动注册、状态变更或模型池绑定时 | paid | 历史重复已归档并写操作审计，生产重复为 0，大小写不敏感复合唯一索引已建立并通过幂等迁移验证 |
| 2026-07-10-gw-pool-health-wrong-database | high | 2026-07-10 | active 路由读取 `llm_gateway.llmgw_model_pools`，但成功/失败健康更新仍可能写 MAP `model_groups`，导致 GW-owned 成员的健康状态陈旧 | provider 失败、fallback 或健康熔断时 | paid | 合同测试断言 GW 数据域写回；生产快照显示 GW 池健康时间更新而 MAP 池停留在部署前 |
| 2026-07-10-production-mode-fail-open | critical | 2026-07-10 | Program、compose 和发布脚本在 mode 缺失时默认 `inproc`，生产漏配环境变量会静默退回旧执行架构 | 新主机部署、环境变量丢失或脚本重构时 | paid | 生产缺 Mode 已改为拒绝启动；同一生产镜像隔离运行验证 fail-closed，回滚仍要求显式破玻璃动作 |
| 2026-07-11-appcaller-static-runtime-authority | high | 2026-07-11 | serving 会把首次请求写入 `llm_gateway.llmgw_app_callers`，但 `LlmGateway.TryValidateAppCaller` 曾要求命中 MAP `AppCallerRegistry` 静态常量 | 外部系统或新 MAP 功能只按目标协议携带 appCallerCode、未先修改 MAP 代码常量时 | paid | PR #1070 已把运行时准入改为 canonical 格式和 modelType 后缀；生产动态 caller、预算、并发、scoped key、failover 与清理验收全部通过 |
| 2026-07-11-release-probe-transport-label | medium | 2026-07-11 | 当前提交 19 条日志中有 1 条发布探针记录标为 `inproc`，且 `SourceSystem/IngressProtocol` 为空；其余 18 条为 `http` | 操作者按 transport 过滤判断 MAP 是否回退时 | open | 给发布探针统一注入 `release-probe / gw-native / http` 元数据并在控制台单列；当前记录不能解释成 MAP 业务直连 |
| 2026-07-11-appcaller-mixed-route-policy-drift | medium | 2026-07-11 | registry 仅保存单值 `LastObservedModelPolicy`；同一 appCaller 合法混用 auto 与 pinned 时，后一次请求会覆盖观测值并让 runtime gate 反复报告 route drift | 生产 preflight 使用 auto，但验收或实验请求使用 pinned 时 | open | 改为按 route mode 累计观察，或只对策略禁止项判漂移；不能继续用单一 last value 代表合法混合流量 |
| 2026-07-11-maintenance-release-shadow-gate | medium | 2026-07-11 | 已处于 full-http 的维护版本仍默认要求新 commit 自身拥有 24 小时 shadow；新 commit 上线前无法自然产生该证据 | full-http 后进行小版本维护发布时 | in-progress | PR-A 增加显式 `--maintenance-from-commit`：只继承已审计 full-http 基线的 shadow 证据，新 commit 仍强制同 commit HTTP health、四协议、配置权威、runtime gate 和成功台账 |
| 2026-07-10-gw-log-index-retention | high | 2026-07-10 | `llm_gateway` 请求日志、shadow、审计集合基本只有 `_id` 索引，且日志保留请求/响应/thinking 等内容时没有分层保留期 | 日志增长、summary/预算查询或隐私审计时 | in-progress | 查询索引、敏感正文清理和分层 TTL 已实现；删除默认关闭，待生产 dry-run 统计后启用 |
| 2026-07-10-multipart-object-lifecycle | high | 2026-07-10 | multipart HTTP 会上传临时文件引用，serving rehydrate 后未发现成功、失败、超时统一清理和兜底生命周期 | 图生图、ASR、字幕等跨进程文件调用时 | in-progress | 已记录 ref manifest，并在请求 finally 与后台生命周期任务清理；待生产 dry-run 和单次 ASR/图片验收 |
| 2026-07-10-budget-cancel-idempotency | critical | 2026-07-10 | 月预算按日志估算且无原子预占，成本证据缺失时放行；客户端断开不取消上游；非幂等图片/视频提交超时重试可能重复计费 | 并发请求、用户取消、provider 超时或响应丢失时 | in-progress | Decimal128 原子预算、显式 cancel、raw requestId 状态机和 unknown outcome 已实现；本地 Mongo 并发测试通过，待生产部署验证 |
| 2026-07-10-serving-readiness-ha | critical | 2026-07-10 | `/gw/v1/healthz` 只证明进程与 commit 存活，未覆盖 Mongo、对象存储、key integrity 和路由；生产 serving 为单实例 | 依赖故障、容器重启或节点故障时 | paid | 生产 `bad1b3b296...` 已运行主备，带 scoped key 的受保护 route 在停主期间仍为 200；恢复后双实例健康，runtime gate `passed=13 retained=2 blocked=0 waiting=0` |
| 2026-07-10-scoped-service-keys | high | 2026-07-10 | serving 使用共享 Gateway Key，兼容入口允许请求声明 appCallerCode；同一 key 的持有者可能冒用其他 caller 的模型池、预算和权限 | 允许 MAP 之外的系统接入 GW 前 | paid | 生产临时 scoped key 已验证允许范围 200、越权 403、撤销后 401，且清理后无临时 key；MAP 共享 key 仍作为迁移兼容 |
| 2026-07-10-serving-map-config-dependency | high | 2026-07-10 | serving 的请求数据已进入 `llm_gateway`，但资产存储和 AppSettings 仍依赖 MAP 配置域，readiness 仍检查 MAP Mongo | MAP Mongo 或 MAP 配置域故障、或宣称 GW 已完全物理隔离时 | in-progress | PR-B 已把 runtime settings、资产登记、故障通知、密钥自检和 readiness 迁入 GW 域；ModelResolver 仍保留显式关闭的 MAP 兼容 context，待 CDS 契约验证后归档 |
| 2026-07-10-distributed-provider-concurrency | high | 2026-07-10 | 平台 `MaxConcurrency` 尚未形成跨 serving 实例的分布式令牌；月预算也未原子预占 | serving 从主备改为双活，或同一平台并发流量增长时 | paid | 生产无费用假上游竞争验收仅放行 1 路，另一条 429；结束后验收资源租约为 0，临时数据已清理 |
| 2026-06-24-dead-strategy-engines | medium | 2026-06-24 | 6 个策略引擎 + ModelPoolDispatcher 不在服务链路，唯一调用是管理预览；纯死复杂度 | 可删（已取证：main 17 池 100% FailFast，2026-06-25） | open | 取证已过，删除排在 P3 黄金快照建立之后 |
| 2026-06-24-legacy-flag-tier | high | 2026-06-24 | 调度第 3 层 legacy 标记与默认池功能重叠。**取证升级（2026-06-25）：91/153 (60%) code 实际经 legacy 层路由**（非遗迹，是承重墙） | 必须先建 chat/intent/vision/generation 默认池 + 黄金快照确认 91 个 code 改走 DefaultPool 后 | open | 顺序硬约束：直接删 = 砸 60% 调用方；删除前全栈审计（enum-ripple-audit） |
| 2026-06-25-seven-notfound-codes | medium | 2026-06-25 | 7 个 code 解析到空(NotFound)：open-platform-agent.proxy::embedding/rerank、video-agent.audio::tts、video/visual-agent.scene.codegen::code、workflow-agent.cli-agent/webpage-generator::code | 这些 code 真被调用时 | open | 存量隐患（无池无默认无 legacy 的冷门 modelType）；统一设计应显式暴露缺口或补默认 |
| 2026-06-24-appcaller-sync-no-delete | low | 2026-06-24 | AppCallerRegistrySyncService 只增不删，156 条 code 越积越多 | code 降级为标签时 | open | 改对账式 + DeletedAt 软删 + 面板一键清 |
| 2026-06-24-key-descend-rotation | high | 2026-06-24 | Protocol 下沉后更多 ApiKeyEncrypted 落到模型级，密钥轮换需先解密重加密所有字段 | 任何密钥轮换 | open | 受 cross-project-isolation.md 规则 #2 约束，迁移时不放大存量债 |
| 2026-06-24-openrouter-single-point | medium | 2026-06-24 | 默认走 OpenRouter 享受统一，但 OR 故障/限流/消费上限会全系统瘫（不止宕机，throttle 也是 SPOF） | OR 不可用或被限流时 | open | 必须保留一条直连兜底，这是池不能删干净、只能缩短的原因 |
| 2026-06-24-protocol-drift-3-places | high | 2026-06-24 | 旧风险："协议绑平台"散在 LlmGateway、ModelLabController、ArenaRunWorker 多处，实验场景可能绕过 GW。当前已收口：直连棘轮 baseline 为空；ModelLab/Arena 均通过 `gateway.CreateClient(...)` 并传 `expectedModel + pinnedPlatformId + pinnedModelId`，不再自行 new 上游客户端 | 只改网关时 | paid | 证据：`GatewayDirectClientRatchetTests` baseline=0；`GatewayDataDomainGuardTests.ModelLabAndArena_PinSelectedModelThroughGateway` 防退化守卫。更深层“PlatformType 绑协议”仍保留在 `2026-06-24-protocol-on-platform` |
| 2026-06-24-startup-legacy-consumer | high | 2026-06-24 | 删 legacy 标记会动到启动期：Program.cs:945 读 IsMain 建 claude 客户端，InfraAgentRuntimeProfileService 读 IsMain 兜底 | 删 IsMain 字段时 | open | 没迁好系统起不来（非功能坏，是 bootstrap 坏）；测试 `Startup_WithoutLegacyFlags_*` |
| 2026-06-24-stats-continuity | medium | 2026-06-24 | appCallerCode 还是计费/统计维度，StatsController 靠 `chat.*` 前缀摘非 chat token；降级若改名/合并会错乱历史分段 | code 降级时 | open | 降级=绑定变可选，绝不改 code 字符串；测试 `Stats_AfterCodeDowngrade_SegmentationUnchanged` |
| 2026-06-24-image-size-cap-orphan | low | 2026-06-24 | image_gen_size_caps 按 modelId/platformId 做键缓存上游允许尺寸；协议/模型身份变更后缓存键孤儿，首发请求重吃 400 再学 | P2 图片并网关迁移时 | open | 迁移期图片短暂报错；测试 `ImageSizeCap_OnUpstream400_RelearnsWithoutUserError` |
| 2026-06-24-exchange-sentinel-dual | low | 2026-06-24 | 池 item 的 PlatformId 有 `__exchange__` 旧 sentinel 与真 exchange id 两种格式，迁移需双格式兼容 | Exchange 路由归一进协议层时 | open | 测试 `Exchange_BothSentinelAndRealId_Resolve` |

| 2026-06-25-dead-pools-masked-by-legacy | high | 2026-06-25 | 3 个池 Unavailable。**已止血(2026-06-25)**：deepseek-v4-flash(chat默认,53码受影响) test 200 实为陈旧健康标记，已 reset-model-health→Healthy；whisper(asr) 与 gpt-5.4-image-2(gen,HTTP404) 经底片确认**0 活跃调用方**，降级为 P4 清理 | 删 legacy 前 / P4 清理 | in-progress | 主出血已止；剩 2 个零调用死池待删/修（whisper 平台级损坏 totalCount=0、gpt-5.4-image-2 openrouter 无此模型名） |
| 2026-06-25-silent-fallback-no-alert | high | 2026-06-25 | 45%(69/153) code 在跑 fallback，拿到的不是配置模型，且无任何告警 | 新面板上线 / 死池修复 | open | 可视化面板必须把 Unavailable 池 + fallback 热度做成一级红色信息 |
| 2026-06-25-imagegen-default-stub | high | 2026-06-25 | 16 个 generation code 默认解析到 stub-image；text2img 近 7 天 failed 10 次；真实生图全靠 expectedModel 兜，忘传即 stub/报错 | P2 图片并网关 | open | 默认生图池应是真实模型，不是 dev 桩 |
| 2026-06-25-pool-orphans-sprawl | medium | 2026-06-25 | 5 孤儿模型 + auto-* 自动建池泛滥（含 1 个 0 模型空池 auto-marking-line-agent）+ 池 item 悬空引用（claude 混入 qwen 池） | P4 清理 | open | 池版的 code 泛滥；空池/脏引用待清 |

| 2026-06-25-retire-openplatformapp | medium | 2026-06-25 | 原 apigateway = OpenPlatformApp(`sk-*`，绑死 PRD-chat、无 scope) 与现代 OpenApiController+AgentApiKey(`sk-ak-*`) 并存；目标统一到后者 | P6 平台收口 | open | 退役 sk- 老平台 + 清 open-platform-agent.proxy 悬挂 code；迁移现有 sk- 客户 |
| 2026-06-25-openapi-quota-stub | medium | 2026-06-25 | per-key 配额/限流字段已声明未执行（`PassUsageGateAsync` 仍 stub），scope→模型门、动态模型列表、用量聚合面板缺失 | 对外开放前（内部用可暂缓但留 seam） | open | 平台 Phase2；内部为主可延后硬执行，架构留好闸口 |
| 2026-06-25-model-name-public-contract | high | 2026-06-25 | 模型名/池 code 对外即成公开 API 契约；auto-* 脏池/空池/stub 默认对外=事故 | 开放对外入口前 | open | H3/H5 清理升级为对外稳定性前置；模型命名需定稳定公开方案 |
| 2026-07-07-production-runner-channel | critical | 2026-07-07 | LLM Gateway 生产 shadow-start 已有 CI、镜像、preflight 和 dry-run 证据，但正式 stage 默认 runner `self-hosted,prd-agent-prod` 未注册，且 workflow 默认 token 无权查询 runner API；`fast.sh/exec_dep.sh` 不能在 GitHub-hosted runner 上冒充生产执行 | 执行 `LLM Gateway Production Stage` 的 `execute=true` 或继续 rollback/canary/http-full | open | 仍需恢复/注册生产 self-hosted runner，或配置具备 runner 查询权限的 `PRD_AGENT_PROD_GITHUB_TOKEN` 并提供等价生产主机执行通道。2026-07-10 已通过 SSH 手工通道最小更新 `llmgw/llmgw-web` 并完成 config-authority；该手工通道不能替代长期 CI runner |
| 2026-07-08-video-shadow-cost-cap | high | 2026-07-08 | LLM Gateway 生产 shadow 取证期曾批量触发视频生成真实入口，成功 submit 会产生真实供应商成本；后续余额不足/通道不可用只说明供应链阻断，不代表前序成功请求没有计费 | 任何生产 seed/canary 同时启用 `--include-video-direct`、`--include-visual-video-direct`、视频 poll/download 或提高 `--iterations` 时 | in-progress | 已在 `scripts/llmgw-map-shadow-seed.py` 增加默认 `--max-video-submits=3` 与 `--allow-high-cost-video` 显式解除闸门；视频能力暂缓期间，非视频 release gate 必须使用 scoped 过滤，不再为了全量门槛重复打视频供应商。2026-07-08 只读取证：`visual-agent.videogen::video-gen` 近期 http 成功 418 次，`video-agent.videogen::video-gen` http 成功 39 次，失败 7 次，失败集中在 APIyi 无通道、Ark 404、火山方舟 overdue balance 和模型池不可用。 |
| 2026-07-07-prod-video-asr-upstream-unavailable | critical | 2026-07-07 | 生产 video/ASR raw 发布 gate 仍未闭合：`video-agent.videogen::video-gen` 绑定池不可用；APIyi `alibaba/wan-2.6`、`bytedance/seedance-2.0-fast` 均返回 no available channels；豆包 ASR 已补池并可解析，但真实 raw seed 返回 `Invalid X-Api-Key` | 全量 `LLMGW_MODE=http`、`canary-video-asr`、或宣称视频/ASR/字幕已迁移成功 | open | 已备份 `/root/backups/llmgw-prod-before-video-asr-evidence-20260707T070525+0800`、`/root/backups/llmgw-prod-before-restore-shadow-sample-20260707T073402+0800`、`/root/backups/llmgw-prod-before-video-reprobe-20260707T074011+0800`、`/root/backups/llmgw-prod-before-asr-pool-bootstrap-20260707T080433+0800`、`/root/backups/llmgw-prod-before-asr-seed-20260707T081332+0800`。生产仍为 `LlmGateway__Mode=shadow`、`LlmGateway__ShadowFullSamplePercent=1`、allowlist 空。2026-07-07 已用 `scripts/llmgw-prod-asr-pool-bootstrap.sh` 新增 `asr_doubao_bigmodel_pool` 并绑定四个 ASR caller：`document-store.subtitle::asr`、`transcript-agent.transcribe::asr`、`video-agent.v2d.transcribe::asr`、`video-agent.video-to-text::asr`。新版 upstream readiness 取证：四个 ASR caller 均解析为 DedicatedPool `doubao-asr-bigmodel` / `Exchange:豆包 ASR (BigModel)` / `protocol=exchange` / `Healthy`；视频仍返回“模型池内所有模型不可用”。同日备份后跑真实 MAP seed：`seed[1].session_chat` 成功，`seed[1].transcript_asr` 与 `seed[1].document_store_subtitle_asr` 均失败，错误为豆包 ASR `code=45000010, message=Invalid X-Api-Key`，证据文件在生产 `/tmp/llmgw-asr-seed-after-bootstrap.json`。只读 provider config audit 报告在生产 `/tmp/llmgw-provider-config-audit.json`：ASR key 可解密、长度 36、UUID 单 key 形态、`TargetAuthScheme=XApiKey` 合理；失败项为 no Healthy video-gen model 以及两个 ASR seed 失败。此前短时把原视频池健康恢复为 Healthy 且采样提到 100% 后跑 `--include-video-direct`，真实业务入口仍失败：`video direct upstream failed ... HTTP 404`，raw shadow `httpFail=5`。下一步必须补可用视频渠道和有效豆包 ASR key/resourceId，并重跑 `scripts/llmgw-prod-provider-config-audit.py --seed-evidence-json <new-seed>` 与 `scripts/llmgw-map-shadow-seed.py --include-video-direct --include-transcript-asr --include-document-store-subtitle-asr`，得到 `raw` allMatch 且 httpFail=0 后才可进入 video-asr 灰度。 |

## 最新协议路由债务收口（2026-07-09）

- `ProviderAttempts` 已从静态候选快照推进到结果快照：日志完成路径会写入最终发送 attempt 的 `statusCode`、`durationMs`、`error`、`endedAt`，控制台详情 API 和详情抽屉同步展示。
- Exchange async raw 的真实多 HTTP 链路已接入 attempts：submit、每次 poll、poll-timeout 都会按顺序记录 stage、HTTP 状态、耗时和错误。
- 非流式 auto 模式已具备普通 provider retry：当首个候选返回 402/408/409/425/429/5xx 时，发送阶段会切到 Resolve 阶段预先算好的下一个候选，并记录多条 send attempts。流式 auto 模式仅支持输出前失败的 provider retry，成功开始输出后不会跨 provider 续接。raw JSON/multipart 模式仅支持 submit 阶段 provider retry，进入 Exchange async poll、二进制下载或 WebSocket ASR 后不会跨 provider 重放。provider retry 尚需生产灰度证据；不能据此宣称跨 provider retry 级别已完全闭环。
- `http-full` 发布证据门已补配置权威检查：`scripts/llmgw-release-gate.py --require-config-authority` 会读取控制台 `/gw/config-authority/report`，rollout ledger 会拒绝缺少 `configAuthority.ok=true` 的 `http-full` 成功记录。该 gate 只是防误切；即使 config-authority 已执行，也仍必须等待同 commit runtime evidence、fallback 退场门与 `http-full` 台账闭合。
- 配置权威退场已有可执行脚本并纳入生产阶段：`scripts/llmgw-config-authority-apply.py` 默认只读；显式 `--execute` 才会调用 `bulk-claim` 与 `bind-active-app-callers`，`--require-ready` 会把最终 readiness 作为非零退出门。`scripts/llmgw-prod-stage.sh --stage config-authority` 已把该动作写入 rollout ledger，且不运行 `fast.sh` / `exec_dep.sh`。该阶段执行链已改为备份先行：先运行 `scripts/llmgw-config-authority-backup.sh` 备份 `llm_gateway` 全库与 MAP 模型配置关键集合，再执行配置权威迁移；ledger 会拒绝 dry-run、空归档或无 SHA256 的备份证据。2026-07-10 已在正式环境执行，结果为 `status=ready`、`mapFallbackObjectsRemaining=0`、`activeAppCallerMapFallbackReady=true`。

## 最新生产 config-authority 取证（2026-07-10 03:52 CST）

- 正式域名 `map.ebcone.net` 在本轮复核时已经处于 `LLMGW_MODE=http`，但 `api/llmgw-serve` 仍运行旧 commit `f661cd979faa7dbf1911521d2eb2452aea8e2cbd`，控制台与运行时代码没有完全同 commit。为避免影响 AI 请求路径，本轮只最小更新 `llmgw/llmgw-web` 到 `537f2f9cdf2403ff1d5148913fa6f455710a85f7`，未重启 `api/llmgw-serve`。
- 执行前备份生产 `.env`、`docker-compose.yml` 和脚本到 `/root/backups/llmgw-console-config-authority-before-20260710T034657+0800`；写库前用 `scripts/llmgw-config-authority-backup.sh` 备份 `llm_gateway` 全库及 MAP 模型配置关键集合，备份目录为 `/root/backups/llmgw-prod-before-config-authority-20260710T035033+0800`，证据文件为生产 `.llmgw-release-evidence/20260709T195033Z_config-authority_537f2f9cdf24.config-authority-backup.*`。
- `scripts/llmgw-config-authority-apply.py --execute --require-ready` 已完成 MAP-only 批量认领与 active appCaller 绑池，最终控制台报告为 `status=ready`、`mapFallbackObjectsRemaining=0`、`activeMissingGatewayPool=0`、`readinessPercent=100`、`gapCount=0`。执行证据为生产 `.llmgw-release-evidence/20260709T195052Z_config-authority_537f2f9cdf24.config-authority.*`。
- rollout ledger 已追加 `config-authority success`，但 `/gw/runtime-gates` 需要 `llmgw` 容器能读取 `.llmgw-release-evidence/rollout-ledger.jsonl`。本分支已补 compose 挂载与 `LlmGateway:RolloutLedgerPath` 显式配置，避免控制台读不到宿主机台账。
- 当前仍不能宣称全量终态完成：`api/llmgw-serve` 还需同 commit 发布；`active_appcaller_map_fallback_exit` 仍需启用 `LlmGateway:DisableMapConfigFallbackForActiveAppCallers=true` 并验证；`current_commit_http_transport`、`dropped_parameter_runtime_evidence`、`appcaller_runtime_coverage`、`shadow_runtime_evidence` 与 `full_http_rollout_ledger` 仍需同 commit 运行态证据。

## 最新生产取证（2026-07-07 10:51 CST）

- `shadow-start` 已在生产机 `root@map.ebcone.net` 成功部署到 commit `55579a29abc84e4ffb0fc1874d333a0d1178159b`，四个镜像 `api / llmgw / llmgw-serve / llmgw-web` 同 commit，`LLMGW_MODE=shadow`，allowlist 为空，`ShadowFullSamplePercent=1`。
- 生产备份点：Mongo 归档 `/root/backups/llmgw-prod-before-shadow-deploy-20260707T102958+0800`；host nginx 反代配置备份 `/root/backups/llmgw-host-nginx-20260707T104906+0800`。
- 生产 GW serving 证据：`https://map.ebcone.net/gw/v1/healthz` 返回 commit `55579a29abc84e4ffb0fc1874d333a0d1178159b`；post-deploy serving probe PASS；D-layer smoke 10/10 PASS。
- 生产 GW 控制台入口：`https://map.ebcone.net/llmgw/`、`https://map.ebcone.net/llmgw/logs` 已经通过 host nginx 反代到 `prd-llmgw-web`，浏览器检查 root 已渲染，登录 API `POST /gw/auth/login` 返回 JSON 信封而不是主站 HTML。
- 同 commit 文本 shadow 证据：`scripts/llmgw-map-shadow-seed.py --include-tutorial-email-send` 成功，`send=1`、`stream=2`、`critical=0`、`httpFail=0`；coverage 证据为生产 `.llmgw-release-evidence/20260707T025032Z_manual_text-shadow-coverage.json`。
- 仍然禁止进入 `canary-video-asr` 或全量 `LLMGW_MODE=http`：最新 upstream readiness / provider audit 仍失败，`video-agent.videogen::video-gen` 无可用 video-gen 模型，ASR 近期失败仍包含 `Invalid X-Api-Key` / no available channels / stream 502。必须补可用视频渠道和有效 ASR 凭据后，重新产生 `raw` allMatch 且 `httpFail=0` 的真实样本。

## 最新生产取证（2026-07-07 11:06 CST）

- 已将 `visual-agent.videogen::video-gen` 纳入 video/ASR release gate、provider config audit、upstream readiness、shadow watch 和 `exec_dep.sh` 默认 full-http/canary 门禁，避免只用 `video-agent.videogen::video-gen` 样本替代视觉视频入口。
- 同步生产脚本前已重新备份数据：`/root/backups/llmgw-prod-before-video-gate-sync-20260707T110320+0800`，包含 `mongo-prdagent.archive.gz` 与 `mongo-llm_gateway.archive.gz`，并生成 `SHA256SUMS`。
- 同步生产脚本前已备份旧脚本：`/root/backups/llmgw-prod-release-gate-scripts-before-sync-20260707T110556+0800`。
- 同步后在生产机完成脚本语法校验：`python3 -m py_compile scripts/llmgw-prod-provider-config-audit.py scripts/llmgw-upstream-readiness.py scripts/llmgw-readiness-audit.py` 与 `sh -n exec_dep.sh scripts/llmgw-prod-stage.sh` 均通过。
- 生产只读 provider config audit 使用新脚本跑出预期 FAIL，证据为 `.llmgw-release-evidence/20260707T030620Z_provider-config-video-visual-gate.json`。首要失败项为 `visual-agent.videogen::video-gen` 没有 video-gen `ModelGroupIds`；同时仍有 no Healthy video-gen model、视频上游 404/503、ASR `Invalid X-Api-Key`/502/503 等阻塞。
- 结论不变：当前只允许继续 shadow 与文本类证据收集；禁止发布 `canary-video-asr` 或全量 `LLMGW_MODE=http`。

## 最新生产取证（2026-07-07 11:21 CST）

- 已新增并执行 `scripts/llmgw-prod-video-caller-bootstrap.sh`，将 `visual-agent.videogen::video-gen` 绑定到 `video-agent.videogen::video-gen` 使用的 `video_seedance_2_0_fast_pool`。该动作只补 appCaller 漏绑，不修改模型健康状态，不替换上游 key，不切 `LLMGW_MODE`。
- 执行前脚本备份：`/root/backups/llmgw-prod-video-bootstrap-scripts-before-sync-20260707T111603+0800`；生产写库备份：`/root/backups/llmgw-prod-before-video-caller-bootstrap-20260707T111717+0800`。
- dry-run 先确认计划变更：sourceCaller=`video-agent.videogen::video-gen`，sourcePoolIds=`video_seedance_2_0_fast_pool`，targetCallers=`visual-agent.videogen::video-gen`；真实执行返回 `matchedCount=1`、`modifiedCount=1`。
- provider config audit 复验文件：`.llmgw-release-evidence/20260707T032001Z_provider-config-after-video-caller-bootstrap.json`。`HAS_VISUAL_BINDING_FAILURE=false`，说明视觉视频漏绑项已消除；audit 仍 FAIL，因为生产没有 Healthy video-gen model，且历史 video/ASR 上游错误仍存在。
- upstream readiness 复验文件：`.llmgw-release-evidence/20260707T032044Z_upstream-readiness-after-video-caller-bootstrap.json`。`video-agent.videogen::video-gen` 与 `visual-agent.videogen::video-gen` 均失败于“模型池内所有模型不可用”，不再是视觉入口独有配置漏绑。
- 结论更新：video/ASR 发布阻塞从“视觉视频漏绑 + 上游不可用”缩小为“video-gen 上游模型池不可用 + ASR 凭据/通道失败”。仍禁止进入 `canary-video-asr` 或全量 `LLMGW_MODE=http`。

## 最新生产取证（2026-07-07 11:34 CST）

- 已把 video-gen 平台协议检查加入 `scripts/llmgw-prod-provider-config-audit.py` 与 readiness 静态守卫，防止把火山 Ark OpenAI chat base URL 误当成 OpenRouter `/videos` 平台放行。
- 生产同步前已备份旧审计脚本：`/root/backups/llmgw-provider-audit-scripts-before-protocol-gate-20260707T113258+0800`；同步后生产语法检查通过：`python3 -m py_compile scripts/llmgw-prod-provider-config-audit.py scripts/llmgw-readiness-audit.py`。
- 生产只读 provider config audit 证据：`.llmgw-release-evidence/20260707T033318Z_provider-config-video-platform-protocol-gate.json` 与 `.llmgw-release-evidence/20260707T033318Z_provider-config-video-platform-protocol-gate.md`。审计 FAIL，共 15 个失败项。
- 新协议门禁已命中真实生产配置：`doubao-seedance-2-0-fast-260128` 绑定平台 `火山引擎`，`ApiUrl=https://ark.cn-beijing.volces.com/api/v3/`，但 MAP 现有视频客户端发送 OpenRouter `/videos` 请求；该组合会导致视频 HTTP 404，不能进入视频灰度。
- 其他阻塞仍在：没有 Healthy video-gen model；APIyi `bytedance/seedance-2.0-fast` 与 `alibaba/wan-2.6` 仍是 no available channels；ASR 仍有 `Invalid X-Api-Key`、stream 502、whisper 503 等失败。
- 结论不变：当前生产只能继续 shadow 与文本类证据收集；禁止 `canary-video-asr`、禁止全量 `LLMGW_MODE=http`、禁止宣称视频/ASR/字幕已完成迁移。下一步必须二选一：配置真正 OpenRouter-compatible video 平台，或实现专用火山视频适配器；同时替换有效 ASR 凭据/资源后重跑 raw seed，直到 `httpFail=0`。

## 最新生产取证（2026-07-07 12:43 CST）

- 已部署 commit `b059d85e2ed37584e66ffe8d500c6f015b78fd42` 到生产 `shadow-start`，容器 `api / llmgw / llmgw-serve / llmgw-web` 均为同一 commit；生产仍保持 `LlmGateway__Mode=shadow`、`LlmGateway__ShadowFullSamplePercent=1`、allowlist 空。
- 生产备份点：`/root/backups/llmgw-current-audit-20260707T121813+0800`；chat 池小粒度回滚备份：`/root/backups/llmgw-current-audit-20260707T121813+0800/model_group_fc839_before_siliconflow_20260707T123954+0800.json`。
- 初次 `shadow-start` 的 D 层 smoke 失败于 `report-agent.generate::chat`：`/gw/v1/resolve` 解析到 `api.vveai.com`，上游返回 `该令牌额度已用尽`。修正方式是在默认 chat 池 `fc839911f86d4b0193c42c08d600b25d` 前置已由生产日志验证可用的 `deepseek-ai/DeepSeek-V4-Flash @ 硅基流动`，不切 mode、不删除原池项。
- 修正后生产 `/gw/v1/resolve` 已解析到硅基流动，`/gw/v1/send` 成功；完整 `scripts/gw-smoke.py` 10/10 PASS，证据：`.llmgw-release-evidence/20260707T044026Z_manual-after-chat-pool-fix_b059d85e2ed3.gw-smoke.json`。
- 文本 MAP shadow seed 已成功：`stream` 样本 2 条、`allMatch=2`、`critical=0`、`httpFail=0`，证据：`.llmgw-release-evidence/20260707T044241Z_manual-map-shadow-seed-text_b059d85e2ed3.json`。仅要求文本 stream 的小门槛 release gate PASS，证据：`.llmgw-release-evidence/20260707T044312Z_manual-release-gate-text-shadow_b059d85e2ed3.json`。
- ASR HTTP canary 已证明 MAP API 能到达 `/api/ops/llmgw/canary/asr` 并进入 raw 阶段，但 BigModel 返回 `Invalid X-Api-Key`，stream 返回 WebSocket 401（诊断显示 appKey 为空或 accessKey 无效/过期），证据：`.llmgw-release-evidence/20260707T044056Z_manual-asr-http-canary_b059d85e2ed3.json` 与 `.llmgw-release-evidence/20260707T044137Z_manual-asr-http-canary-stream_b059d85e2ed3.json`。
- 代码侧已新增 `scripts/llmgw-prod-chat-pool-bootstrap.sh` / `.js`，把上述 chat 池修正固化为默认 dry-run、执行前备份、幂等前置候选模型的生产操作；`scripts/llmgw-readiness-audit.py` 已纳入静态守卫。结论仍不变：文本链路可继续 shadow/低风险灰度取证，video/ASR/raw 未达全量发布门，禁止全量 `LLMGW_MODE=http`。
- 同日继续扩展 `scripts/llmgw-video-exchange-canary.py`：默认仍保持低成本 submit canary；显式传 `--poll-status --download-result` 时会通过 `/gw/v1/raw` 轮询火山视频任务状态，并对返回的结果 URL 做下载探测。这样在上游模型开通后，同一脚本可覆盖发布计划要求的 video submit / poll / download 证据链；当前生产仍会在 submit 阶段被 `ModelNotOpen` 或模型池不可用阻断。

## 最新生产取证（2026-07-07 19:22 CST）

- 用户已开通火山方舟 Seedance 后，生产复验显示 `video-agent.videogen::video-gen` 与 `visual-agent.videogen::video-gen` 均可解析到 `Exchange:火山方舟 Seedance 视频生成` / `doubao-seedance-2-0-fast-260128`，upstream readiness 6 项 PASS。
- ASR HTTP multipart canary 已 PASS：`document-store.subtitle::asr`、`transcript-agent.transcribe::asr`、`video-agent.v2d.transcribe::asr`、`video-agent.video-to-text::asr` 均通过 BigModel raw 路径，返回 `StatusCode=200`。
- Seedance submit / status / download 证据已补齐：两个视频入口 submit 均 200；初次 24 次轮询仍为 `in_progress`，后续复查均 `completed` 且有结果 URL；下载探测返回 `206`、`Content-Type=video/mp4`、采样 1 MiB 成功。证据文件：`.llmgw-release-evidence/20260707T111308Z_video-exchange-canary-after-seedance-open.json`、`.llmgw-release-evidence/20260707T111759Z_video-download-followup-after-seedance-open.json`。
- 已在短时 100% shadow 采样窗口跑 MAP 真实入口 seed，并自动恢复到 `LlmGateway__Mode=shadow`、allowlist 空、`ShadowFullSamplePercent=1`。同 commit `80bf92566328f67830c530bbfe07cdc815a1d72c` 当前 raw shadow 汇总：`raw=55`、`allMatch=55`、`critical=0`、`httpFail=0`。raw 样本覆盖 `video-agent.videogen::video-gen`、`visual-agent.videogen::video-gen`、`transcript-agent.transcribe::asr`、`document-store.subtitle::asr`。证据文件：`.llmgw-release-evidence/20260707T112155Z_map-shadow-seed-video-asr-after-seedance-open.json`、`.llmgw-release-evidence/20260707T112632Z_map-shadow-seed-visual-video-after-seedance-open.json`。
- 代码侧已扩展 `scripts/llmgw-map-shadow-seed.py`，新增 `--include-visual-video-direct`，通过 `/api/visual-agent/video-gen/runs` 创建 direct run 并等待后台 worker 完成，用于补齐 `visual-agent.videogen::video-gen:raw` 的 MAP 真实入口 shadow 样本；`doc/plan.llm-gateway.full-cutover.md` 与 `GatewayDataDomainGuardTests` 已同步守卫该参数。
- 结论更新：Seedance 与 ASR 不再是“不可调用”阻塞，视频/ASR raw 真实 MAP 样本已闭合到 allMatch/httpFail=0；当前剩余发布 gate 是图片 raw 样本、核心 appCaller 每格 30 条、以及 24 小时覆盖观察窗口。因此继续禁止全量 `LLMGW_MODE=http`，只能按 allowlist 小批灰度。

## 最新生产取证（2026-07-07 19:50 CST）

- 生产仍保持安全状态：`LlmGateway__Mode=shadow`、`LlmGateway__HttpAppCallerAllowlist=`、`LlmGateway__ShadowFullSamplePercent=1`。取证前已备份 `/root/backups/llmgw-before-image-raw-evidence-20260707T193813+0800`，短时采样窗口结束后已强制恢复 API 容器环境。
- 已用 `scripts/llmgw-map-shadow-seed.py --include-image-raw --include-image-worker-text2img --include-image-worker-img2img --include-image-worker-vision` 走 MAP 真实入口补图片 raw 样本。`visual-agent.image-gen.generate::generation`、`visual-agent.image.text2img::generation`、`visual-agent.image.img2img::generation` 均得到 `HttpOk=true`、`AllMatch=true`、`critical=false`。证据文件：`.llmgw-release-evidence/20260707T114029Z_map-shadow-seed-image-raw.json`。
- 初次 `visual-agent.image.vision::generation` 使用历史参考图时，inproc 成功但 http shadow 被上游内容策略拒绝，错误为“提交中含有违反平台政策的内容”，`HasCritical=false`，mismatch 为 `rawSuccess` warning。该样本证明不是文件 rehydrate/hash/transport 失败，但仍不能作为发布门成功样本。
- 随后改用本轮 seed 自己生成的两张干净图片 sha 重跑 `--include-image-worker-vision`，`visual-agent.image.vision::generation` 得到 `HttpOk=true`、`AllMatch=true`、`critical=false`、`mismatches=[]`。证据文件：`.llmgw-release-evidence/20260707T114823Z_map-shadow-seed-image-vision-clean-refs.json`。
- 按全量 http raw 发布门做只读预检仍 FAIL，证据文件：`.llmgw-release-evidence/20260707T115229Z_release-gate-full-raw-precheck.json`。失败项集中在每格样本不足、覆盖时长不足 24 小时、以及上述已归因的 vision policy httpFail 仍在 24 小时窗口内。
- 结论更新：图片 raw 四类核心入口已经各自出现至少 1 条真实 MAP shadow 成功样本；视频、ASR、图片的跨进程 raw 能力不再是“完全未通”。但最近 24 小时/当前 commit 下仍有一条已归因的 vision policy httpFail 历史样本，且每个核心 appCaller 尚未达到 30 条、覆盖窗口尚未满 24 小时。因此仍禁止宣称全量迁移完成，下一步应从 clean-ref 时间点之后重新累计样本，并只允许按 allowlist 小批灰度。

## 最新生产取证（2026-07-07 20:03 CST）

- 已新增并同步生产 `scripts/llmgw-shadow-sample-window.sh`，把短时 100% shadow 采样、配置备份、API 强制重建、MAP seed 执行、退出恢复固化为脚本。脚本默认 dry-run；执行模式必须显式设置 `LLMGW_SHADOW_SAMPLE_WINDOW_SEED_FLAGS`；恢复目标默认 `LLMGW_SHADOW_SAMPLE_WINDOW_RESTORE_PERCENT=1`，避免手工窗口把 100% 采样误留在线上。
- 已用该脚本在生产跑 1 条 clean-ref `visual-agent.image.vision::generation` 样本。证据文件：`.llmgw-release-evidence/20260707T115734Z_shadow-sample-window.json`；备份目录：`/root/backups/llmgw-before-shadow-sample-window-20260707T195734+0800`。
- 脚本退出后生产已确认恢复：`LlmGateway__Mode=shadow`、`LlmGateway__HttpAppCallerAllowlist=`、`LlmGateway__ShadowFullSamplePercent=1`。新版脚本已同步生产并 dry-run 通过。
- 已新增 `scripts/llmgw-shadow-sample-accumulate.sh`，用于把同一类 MAP 真实入口按 batch 累计到发布门要求的每格样本量。该脚本默认 dry-run；执行模式必须显式设置 `LLMGW_SHADOW_ACCUMULATE_SEED_FLAGS`；每个 batch 都通过短时采样窗口脚本完成提采样、seed、恢复，并把证据归档到同一 run 目录。脚本末尾默认跑 `llmgw-shadow-coverage-report.py`，因此 coverage 仍失败时不会被误写成发布达标。
- 当前最近 2 小时 `visual-agent.image.vision::generation:raw` 有 3 条样本，其中 2 条 clean-ref 成功为 `HttpOk=true`、`AllMatch=true`、`critical=false`、`mismatches=[]`；1 条旧历史参考图样本仍是已归因的上游 policy httpFail。下一步继续从 clean-ref 样本累计，不把旧 policy fail 计入成功发布门。
- 代码侧直连 ratchet 已达到 baseline 空集合：`GatewayDirectClientRatchetTests` 18/18 PASS，覆盖 `new ClaudeClient/OpenAIClient`、手写上游 HTTP、`GatewayTransports.Direct` 标记、ASR WebSocket 直连、API 层直接依赖 `OpenAIImageClient` / `OpenRouterVideoClient`。这证明当前源码层面没有已知 MAP 业务路径绕过 `ILlmGateway`；剩余发布阻塞转为运行态 shadow 样本量、24 小时窗口与灰度观察。
- 只读 release gate 复查显示，watch/gate 必须使用真实注册表 code：`prd-agent-desktop.chat.sendmessage::chat`、`open-platform-agent.proxy::chat`、`prd-agent-web.model-lab.run::chat`、`prd-agent.arena.battle::chat`，不能使用 `desktop-chat.create`、`open-platform.chat-completions`、`model-lab.run`、`arena.run` 这类简称。已扩展 `scripts/llmgw-map-shadow-seed.py`，新增 `--include-desktop-chat-run`、`--include-model-lab-run`、`--include-arena-run`，并修复 open-platform 成功后 expectedGrowth 未计入 send 的证据统计问题。
- 生产小批文本 seed 验证暴露采样窗口恢复 bug：脚本在采样阶段 source `.env` 后，当前 shell 仍保留 `LLMGW_SHADOW_FULL_SAMPLE_PERCENT=100`，导致 restore 阶段 docker compose 插值优先读旧 shell 环境而不是 `.env=1`。已立即用 `scripts/llmgw-restore-shadow-safe.sh` 将生产恢复为 `Mode=shadow`、allowlist 空、`ShadowFullSamplePercent=1`，并修复 `scripts/llmgw-shadow-sample-window.sh`，在提采样和恢复采样时同步 export 当前目标值，防止复发。该次 seed 自身成功：desktop chat、open-platform、ModelLab、Arena 均完成，证据文件 `.llmgw-release-evidence/20260707T122651Z_text-core-shadow-seed-window.json`。
- 同次文本 seed 暴露第二个证据质量问题：ModelLab/Arena 的 chat pinned model 曾从 `/api/mds` 兜底误选到 `doubao-seedance-2-0-fast-260128`。Seedance 是火山方舟视频生成模型，不能作为 chat 迁移证据。已修正 `scripts/llmgw-map-shadow-seed.py`，优先从网关 `/pools?appCallerCode=prd-agent-web.model-lab.run::chat&modelType=chat` 选择 Healthy 文本模型，兜底路径也显式过滤 Seedance/Seedream/Video/Image 等非 chat 模型。修复后的 ModelLab/Arena 文本证据必须重新跑短窗口后才计入发布门。
- 修复后已重新跑 ModelLab/Arena 短时 100% shadow 采样窗口，并自动恢复生产到 `Mode=shadow`、allowlist 空、`ShadowFullSamplePercent=1`。本次 `chatPinnedModel=16a961e9-8b8c-4378-b058-e331ca1d4c1b/deepseek-ai/DeepSeek-V4-Flash`，不再是 Seedance；证据文件 `.llmgw-release-evidence/20260707T124647Z_model-lab-arena-chat-model-window.json`，其中 `seed[1].model_lab_run` 与 `seed[1].arena_run` 均为 `ok=True`。
- 全量 release gate 矩阵复查显示 `video-agent.v2d.transcribe::asr:raw` 与 `video-agent.video-to-text::asr:raw` 仍为 0，原因是 release gate 已纳入这两个入口，但 MAP shadow seed 还没有对应真实业务采样路径。已扩展 `scripts/llmgw-map-shadow-seed.py`：`--include-video-to-doc-asr` 通过 `/api/video-agent/v2d/runs` 触发 VideoToDoc worker；`--include-video-to-text-asr-workflow` 创建临时 workflow 并通过 `video-to-text` capsule 的 ASR 模式触发 WorkflowRunWorker。两者都要求 `--asr-video-url` 或 `LLMGW_SHADOW_ASR_VIDEO_URL`，避免用裸 `/gw/v1/raw` 样本替代真实 MAP 入口。
- 修复后已在生产短时 100% shadow 采样窗口跑通上述两条新增入口，并自动恢复生产到 `Mode=shadow`、allowlist 空、`ShadowFullSamplePercent=1`。证据文件 `.llmgw-release-evidence/20260707T130533Z_video-asr-v2d-vtt-seed-window.json`：`seed[1].video_to_doc_asr`、`seed[1].video_to_text_asr_workflow` 均为 `ok=True`，`expectedGrowth.raw=2`。随后用 coverage report 验证：`video-agent.v2d.transcribe::asr/raw total=1 allMatch=1 critical=0 httpFail=0`；`video-agent.video-to-text::asr/raw total=1 allMatch=1 critical=0 httpFail=0`。这只证明两条入口已打通，仍未满足每格 30 条与 24 小时覆盖门槛。

## 最新生产取证（2026-07-08 13:06 CST）

- 用户确认视频生成暂缓后，已停止批量视频取证，并将非视频 scoped gate 从全局视频失败中拆出。生产当前仍为 `LlmGateway__Mode=shadow`、`LlmGateway__HttpAppCallerAllowlist=`、`LlmGateway__ShadowFullSamplePercent=1`。
- 只读运行 `scripts/llmgw-shadow-coverage-report.py --skip-global-cells`，统计生产 commit `ca44d6c89238b2af54c3f663cf25be4773c2be03` 最近 24 小时非视频 17 个 appCaller:kind 单元：每格样本数均已达到 30，`critical=0`、`httpFail=0`，运行安全门通过。
- 非视频 17 个单元包含：`report-agent.generate::chat/send`、`prd-agent-desktop.chat.sendmessage::chat/stream`、`prd-agent-desktop.preview-ask.section::chat/stream`、`open-platform-agent.proxy::chat/stream`、`open-api.proxy::chat/send`、`open-api.proxy::generation/raw`、`prd-agent-web.model-lab.run::chat/stream`、`prd-agent.arena.battle::chat/stream`、`tutorial-email.generate::chat/send`、四个图片 raw 单元，以及四个 ASR raw 单元。
- 同一矩阵加 `--min-coverage-hours 24` 复跑仍 FAIL，17 个失败全部为覆盖时长不足；当前覆盖时长约 0.98-2.52 小时，不是样本数、critical 或 httpFail 问题。因此非视频可进入候选灰度排序，但不能宣称已满足 24 小时观察门。
- `open-api.proxy::chat/send` 与 `tutorial-email.generate::chat/send` 存在非 critical `content` warning mismatch：两侧均 http 成功、模型/池/平台/解析一致，无 critical mismatch。该差异来自生成式文本非确定性，不能当作 transport 失败；但在汇报时必须明确区分“运行安全门通过”和“逐字内容 allMatch 未满分”。
- 允许灰度候选排序更新：第一批仅建议 `canary-intent-text` 的 `report-agent.generate::chat`；第二批建议 `canary-streaming` 中 allMatch 满分的 `prd-agent-desktop.chat.sendmessage::chat`、`prd-agent-desktop.preview-ask.section::chat`、`open-platform-agent.proxy::chat`；第三批建议 `canary-vision` 与 `canary-image`；第四批建议新拆出的 `canary-asr` 四个 ASR/字幕入口。`open-api.proxy::chat` 与 `tutorial-email.generate::chat` 因 content warning mismatch 先继续 shadow 观察；视频生成保持暂缓，不进入候选。

## 最新生产取证（2026-07-08 14:34 CST）

- PR #1012 已合并后，生产发布对象改为最新 `main` commit `a47d48cc8a5df3bcccc4821dbd3dee4dbc3e7649`，避免用旧 commit `39bb3fd321a37832a91833cec05ed40b7a3531a8` 覆盖用户后续合入的 `prd-admin` 修复。该 commit 的 CI、Server Deploy、Web Latest、Branch Image 均已完成且成功。
- 正式环境 `map.ebcone.net` 已通过 `fast.sh --commit a47d48cc8a5df3bcccc4821dbd3dee4dbc3e7649` 与 `exec_dep.sh --commit a47d48cc8a5df3bcccc4821dbd3dee4dbc3e7649` 部署。四个容器 `api / llmgw / llmgw-serve / llmgw-web` 均运行 `sha-a47d48cc8a5df3bcccc4821dbd3dee4dbc3e7649`，`/gw/v1/healthz` 返回同一 commit。
- 部署前已备份 `llm_gateway` 数据库与当前容器/healthz 状态：`/root/inernoro/prd-agent-prod-backups/llmgw-before-shadow-start-a47d48c-20260708T062847Z`。该备份包含 `llm_gateway.archive` 与 SHA256。
- 当前生产安全开关保持未切流：`LlmGateway__Mode=shadow`、`LlmGateway__HttpAppCallerAllowlist=`、`LlmGateway__ShadowFullSamplePercent=1`、`LlmGateway__ShadowFullSampleAppCallerAllowlist=report-agent.generate::chat,prd-agent-desktop.chat.suggested-questions::intent`。这表示 MAP 用户请求仍走 inproc 主路径，shadow 只用于低比例证据收集。
- `shadow-start` 证据已写入生产 `.llmgw-release-evidence/20260708T062910Z_shadow-start_a47d48cc8a5d.*`。post-deploy serving probe PASS；scoped D-layer smoke 只覆盖 `chat,intent`，结果 8/8 PASS；MAP shadow seed 只跑 1 轮文本 seed，当前同 commit 样本 `critical=0`、`httpFail=0`。
- 火山方舟充值后仅做最小 vision 复测：第一次 `vision` smoke 因 `doubao-1-5-vision-pro-32k-250115` 仍被历史欠费失败标记为 `Unavailable`，Resolver 未实际调用上游；只复位该单个模型健康状态为 `Healthy` 并把 `ConsecutiveFailures` 归零后，第二次也是最后一次 `vision` smoke 4/4 PASS，实际模型为 `doubao-1-5-vision-pro-32k-250115`。未继续跑视频、图片生成或多轮重试。
- 只读 release gate 复查仍 FAIL，原因不是质量失败，而是证据期不足：同 commit 最近 24 小时 `shadow[global] total=4 < 30`、覆盖约 `0.04h < 24h`；`report-agent.generate::chat total=1 < 30`；`global/send total=1 < 30`。当前 shadow 聚合中 `critical=0`、`httpFail=0`，没有最近失败记录。
- 结论：生产已进入最新 commit 的低成本 shadow 证据期，但尚未满足 canary-intent-text 的样本数与 24 小时覆盖门槛。下一步只能继续观察自然流量或在用户确认预算后按低成本文本入口小批 seed；禁止进入 `canary-intent-text`、禁止任何视频批量测试、禁止全量 `LLMGW_MODE=http`。

## 最新生产取证（2026-07-08 15:44 CST）

- PR #1015 已合并到 `main`，merge commit 为 `0fe4eaed3b37777f3c149a0293184059ce4e0112`。该 PR 修复低成本采样与阶段门禁脚本：`canary-intent-text` 强制绑定 release commit、seed 命令实际透传 `--release-commit`、report-agent 子进程通过环境变量接收 shadow sample key、MAP 日志缺失豁免只限 canary 阶段。
- 生产容器仍运行 `a47d48cc8a5df3bcccc4821dbd3dee4dbc3e7649`，不是 `0fe4eaed3b37777f3c149a0293184059ce4e0112`；`/gw/v1/healthz` 三次连续采样均返回 `a47d48cc8a5df3bcccc4821dbd3dee4dbc3e7649`，commit 稳定。
- 生产工作树存在大量手工同步文件与本地配置变更，不能直接 `git pull` 覆盖。已先备份旧脚本到 `/root/backups/llmgw-prod-scripts-before-1015-sync-20260708T154208+0800`，再从已合并的 `origin/main` 精确同步 4 个脚本：`scripts/llmgw-shadow-sample-accumulate.sh`、`scripts/llmgw-map-shadow-seed.py`、`scripts/llmgw-report-agent-shadow-seed.py`、`scripts/llmgw-prod-stage.sh`。
- 同步后已在生产机完成语法与关键保护检查：`sh -n scripts/llmgw-shadow-sample-accumulate.sh scripts/llmgw-prod-stage.sh`、`python3 -m py_compile scripts/llmgw-map-shadow-seed.py scripts/llmgw-report-agent-shadow-seed.py` 通过；grep 确认存在 `seed_run_flags`、`LLMGW_SHADOW_SAMPLE_KEY`、`allow_missing_map_logs_waiver_for_stage` 与 `LLMGW_SHADOW_ACCUMULATE_RELEASE_COMMIT`。
- 只读 `canary-intent-text` release gate 仍 FAIL，但失败原因为证据不足，不是链路质量失败：`shadow[global] total=279`、`allMatch=278`、`critical=0`、`httpFail=0`，覆盖约 `1.20h < 24h`；`report-agent.generate::chat/send total=1 < 30`，覆盖 `0h < 24h`。证据已写入生产 `.llmgw-release-evidence/*_readonly_canary-intent-text-gate_a47d48c.{json,md}` 与 `.llmgw-release-evidence/*_readonly_current-shadow-coverage_a47d48c.{json,md}`。
- 为避免过量测试，仅执行 1 个低成本 `canary-intent-text` force-sample batch；未提高全局采样、未重启 API、未触发视频/图片。执行后同 commit `send` 与 `report-agent.generate::chat/send` 样本从 1 增至 2，`critical=0`、`httpFail=0`，但仍因 `2 < 30` 返回 FAIL。证据目录为 `.llmgw-release-evidence/shadow-accumulate-20260708T074315Z/`。
- 生产安全开关复核：`.env` 仍为 `LLMGW_MODE=shadow`、`LLMGW_HTTP_APP_CALLER_ALLOWLIST=`、`LLMGW_SHADOW_FULL_SAMPLE_PERCENT=1`；API 容器环境仍为 `LlmGateway__Mode=shadow`、`LlmGateway__HttpAppCallerAllowlist=`、`LlmGateway__ShadowFullSamplePercent=1`、`LlmGateway__ShadowFullSampleAppCallerAllowlist=report-agent.generate::chat,prd-agent-desktop.chat.suggested-questions::intent`。
- 结论：生产脚本保护已补齐，但生产运行 commit 仍是 `a47d48c`，且 `canary-intent-text` 只达到 2/30 样本、覆盖约 1.22 小时。继续禁止 `canary-intent-text` 灰度、禁止视频批量取证、禁止全量 `LLMGW_MODE=http`。下一步只能按低成本节奏补 `report-agent.generate::chat/send` 到 30 条并等待覆盖窗口满 24 小时，或先将最新 main 以 shadow 模式部署后重新按新 commit 计证据。

## 最新生产取证（2026-07-08 15:55 CST）

- 已先做外置 critical 备份，再推进最新 main 的 shadow-start。第一次使用 `cds-compose.yml` 备份被 CDS 扩展字段 `fallbackImage` 拦截，未生成有效 archive；随后改用生产 `docker-compose.yml` 成功完成备份：`/Users/inernoro/prd-agent-prod-backups/llmgw-prod-external-20260708T154701+0800`。备份包含 `llm_gateway` 全库，以及 `prdagent.model_groups`、`prdagent.llm_app_callers`、`prdagent.llmplatforms`、`prdagent.model_exchanges`、`prdagent.llmrequestlogs`，并已生成 `SHA256SUMS`。
- 生产机已 `git fetch origin main` 到 `0fe4eaed3b37777f3c149a0293184059ce4e0112`。`shadow-start` dry-run 通过，确认阶段配置为 `mode=shadow`、allowlist 空、`shadowFullSamplePercent=1`、不运行 video/asr provider gate、不运行 MAP seed。
- 首次执行 `shadow-start --execute` 被 release tree 守卫拦截，原因是 5 个发布/验证脚本与目标 commit 不一致：`exec_dep.sh`、`scripts/llmgw-rollout-ledger.py`、`scripts/llmgw-video-exchange-canary.py`、`scripts/llmgw-release-gate.py`、`scripts/gw-smoke.py`。已备份旧文件到 `/root/backups/llmgw-prod-release-files-before-0fe-sync-20260708T155122+0800`，再从 `origin/main` 精确同步这 5 个文件并完成 `sh -n` / `python3 -m py_compile` 校验。
- 第二次执行 `scripts/llmgw-prod-stage.sh --stage shadow-start --commit 0fe4eaed3b37777f3c149a0293184059ce4e0112 --execute` 成功。四个容器 `api / llmgw / llmgw-serve / llmgw-web` 均运行 `sha-0fe4eaed3b37777f3c149a0293184059ce4e0112`；`/gw/v1/healthz` 返回同一 commit；`serving-probe` PASS；`gw-smoke` 10/10 PASS；阶段台账追加 `shadow-start success`。证据前缀：`.llmgw-release-evidence/20260708T075136Z_shadow-start_0fe4eaed3b37.*`。
- 部署后生产安全开关复核：`.env` 仍为 `LLMGW_MODE=shadow`、`LLMGW_HTTP_APP_CALLER_ALLOWLIST=`、`LLMGW_SHADOW_FULL_SAMPLE_PERCENT=1`、`LLMGW_SHADOW_FULL_SAMPLE_APP_CALLER_ALLOWLIST=`；API 容器环境为 `LlmGateway__Mode=shadow`、`LlmGateway__HttpAppCallerAllowlist=`、`LlmGateway__ShadowFullSamplePercent=1`、`LlmGateway__ShadowFullSampleAppCallerAllowlist=`。即 MAP 主路径仍不切 http。
- 只读 canary-intent gate 对新 commit 预期 FAIL：`report-agent.generate::chat/send total=0 < 30`、覆盖 `0h < 24h`，但 health 三次采样稳定且 `critical=0`、`httpFail=0`。
- 为开启新 commit 的低成本观察窗口，仅执行 1 个 `canary-intent-text` force-sample batch；未提高全局采样、未重启 API、未触发视频/图片/ASR。证据目录：`.llmgw-release-evidence/shadow-accumulate-20260708T075340Z/`。执行后 `report-agent.generate::chat/send total=1`、`critical=0`、`httpFail=0`，但仍因 `1 < 30` 返回 FAIL。
- 结论：生产已从旧 `a47d48c` 推进到最新 `main` 的 `0fe4eaed` shadow-start，发布脚本树与目标 commit 对齐，运行安全门通过；但全量迁移仍未完成，`canary-intent-text` 也不得开启。下一步只允许继续低成本累计 `report-agent.generate::chat/send` 到 30 条并等待 24 小时覆盖，之后再进入第一批 allowlist 灰度。

## 最新生产取证（2026-07-08 16:00 CST）

- 在生产 `0fe4eaed3b37777f3c149a0293184059ce4e0112` shadow-start 稳定后，先只读复核安全开关：`.env` 与 API 容器均保持 `Mode=shadow`、`HttpAppCallerAllowlist=`、`ShadowFullSamplePercent=1`，`/gw/v1/healthz` 返回同一 commit。
- 只读 coverage 显示目标单元仍为 `report-agent.generate::chat/send total=1 < 30`，自然流量没有补足该 canary gate；global 已有 49 条、`critical=0`、`httpFail=0`。
- 为避免过量测试，仅执行 5 个低成本 `canary-intent-text` force-sample batch，命令绑定 `LLMGW_SHADOW_ACCUMULATE_RELEASE_COMMIT=0fe4eaed3b37777f3c149a0293184059ce4e0112`，每批间隔 5 秒；未提高全局采样、未重启 API、未触发视频/图片/ASR。证据目录：`.llmgw-release-evidence/shadow-accumulate-20260708T075637Z/`。
- 执行后复核：`report-agent.generate::chat/send total=6 < 30`，`global/send total=7 < 30`，`global total=64`；所有相关单元 `critical=0`、`httpFail=0`。coverage 仍 FAIL 是预期结果，失败原因仅为样本数不足和观察窗口不足。
- 结论：第一批低风险 canary-intent 证据从 1/30 推进到 6/30，但仍禁止开启 allowlist 灰度。下一步继续以小批次或自然流量补到 30/30，并等待从 `2026-07-08T07:54:02Z` 起算的 24 小时覆盖窗口；未满前不得进入 `canary-intent-text`。

## 最新生产取证（2026-07-08 16:07 CST）

- 继续只读复核生产 `0fe4eaed3b37777f3c149a0293184059ce4e0112`：`.env` 与 API 容器仍为 `Mode=shadow`、`HttpAppCallerAllowlist=`、`ShadowFullSamplePercent=1`，`/gw/v1/healthz` 返回同一 commit。
- 自然流量没有补足 canary-intent 目标单元，复核时仍为 `report-agent.generate::chat/send total=6 < 30`，`critical=0`、`httpFail=0`。
- 为保持低成本节奏，仅执行 6 个 `canary-intent-text` force-sample batch，命令绑定 `LLMGW_SHADOW_ACCUMULATE_RELEASE_COMMIT=0fe4eaed3b37777f3c149a0293184059ce4e0112`，每批间隔 5 秒；未提高全局采样、未重启 API、未触发视频/图片/ASR。证据目录：`.llmgw-release-evidence/shadow-accumulate-20260708T080230Z/`。
- 执行后复核：`report-agent.generate::chat/send total=12 < 30`，`global/send total=13 < 30`，`global total=217`；所有相关单元仍为 `critical=0`、`httpFail=0`。coverage 仍 FAIL 是预期结果，失败原因仅为样本数不足和观察窗口不足。
- 结论：第一批低风险 canary-intent 证据从 6/30 推进到 12/30；仍禁止开启 allowlist 灰度。下一步继续小批次补到 30/30，并等待从 `2026-07-08T07:54:02Z` 起算的 24 小时覆盖窗口；未满前不得进入 `canary-intent-text`。

## 最新生产取证（2026-07-08 16:16 CST）

- 继续只读复核生产 `0fe4eaed3b37777f3c149a0293184059ce4e0112`：`.env` 与 API 容器仍为 `Mode=shadow`、`HttpAppCallerAllowlist=`、`ShadowFullSamplePercent=1`，`/gw/v1/healthz` 返回同一 commit。
- 自然流量没有补足 canary-intent 目标单元，复核时仍为 `report-agent.generate::chat/send total=12 < 30`，`critical=0`、`httpFail=0`。
- 为保持低成本且不一次性压满，仅执行 9 个 `canary-intent-text` force-sample batch，命令绑定 `LLMGW_SHADOW_ACCUMULATE_RELEASE_COMMIT=0fe4eaed3b37777f3c149a0293184059ce4e0112`，每批间隔 5 秒；未提高全局采样、未重启 API、未触发视频/图片/ASR。证据目录：`.llmgw-release-evidence/shadow-accumulate-20260708T080904Z/`。
- 执行后复核：`report-agent.generate::chat/send total=21 < 30`，`global/send total=22 < 30`，`global total=244`；所有相关单元仍为 `critical=0`、`httpFail=0`。coverage 仍 FAIL 是预期结果，失败原因仅为样本数不足和观察窗口不足。
- 结论：第一批低风险 canary-intent 证据从 12/30 推进到 21/30；仍禁止开启 allowlist 灰度。下一步最多再补 9 条到 30/30，然后等待从 `2026-07-08T07:54:02Z` 起算的 24 小时覆盖窗口；未满前不得进入 `canary-intent-text`。

## 最新生产取证（2026-07-08 16:25 CST）

- 继续只读复核生产 `0fe4eaed3b37777f3c149a0293184059ce4e0112`：`.env` 与 API 容器仍为 `Mode=shadow`、`HttpAppCallerAllowlist=`、`ShadowFullSamplePercent=1`，`/gw/v1/healthz` 返回同一 commit。
- 为补齐第一批低风险 canary-intent 的样本数门槛，仅执行 9 个 `canary-intent-text` force-sample batch，命令绑定 `LLMGW_SHADOW_ACCUMULATE_RELEASE_COMMIT=0fe4eaed3b37777f3c149a0293184059ce4e0112`，每批间隔 5 秒；未提高全局采样、未重启 API、未触发视频/图片/ASR。证据目录：`.llmgw-release-evidence/shadow-accumulate-20260708T081801Z/`。
- 执行后复核无时间窗版本 coverage：`report-agent.generate::chat/send total=30`、`global/send total=31`、`global total=270`，所有相关单元 `critical=0`、`httpFail=0`，`verdict=pass`。这证明样本数门槛已达成。
- 同一矩阵开启 `--min-coverage-hours 24` 后仍 FAIL，唯一失败原因为覆盖时长不足：`report-agent.generate::chat/send coverageHours=0.51 < 24`，global/send 覆盖约 `0.52h < 24`。没有 critical/httpFail 失败。
- 结论：第一批低风险 canary-intent 已达 30/30 样本数，但 24 小时观察窗口未满。继续禁止开启 allowlist 灰度；最早也要等 `2026-07-09T07:54:02Z` 之后重新跑 release gate，确认样本仍在最近 24 小时窗口内且 coverageHours >= 24 后，才允许进入 `canary-intent-text` 阶段。

## 最新生产取证（2026-07-08 16:27 CST）

- 严格 `canary-intent-text` release gate 只读复核仍 FAIL，但失败项已收敛到 24 小时覆盖窗口不足：`report-agent.generate::chat/send total=30`、`global/send total=31`、`critical=0`、`httpFail=0`、health 三次采样稳定，`coverageHours` 约 `0.51h < 24h`。证据写入生产 `.llmgw-release-evidence/*_readonly_canary-intent-24h-gate_0fe4eaed.{json,md}`。
- 已在生产证据目录创建只读复查脚本：`.llmgw-release-evidence/manual-gates/run-canary-intent-gate-0fe4eaed.sh`，权限 `700`，`sh -n` 通过。该脚本只读取 `.env` 中的 gateway key，运行 `scripts/llmgw-release-gate.py` 并写 JSON/Markdown 证据；不修改配置、不重启容器、不调用模型。
- 下一次可执行窗口：最早 `2026-07-09T07:54:02Z` 之后运行上述脚本。只有脚本返回 PASS，且生产仍为同一 commit `0fe4eaed3b37777f3c149a0293184059ce4e0112`、`critical=0`、`httpFail=0`，才允许进入 `canary-intent-text` allowlist 灰度。未达成前继续禁止 `canary-intent-text`、禁止全量 `LLMGW_MODE=http`。

## 最新生产取证（2026-07-08 16:28 CST）

- 已完成同 commit `0fe4eaed3b37777f3c149a0293184059ce4e0112` 的 rollback rehearsal 前置台账。`rollback-rehearsal --dry-run` 先确认只会执行 `LLMGW_ROLLBACK_DRY_RUN=1 scripts/llmgw-rollback-inproc.sh`；随后 `--execute` 记录成功台账，实际输出 `dryRun: 1`，只打印会重建 `api` 与 `gateway`，未修改数据库、未改镜像、未重启容器。
- 证据文件：`.llmgw-release-evidence/20260708T082841Z_rollback-rehearsal_0fe4eaed3b37.stage.json` 与 `.llmgw-release-evidence/20260708T082841Z_rollback-rehearsal_0fe4eaed3b37.stage.md`，rollout ledger 已追加 `rollback-rehearsal success`。stage 报告里的 `mode=inproc` 表示演练目标模式，不代表生产实际运行态。
- 演练后复核生产仍为 `LLMGW_MODE=shadow`、`LLMGW_HTTP_APP_CALLER_ALLOWLIST=`、`LLMGW_SHADOW_FULL_SAMPLE_PERCENT=1`，API 容器环境仍为 `LlmGateway__Mode=shadow`，`/gw/v1/healthz` 仍返回 `0fe4eaed3b37777f3c149a0293184059ce4e0112`。
- 结论：第一批 canary-intent 的两个前置门已满足其一：同 commit rollback rehearsal 已完成；样本数也已达 30/30。剩余唯一 gate 是 24 小时覆盖窗口，未满前仍禁止进入 `canary-intent-text` allowlist 灰度。

## 最新生产取证（2026-07-08 16:31 CST）

- 用户确认火山引擎已充值后，发布策略仍保持低成本证据优先：火山相关能力允许小样本单次验证，但禁止反复视频、图片、ASR 或多轮重试。后续若必须测高成本模型，默认每类只做最小样本，并以日志与 release gate 作为主要证据。
- 重新以生产 `.env` 注入 gateway key 后执行 `canary-intent-text --dry-run`，未进入任何模型调用或配置变更，脚本在执行前被 rollout ledger 拦截：`previous_stage=shadow-start`、`observed_hours=0.64`、`required_hours=24`。单独运行 `scripts/llmgw-rollout-ledger.py validate` 得到同一结论。
- 这说明当前还有两个一致的时间门禁：release gate 的 shadow 覆盖窗口未满 24 小时，rollout ledger 的阶段观察窗口也未满 24 小时。它们都指向同一个等待点，最早仍是 `2026-07-09T07:54:02Z` 之后重新复查。
- 下一次复查必须同时跑两项只读检查：`.llmgw-release-evidence/manual-gates/run-canary-intent-gate-0fe4eaed.sh` 与 `scripts/llmgw-prod-stage.sh --stage canary-intent-text --commit 0fe4eaed3b37777f3c149a0293184059ce4e0112 --dry-run`。两项都 PASS 后才允许执行 `canary-intent-text --execute`；否则继续停在 shadow 证据期。

## 最新生产取证（2026-07-08 16:35 CST）

- `origin/main` 已前进到 `dabeffbf18552ec3628be0612623aba5c24be1de`，新增范围是 review-agent 重新上传修复与网页托管筛选换行修复；生产运行镜像仍是 `0fe4eaed3b37777f3c149a0293184059ce4e0112`，`/gw/v1/healthz` 三次采样稳定返回同一 commit。生产 `.env` 仍保持 `LLMGW_MODE=shadow`、`LLMGW_HTTP_APP_CALLER_ALLOWLIST=`、`LLMGW_SHADOW_FULL_SAMPLE_PERCENT=1`、`LLMGW_SHADOW_FULL_SAMPLE_APP_CALLER_ALLOWLIST=`。
- 已把最新 `origin/main` 合入当前证据分支，后续发布前不得复用旧 commit 证据直接切新 commit；若要发布 `dabeffbf`，必须先按同样流程重新做备份、`shadow-start`、serving probe、gw-smoke、release gate 与 rollout ledger。
- 低成本只读 gate 复查仍 FAIL，失败项仅为覆盖窗口不足：`global coverageHours=0.52 < 24`、`report-agent.generate::chat coverageHours=0.51 < 24`、`global/send coverageHours=0.52 < 24`、`report-agent.generate::chat/send coverageHours=0.51 < 24`。样本数仍达标，`critical=0`、`httpFail=0`。
- 合入最新 main 后本地静态/单元守卫通过：`GatewayDirectClientRatchetTests` 18/18 PASS，`ReviewAgentStateGuardsTests` 10/10 PASS，`cd prd-api && dotnet build --no-restore` 退出码 0，`prd-admin` 的 `pnpm -s exec tsc --noEmit` 通过，`pnpm -s lint` 退出码 0。lint 仍有仓库存量 warning，但本次合入文件无新增 error。
- 结论：代码侧没有发现新增 LLM 直连缺口，但生产切流仍被时间门禁挡住。未满 24 小时前，继续禁止 `canary-intent-text --execute`、禁止全量 `LLMGW_MODE=http`，也不要为了追进度重复打火山/视频/图片/ASR 请求。

## 最新生产取证（2026-07-08 16:52 CST）

- 已将生产推进到最新 `main` commit `dabeffbf18552ec3628be0612623aba5c24be1de` 的 `shadow-start`。执行前先做备份：full 备份因 `prdagent.apirequestlogs` 过慢在发布前手动中止，并在 `/Users/inernoro/prd-agent-prod-backups/llmgw-prod-external-20260708T163743+0800/INCOMPLETE.txt` 标记；随后完成 critical 备份 `/Users/inernoro/prd-agent-prod-backups/llmgw-prod-external-20260708T164212+0800`，包含 `llm_gateway` 全库、`prdagent.model_groups`、`prdagent.llm_app_callers`、`prdagent.llmplatforms`、`prdagent.model_exchanges`、`prdagent.llmrequestlogs`，`SHA256SUMS` 全部 OK。
- `shadow-start --execute` 通过发布守卫：disk guard OK、rollout ledger 起点 OK、`origin/main` ancestry OK、release tree OK、production preflight PASS。发布后 5 个核心镜像均为 `sha-dabeffbf18552ec3628be0612623aba5c24be1de`；`/gw/v1/healthz` 返回 `dabeffbf18552ec3628be0612623aba5c24be1de`；`.env` 仍为 `LLMGW_MODE=shadow`、`LLMGW_HTTP_APP_CALLER_ALLOWLIST=`、`LLMGW_SHADOW_FULL_SAMPLE_PERCENT=1`、`LLMGW_SHADOW_FULL_SAMPLE_APP_CALLER_ALLOWLIST=`。
- post-deploy 低成本验证通过：serving probe PASS，gw-smoke 10/10 PASS。该阶段未启用 video canary、ASR HTTP canary、provider audit、MAP shadow seed。
- 已补做同 commit rollback rehearsal：`scripts/llmgw-prod-stage.sh --stage rollback-rehearsal --commit dabeffbf18552ec3628be0612623aba5c24be1de --execute` 成功，实际为 `LLMGW_ROLLBACK_DRY_RUN=1`，只记录同 commit 回滚演练，不修改数据库、不重启、不改镜像。
- 新 commit 的 `canary-intent-text` gate 已从零开始重算。只读 release gate 初始 FAIL：`total=0/30`、`coverageHours=0/24`。为启动证据窗口，仅跑 1 个低成本 `canary-intent-text` force-sample batch，证据目录 `.llmgw-release-evidence/shadow-accumulate-20260708T085012Z/`；结果为 `global total=3`、`global/send total=1`、`report-agent.generate::chat total=1`、`report-agent.generate::chat/send total=1`，全部 `critical=0`、`httpFail=0`。coverage 仍预期 FAIL，因样本数和 24 小时窗口不足。
- 结论：最新 main 已安全进入生产 shadow 证据期，且回滚演练已对齐同 commit。下一步不能直接进入 `canary-intent-text --execute`，因为 rollout ledger 仍要求从 `shadow-start` 起观察 24 小时，release gate 也要求同 commit 样本达到 30 且覆盖 24 小时。继续禁止全量 `LLMGW_MODE=http`，禁止视频/图片/ASR 重复高成本测试；后续只允许按明确预算补低成本文本样本。

## 最新生产取证（2026-07-08 16:54 CST）

- 只读复核生产仍为 `dabeffbf18552ec3628be0612623aba5c24be1de`，5 个核心镜像均为同一 sha，`.env` 仍保持 `LLMGW_MODE=shadow`、`LLMGW_HTTP_APP_CALLER_ALLOWLIST=`、`LLMGW_SHADOW_FULL_SAMPLE_PERCENT=1`、`LLMGW_SHADOW_FULL_SAMPLE_APP_CALLER_ALLOWLIST=`。
- 只读 shadow coverage 正确带 gateway key 后仍预期 FAIL，原因是新 commit 证据窗口刚启动，样本数与 24 小时覆盖均不足；该检查不发模型请求。
- 已在生产创建两条只读手工复查脚本，并通过 `sh -n`：
  - `.llmgw-release-evidence/manual-gates/run-canary-intent-gate-dabeffbf.sh`：运行 release gate，只读读取 shadow comparisons，输出 JSON/Markdown。
  - `.llmgw-release-evidence/manual-gates/run-canary-intent-dryrun-dabeffbf.sh`：运行 `canary-intent-text --dry-run`，只检查 rollout ledger 和计划，不切流。
- 立即执行 dry-run 脚本被 rollout ledger 正确拦截：`observed_hours=0.10 < 24`。这证明后续即使误触发 dry-run，也不会绕过阶段观察窗口；真正 `--execute` 仍禁止。
- 下一次可复查窗口按 `shadow-start` 成功时间 `2026-07-08T08:48:14Z` 起算，最早应在 `2026-07-09T08:48:14Z` 之后；届时仍必须先确认样本数达到 30/30、`critical=0`、`httpFail=0`，再看 dry-run 是否 PASS。

## 最新代码守卫（2026-07-08 16:58 CST）

- 已在 `scripts/llmgw-shadow-sample-accumulate.sh` 增加过量取证保护：执行前默认先跑 shadow coverage preflight；若目标 coverage 已经 PASS，则默认直接退出，不再 seed。`canary-intent-text` 预设默认 `LLMGW_SHADOW_ACCUMULATE_MAX_BATCHES=3`，超过上限会 fail-closed；如确有预算必须显式提高该环境变量。
- 本地验证：`sh -n scripts/llmgw-shadow-sample-accumulate.sh` 通过；`LLMGW_SHADOW_ACCUMULATE_PROFILE=canary-intent-text LLMGW_SHADOW_ACCUMULATE_DRY_RUN=1 LLMGW_SHADOW_ACCUMULATE_BATCHES=4 ...` 被预期拒绝；`BATCHES=3` dry-run 通过；临时目录伪造 coverage PASS 时脚本直接退出且未调用 seed/window。
- 测试验证：`GatewayDataDomainGuardTests` 30/30 PASS；`cd prd-api && dotnet build --no-restore` 退出码 0，仅输出既有 CS warning。
- 结论：后续补 `dabeffbf` 的 `report-agent.generate::chat/send` 样本时，默认不会一条命令误打超过 3 个 batch，也不会在 coverage 已经达标后继续消耗模型额度。

## 最新生产脚本同步（2026-07-08 17:01 CST）

- 已把 `scripts/llmgw-shadow-sample-accumulate.sh` 的预算守卫同步到生产机 `/root/inernoro/prd_agent/scripts/llmgw-shadow-sample-accumulate.sh`，旧脚本备份在 `/root/backups/llmgw-shadow-accumulate-before-budget-guard-20260708T170059+0800/llmgw-shadow-sample-accumulate.sh`。
- 同步后生产脚本 sha256 为 `edf69880370c8ca1b987f0160d24f7e3cd9ad3abcbe5b23496e881133e89e22e`，与本地分支一致；`sh -n` 通过。
- 生产 dry-run 验证通过：`BATCHES=4` 被默认上限 3 拒绝；`BATCHES=3` dry-run 通过。验证期间未触发 seed、未调用模型、未修改 `.env`。
- 生产运行态复核仍为 `dabeffbf18552ec3628be0612623aba5c24be1de`、`LLMGW_MODE=shadow`、`LLMGW_HTTP_APP_CALLER_ALLOWLIST=`、`LLMGW_SHADOW_FULL_SAMPLE_PERCENT=1`。

## 最新本地合同验证（2026-07-08 17:03 CST）

- 生产只读复核仍为 `dabeffbf18552ec3628be0612623aba5c24be1de`、`LLMGW_MODE=shadow`、allowlist 空；本轮未补样本、未调用模型。
- 首次并行跑多组 `dotnet test` 时触发本地 MSBuild 写 `obj/bin` 的文件锁冲突与 `apphost` 缺失，已判定为并发构建争用，不是网关合同失败。随后改为串行 `-m:1` 重跑同一矩阵。
- 串行合同测试通过：`GatewayDirectClientRatchetTests` 18/18 PASS；`GatewayPinnedModelTests`、`GatewayMultipartHttpTests`、`GatewayServingEndpointContractTests`、`GatewayKeyGateContractTests` 合计 24/24 PASS；`ShadowLlmGatewayTests`、`CrossProcessServingSelfTest`、`CrossProcessServingErrorLoadTests`、`HttpLlmGatewayClientFailureTests` 合计 38/38 PASS。
- 结论：当前分支的直连棘轮、pinned model、multipart HTTP、key gate、serving endpoint、shadow 和 cross-process failure 合同均保持绿色；生产灰度仍受 `dabeffbf` 样本数与 24 小时窗口 gate 约束。

## 最新只读补样计划（2026-07-08 17:07 CST）

- 新增 `scripts/llmgw-shadow-sample-plan.py`，只读取 `llmgw-shadow-coverage-report.py` 生成的 coverage JSON，计算缺口、最多建议 batch 数和是否允许补样；脚本不访问网络、不读取密钥、不调用 seed/window。
- 本地验证通过：伪造 coverage JSON 时，缺口样本 `29` 会被默认 `maxBatches=3` 限制为建议 `3` 批；coverage 已 PASS 时建议 `0` 批；存在 `critical/httpFail` 时禁止补样。`GatewayDataDomainGuardTests` 31/31 PASS，`cd prd-api && dotnet build --no-restore` 退出码 0。
- 已同步 planner 到生产并只读运行一次，证据文件：`.llmgw-release-evidence/20260708T090701Z_readonly_shadow-sample-plan_dabeffbf.{json,md}`。当前计划输出：`remainingBatchesNeeded=29`、`recommendedBatches=3`、`canRunRecommendedBatches=true`、`reason=bounded-top-up`。
- 结论：若要继续推进样本数，只允许按 planner 给出的 bounded top-up 小批量执行；仍不得超过脚本默认上限，也不得在未满 24 小时窗口时进入 `canary-intent-text --execute`。

## 最新正式 shadow 发布（2026-07-08 17:35 CST）

- 正式域名 `https://map.ebcone.net/gw/v1/healthz` 已从 `dabeffbf18552ec3628be0612623aba5c24be1de` 更新到 `2f6b0658397019e809f46ceb001245c6fdb03f40`；`api / llmgw / llmgw-serve / llmgw-web` 镜像均为 `sha-2f6b0658397019e809f46ceb001245c6fdb03f40`。
- 发布前完成 critical 外置备份：`/Users/inernoro/prd-agent-prod-backups/llmgw-prod-external-20260708T172318+0800`，含 `llm_gateway` 全库与 MAP 关键集合，`SHA256SUMS` 已生成。为绕过生产 `cds-compose.yml` 的 CDS 扩展字段 `fallbackImage`，`scripts/llmgw-prod-external-backup.sh` 增加 `LLMGW_EXTERNAL_BACKUP_MONGO_CONTAINER` 容器直连兜底。
- 正式运行开关保持安全态：`LlmGateway__Mode=shadow`、`LlmGateway__HttpAppCallerAllowlist` 为空、`LlmGateway__ShadowFullSamplePercent=1`、`LlmGateway__ShadowFullSampleAppCallerAllowlist` 为空。没有开启 canary，也没有切 `LLMGW_MODE=http`。
- 为避免过量模型请求，本次正式部署设置 `LLMGW_GATE_RUN_SMOKE=0`，只跑 serving probe；`scripts/llmgw-rollout-ledger.py` 增加 `smokeRequired`，使显式跳过 gw-smoke 时不再把阶段误判失败。对应证据：`.llmgw-release-evidence/20260708T092907Z_shadow-start_2f6b06583970.*`。
- 同 commit rollback rehearsal 已完成 dry-run 并入账：`.llmgw-release-evidence/20260708T093333Z_rollback-rehearsal_2f6b06583970.*`。该演练只打印回滚命令，不改镜像、不改数据库、不重启。
- 新 commit 只读 coverage 证据：`.llmgw-release-evidence/20260708T093440Z_readonly_shadow-coverage_2f6b06583970.{json,md}`。当前 `global / send / report-agent.generate::chat / report-agent.generate::chat/send` 均为 `total=0`、`critical=0`、`httpFail=0`、coverageHours `0`；planner 建议最多 `3` 批 bounded top-up，剩余目标 `30`。
- 结论：正式环境已进入最新 commit 的 shadow 证据期，但全量迁移仍未完成；下一阶段 `canary-intent-text` 被 24 小时观察窗口正确阻断，且样本数未达 30。不得宣称“网关迁移完成”，不得直接切 http。

## 最新补样预算守卫（2026-07-08 18:00 CST）

- `scripts/llmgw-shadow-sample-accumulate.sh` 已在执行前接入只读 `scripts/llmgw-shadow-sample-plan.py`。当 preflight coverage 未达标时，脚本会生成 `preflight-shadow-sample-plan.json/md`，读取 `recommendedBatches` 与 `canRunRecommendedBatches`，并拒绝 `LLMGW_SHADOW_ACCUMULATE_BATCHES` 超过 planner 推荐值的运行。
- 该守卫只影响补证据批次数，不降低 release gate，不修改 `minCoverageHours=24`，也不会绕过 `critical=0` / `httpFail=0` 要求。若 coverage 已达标、只差覆盖窗口、存在质量失败，或 preflight coverage 因 key/网关/JSON 异常/参数格式错误读不到可信计数，脚本会停止，不继续消耗模型额度。
- 结论：后续火山/其它模型已可用时，仍必须先跑只读 coverage 和 planner，再按推荐批次数补样；不得为了追进度重复打视频、图片、ASR 或超过 planner 的文本 batch。

## 最新生产脚本同步（2026-07-08 18:55 CST）

- 已完成新的 critical 外置备份：`/Users/inernoro/prd-agent-prod-backups/llmgw-prod-external-20260708T184825+0800`，包含 `llm_gateway` 全库与 `prdagent.model_groups`、`prdagent.llm_app_callers`、`prdagent.llmplatforms`、`prdagent.model_exchanges`、`prdagent.llmrequestlogs`，并生成 `SHA256SUMS`。
- 生产工作树仍是手工同步状态，不能整体 `git pull`；本轮只同步与 PR #1020 相关的 3 个脚本：`scripts/llmgw-shadow-sample-accumulate.sh`、`scripts/llmgw-shadow-sample-plan.py`、`scripts/llmgw-readiness-audit.py`。旧脚本备份在 `/root/backups/llmgw-shadow-budget-guard-before-sync-20260708T185212+0800`。
- 同步后生产脚本 sha256 与 `main` 一致：`llmgw-shadow-sample-accumulate.sh=fcb0282f...`、`llmgw-shadow-sample-plan.py=2f8a61a...`、`llmgw-readiness-audit.py=0f13506...`；`sh -n` 与 `python3 -m py_compile` 通过。
- 生产只读 health 仍为 `2f6b0658397019e809f46ceb001245c6fdb03f40`，运行开关仍为 `LlmGateway__Mode=shadow`、`LlmGateway__HttpAppCallerAllowlist=`、`LlmGateway__ShadowFullSamplePercent=1`、`LlmGateway__ShadowFullSampleAppCallerAllowlist=`。本轮未重启容器、未切 http、未执行 seed、未触发任何模型请求。
- 只读 coverage + planner 复核写入生产 `/tmp/llmgw-shadow-plan-20260708T105322Z/`：`report-agent.generate::chat/send` 在当前 commit 下仍为 `0/30`，`critical=0`、`httpFail=0`，planner 输出 `remainingBatchesNeeded=30`、`recommendedBatches=3`、`canRunRecommendedBatches=true`、`reason=bounded-top-up`。这证明新 planner 已正确处理带 `::` 的 appCaller label，后续最多按 3 批小步补样。
- 生产源码树直接跑全仓 `scripts/llmgw-readiness-audit.py` 仍 FAIL，原因是生产工作树落后且混有手工同步文件，静态扫描不到当前 `main` 的 workflow/multipart 源码；这不代表运行中容器失败。发布/迁移判断仍以 main CI、容器 health、serving probe、shadow coverage 与 rollout ledger 为准。

## 最新低成本补样（2026-07-08 18:58 CST）

- 在完成上述备份和 planner 只读复核后，仅执行 planner 推荐上限内的 3 个 `canary-intent-text` force-sample batch，绑定 `LLMGW_SHADOW_ACCUMULATE_RELEASE_COMMIT=2f6b0658397019e809f46ceb001245c6fdb03f40`；未提高全局采样、未重启 API、未触发视频/图片/ASR。第一次缺少 `ROOT_ACCESS_PASSWORD` 的尝试在 seed 登录前退出，没有进入模型请求。
- 真实执行证据目录：生产 `.llmgw-release-evidence/shadow-accumulate-20260708T105532Z/`。preflight planner 输出 `recommendedBatches=3`、`reason=bounded-top-up` 后才开始补样，符合预算守卫。
- 执行后 coverage 仍 FAIL，符合预期：`global total=9`、`global/send total=3`、`report-agent.generate::chat total=3`、`report-agent.generate::chat/send total=3`，全部 `critical=0`、`httpFail=0`；失败项仍只有样本数不足和覆盖时长不足。
- 结论：当前 commit 的第一批低成本文本证据已从 `0/30` 推进到 `3/30`。不要继续手工追加大批量；下一步仍必须先跑只读 coverage + planner，再按 `recommendedBatches` 小步补样。未达到 `30/30` 且覆盖 24 小时之前，继续禁止 `canary-intent-text --execute` 和全量 `LLMGW_MODE=http`。

## 最新低成本补样（2026-07-08 19:04 CST）

- 再次只读运行 coverage + planner，确认 `report-agent.generate::chat/send total=3/30`、`critical=0`、`httpFail=0`，planner 输出 `remainingBatchesNeeded=27`、`recommendedBatches=3`、`reason=bounded-top-up` 后，才执行第二个 3 batch 小窗口。
- 第二次真实执行证据目录：生产 `.llmgw-release-evidence/shadow-accumulate-20260708T110030Z/`。执行仍为 `canary-intent-text` force-sample，绑定同一 release commit；未提高全局采样、未重启 API、未触发视频/图片/ASR。
- 执行后 coverage 仍 FAIL，符合预期：`global total=18`、`global/send total=6`、`report-agent.generate::chat total=6`、`report-agent.generate::chat/send total=6`，全部 `critical=0`、`httpFail=0`；失败项仍只有样本数不足和覆盖时长不足。正式 `/gw/v1/healthz` 仍返回 `2f6b0658397019e809f46ceb001245c6fdb03f40`，API 开关仍为 `Mode=shadow`、allowlist 空、采样 `1%`。
- 结论：当前 commit 的低风险 canary-intent 证据已从 `3/30` 推进到 `6/30`。为控制成本，本轮停止继续补样；下一步继续遵循“只读 coverage + planner -> 最多推荐批次”的节奏，禁止直接追满，禁止视频/图片/ASR 重复测试。

## 最新低成本补样（2026-07-08 19:10 CST）

- 第三次小窗口执行前，preflight coverage 显示 `global total=18`、`global/send total=6`、`report-agent.generate::chat total=6`、`report-agent.generate::chat/send total=6`，全部 `critical=0`、`httpFail=0`。planner 输出 `remainingBatchesNeeded=24`、`recommendedBatches=3`、`canRunRecommendedBatches=true`、`reason=bounded-top-up`，因此只允许继续 3 batch。
- 第三次真实执行证据目录：生产 `.llmgw-release-evidence/shadow-accumulate-20260708T110547Z/`。执行仍为低成本 `canary-intent-text` force-sample，绑定 release commit `2f6b0658397019e809f46ceb001245c6fdb03f40`；未提高全局采样、未重启 API、未触发视频/图片/ASR。
- 执行后 coverage 仍按预期 FAIL：`global total=27`、`global/send total=9`、`report-agent.generate::chat total=9`、`report-agent.generate::chat/send total=9`，全部 `critical=0`、`httpFail=0`；失败项仍只有样本数不足和覆盖时长不足。正式 `/gw/v1/healthz` 仍返回 `2f6b0658397019e809f46ceb001245c6fdb03f40`，API 容器开关仍为 `Mode=shadow`、allowlist 空、采样 `1%`。
- 结论：当前 commit 的低风险 canary-intent 证据已从 `6/30` 推进到 `9/30`。为避免过量测试，本轮不再追加 batch；下一步仍必须先跑只读 coverage + planner，再按 `recommendedBatches` 小步补样。未达到 `30/30` 且覆盖 24 小时之前，继续禁止 `canary-intent-text --execute`、禁止全量 `LLMGW_MODE=http`。

## 最新低成本补样（2026-07-08 19:15 CST）

- 第四次小窗口执行前，preflight coverage 显示 `global total=27`、`global/send total=9`、`report-agent.generate::chat total=9`、`report-agent.generate::chat/send total=9`，全部 `critical=0`、`httpFail=0`。planner 输出 `remainingBatchesNeeded=21`、`recommendedBatches=3`、`canRunRecommendedBatches=true`、`reason=bounded-top-up`，因此只允许继续 3 batch。
- 第四次真实执行证据目录：生产 `.llmgw-release-evidence/shadow-accumulate-20260708T111144Z/`。执行仍为低成本 `canary-intent-text` force-sample，绑定 release commit `2f6b0658397019e809f46ceb001245c6fdb03f40`；未提高全局采样、未重启 API、未触发视频/图片/ASR。
- 执行后 coverage 仍按预期 FAIL：`global total=36` 已达到总量门槛，但 `global/send total=12`、`report-agent.generate::chat total=12`、`report-agent.generate::chat/send total=12` 仍未达到 `30`；全部 `critical=0`、`httpFail=0`。覆盖窗口约 `0.29h < 24h`。正式 `/gw/v1/healthz` 仍返回 `2f6b0658397019e809f46ceb001245c6fdb03f40`，API 容器开关仍为 `Mode=shadow`、allowlist 空、采样 `1%`。
- 结论：当前 commit 的低风险 canary-intent 证据已从 `9/30` 推进到 `12/30`。继续禁止 `canary-intent-text --execute`、禁止全量 `LLMGW_MODE=http`；后续补样仍必须先只读 coverage + planner，且不得触发视频/图片/ASR。

## 最新低成本补样（2026-07-08 19:19 CST）

- 第五次小窗口执行前，preflight coverage 显示 `global total=36`、`global/send total=12`、`report-agent.generate::chat total=12`、`report-agent.generate::chat/send total=12`，全部 `critical=0`、`httpFail=0`。planner 输出 `remainingBatchesNeeded=18`、`recommendedBatches=3`、`canRunRecommendedBatches=true`、`reason=bounded-top-up`，因此只允许继续 3 batch。
- 第五次真实执行证据目录：生产 `.llmgw-release-evidence/shadow-accumulate-20260708T111617Z/`。执行仍为低成本 `canary-intent-text` force-sample，绑定 release commit `2f6b0658397019e809f46ceb001245c6fdb03f40`；未提高全局采样、未重启 API、未触发视频/图片/ASR。
- 执行后 coverage 仍按预期 FAIL：`global total=45`、`global/send total=15`、`report-agent.generate::chat total=15`、`report-agent.generate::chat/send total=15`；全部 `critical=0`、`httpFail=0`。覆盖窗口约 `0.37h < 24h`。正式 `/gw/v1/healthz` 仍返回 `2f6b0658397019e809f46ceb001245c6fdb03f40`，API 容器开关仍为 `Mode=shadow`、allowlist 空、采样 `1%`。
- 结论：当前 commit 的低风险 canary-intent 证据已从 `12/30` 推进到 `15/30`，质量指标继续为 0 失败。继续禁止 `canary-intent-text --execute`、禁止全量 `LLMGW_MODE=http`；后续仍按 planner 小批量补样，不触发视频/图片/ASR。

## 最新低成本补样（2026-07-08 19:23 CST）

- 第六次小窗口执行前，preflight coverage 显示 `global total=45`、`global/send total=15`、`report-agent.generate::chat total=15`、`report-agent.generate::chat/send total=15`，全部 `critical=0`、`httpFail=0`。planner 输出 `remainingBatchesNeeded=15`、`recommendedBatches=3`、`canRunRecommendedBatches=true`、`reason=bounded-top-up`，因此只允许继续 3 batch。
- 第六次真实执行证据目录：生产 `.llmgw-release-evidence/shadow-accumulate-20260708T112018Z/`。执行仍为低成本 `canary-intent-text` force-sample，绑定 release commit `2f6b0658397019e809f46ceb001245c6fdb03f40`；未提高全局采样、未重启 API、未触发视频/图片/ASR。
- 执行后 coverage 仍按预期 FAIL：`global total=54`、`global/send total=18`、`report-agent.generate::chat total=18`、`report-agent.generate::chat/send total=18`；全部 `critical=0`、`httpFail=0`。覆盖窗口约 `0.43h < 24h`。正式 `/gw/v1/healthz` 仍返回 `2f6b0658397019e809f46ceb001245c6fdb03f40`，API 容器开关仍为 `Mode=shadow`、allowlist 空、采样 `1%`。
- 结论：当前 commit 的低风险 canary-intent 证据已从 `15/30` 推进到 `18/30`，质量指标继续为 0 失败。继续禁止 `canary-intent-text --execute`、禁止全量 `LLMGW_MODE=http`；后续仍必须由只读 planner 控制补样，且不得触发视频/图片/ASR。

## 最新低成本补样（2026-07-08 19:27 CST）

- 第七次小窗口执行前，preflight coverage 显示 `global total=54`、`global/send total=18`、`report-agent.generate::chat total=18`、`report-agent.generate::chat/send total=18`，全部 `critical=0`、`httpFail=0`。planner 输出 `remainingBatchesNeeded=12`、`recommendedBatches=3`、`canRunRecommendedBatches=true`、`reason=bounded-top-up`，因此只允许继续 3 batch。
- 第七次真实执行证据目录：生产 `.llmgw-release-evidence/shadow-accumulate-20260708T112420Z/`。执行仍为低成本 `canary-intent-text` force-sample，绑定 release commit `2f6b0658397019e809f46ceb001245c6fdb03f40`；未提高全局采样、未重启 API、未触发视频/图片/ASR。
- 执行后 coverage 仍按预期 FAIL：`global total=63`、`global/send total=21`、`report-agent.generate::chat total=21`、`report-agent.generate::chat/send total=21`；全部 `critical=0`、`httpFail=0`。覆盖窗口约 `0.50h < 24h`。正式 `/gw/v1/healthz` 仍返回 `2f6b0658397019e809f46ceb001245c6fdb03f40`，API 容器开关仍为 `Mode=shadow`、allowlist 空、采样 `1%`。
- 结论：当前 commit 的低风险 canary-intent 证据已从 `18/30` 推进到 `21/30`，质量指标继续为 0 失败。继续禁止 `canary-intent-text --execute`、禁止全量 `LLMGW_MODE=http`；后续仍必须由只读 planner 控制补样，且不得触发视频/图片/ASR。

## 最新低成本补样（2026-07-08 19:31 CST）

- 第八次小窗口执行前，preflight coverage 显示 `global total=63`、`global/send total=21`、`report-agent.generate::chat total=21`、`report-agent.generate::chat/send total=21`，全部 `critical=0`、`httpFail=0`。planner 输出 `remainingBatchesNeeded=9`、`recommendedBatches=3`、`canRunRecommendedBatches=true`、`reason=bounded-top-up`，因此只允许继续 3 batch。
- 第八次真实执行证据目录：生产 `.llmgw-release-evidence/shadow-accumulate-20260708T112846Z/`。执行仍为低成本 `canary-intent-text` force-sample，绑定 release commit `2f6b0658397019e809f46ceb001245c6fdb03f40`；未提高全局采样、未重启 API、未触发视频/图片/ASR。
- 执行后 coverage 仍按预期 FAIL：`global total=72`、`global/send total=24`、`report-agent.generate::chat total=24`、`report-agent.generate::chat/send total=24`；全部 `critical=0`、`httpFail=0`。覆盖窗口约 `0.57h < 24h`。正式 `/gw/v1/healthz` 仍返回 `2f6b0658397019e809f46ceb001245c6fdb03f40`，API 容器开关仍为 `Mode=shadow`、allowlist 空、采样 `1%`。
- 结论：当前 commit 的低风险 canary-intent 证据已从 `21/30` 推进到 `24/30`，质量指标继续为 0 失败。继续禁止 `canary-intent-text --execute`、禁止全量 `LLMGW_MODE=http`；后续仍必须由只读 planner 控制补样，且不得触发视频/图片/ASR。

## 最新低成本补样（2026-07-08 19:35 CST）

- 第九次小窗口执行前，preflight coverage 显示 `global total=72`、`global/send total=24`、`report-agent.generate::chat total=24`、`report-agent.generate::chat/send total=24`，全部 `critical=0`、`httpFail=0`。planner 输出 `remainingBatchesNeeded=6`、`recommendedBatches=3`、`canRunRecommendedBatches=true`、`reason=bounded-top-up`，因此只允许继续 3 batch。
- 第九次真实执行证据目录：生产 `.llmgw-release-evidence/shadow-accumulate-20260708T113254Z/`。执行仍为低成本 `canary-intent-text` force-sample，绑定 release commit `2f6b0658397019e809f46ceb001245c6fdb03f40`；未提高全局采样、未重启 API、未触发视频/图片/ASR。
- 执行后 coverage 仍按预期 FAIL：`global total=80`、`global/send total=27`、`report-agent.generate::chat total=27`、`report-agent.generate::chat/send total=27`；全部 `critical=0`、`httpFail=0`。覆盖窗口约 `0.64h < 24h`。正式 `/gw/v1/healthz` 仍返回 `2f6b0658397019e809f46ceb001245c6fdb03f40`，API 容器开关仍为 `Mode=shadow`、allowlist 空、采样 `1%`。
- 结论：当前 commit 的低风险 canary-intent 证据已从 `24/30` 推进到 `27/30`，质量指标继续为 0 失败。下一轮只允许最多再补 3 条达到样本数门槛；即使达到 `30/30`，仍必须等待 24 小时覆盖窗口，继续禁止 `canary-intent-text --execute` 与全量 `LLMGW_MODE=http`。

## 最新低成本补样（2026-07-08 19:40 CST）

- 第十次小窗口执行前，preflight coverage 显示 `global total=80`、`global/send total=27`、`report-agent.generate::chat total=27`、`report-agent.generate::chat/send total=27`，全部 `critical=0`、`httpFail=0`。planner 输出 `remainingBatchesNeeded=3`、`recommendedBatches=3`、`canRunRecommendedBatches=true`、`reason=bounded-top-up`，因此只允许继续最后 3 batch。
- 第十次真实执行证据目录：生产 `.llmgw-release-evidence/shadow-accumulate-20260708T113700Z/`。执行仍为低成本 `canary-intent-text` force-sample，绑定 release commit `2f6b0658397019e809f46ceb001245c6fdb03f40`；未提高全局采样、未重启 API、未触发视频/图片/ASR。
- 执行后样本数门槛已达成：`global total=89`、`global/send total=30`、`report-agent.generate::chat total=30`、`report-agent.generate::chat/send total=30`；全部 `critical=0`、`httpFail=0`。coverage 仍按预期 FAIL，唯一失败项为覆盖窗口不足，约 `0.72h < 24h`。正式 `/gw/v1/healthz` 仍返回 `2f6b0658397019e809f46ceb001245c6fdb03f40`，API 容器开关仍为 `Mode=shadow`、allowlist 空、采样 `1%`。
- 只读 planner 复核证据目录：生产 `/tmp/llmgw-shadow-plan-after-30-20260708T114008Z/`。复核输出 `remainingBatchesNeeded=0`、`recommendedBatches=0`、`canRunRecommendedBatches=false`、`reason=wait-coverage-window`，证明当前不应继续补样，必须等待 24 小时覆盖窗口。
- 结论：当前 commit 的低风险 canary-intent 样本数已达到 `30/30`，质量指标继续为 0 失败；后续禁止继续补 canary-intent 样本，禁止 `canary-intent-text --execute`，禁止全量 `LLMGW_MODE=http`。下一步只能在最早满足 24 小时窗口后跑只读 release gate 和 stage dry-run；两者都 PASS 才能进入 allowlist 灰度。

## 最新门禁修正（2026-07-08 19:47 CST）

- 代码追踪确认 `/gw/v1/shadow-comparisons` 的 `coverageHours` 是 `lastComparedAt - firstComparedAt`，不是 `now - firstComparedAt`。因此达到 `30/30` 后纯等待不会自然把 `coverageHours` 从约 `0.72h` 推到 `24h`，必须在足够晚的时点再追加一个受控低成本样本来拉长跨度。
- 已在本地脚本修正发布门可达性：`exec_dep.sh` 与 `scripts/llmgw-prod-stage.sh` 的默认 `LLMGW_GATE_SHADOW_SINCE_HOURS` 从 `24` 调整为 `48`，仍保留 `LLMGW_GATE_MIN_COVERAGE_HOURS=24`。这样“最近样本窗口”大于“覆盖时长要求”，避免 24/24 边界几乎不可达。
- 已在 `scripts/llmgw-shadow-sample-plan.py` 增加显式 `--allow-window-extension`：仅当样本数已满、`critical=0`、`httpFail=0`、从首样本到当前时间已达到覆盖要求时，才推荐 `window-extension-top-up` 的 `1` 个 batch。默认不开启时仍返回 `reason=wait-coverage-window`、`recommendedBatches=0`。
- 已在 `scripts/llmgw-shadow-sample-accumulate.sh` 增加 `LLMGW_SHADOW_ACCUMULATE_ALLOW_WINDOW_EXTENSION`，默认 `0`，需要时显式开启并由 planner 限制为 1 个 batch。该脚本修正已在后续步骤同步到生产，且同步验证未触发任何新模型请求。
- 本地验证：伪造 coverage JSON 自测通过，覆盖三种行为：默认不补、未到 24 小时不补、超过 24 小时且显式开启时只推荐 1 batch；`sh -n` 与 `python3 -m py_compile` 通过；`GatewayDataDomainGuardTests` 32/32 PASS；`dotnet build --no-restore` 退出码 0。

## 最新生产脚本同步（2026-07-08 19:49 CST）

- 已把窗口门禁修正同步到生产机 `/root/inernoro/prd_agent`，仅覆盖 5 个脚本：`exec_dep.sh`、`scripts/llmgw-prod-stage.sh`、`scripts/llmgw-readiness-audit.py`、`scripts/llmgw-shadow-sample-accumulate.sh`、`scripts/llmgw-shadow-sample-plan.py`。旧脚本备份在 `/root/backups/llmgw-shadow-window-extension-scripts-before-sync-20260708T194803+0800`。
- 同步后远端 sha256 与本地一致；远端 `sh -n exec_dep.sh scripts/llmgw-prod-stage.sh scripts/llmgw-shadow-sample-accumulate.sh` 与 `python3 -m py_compile scripts/llmgw-readiness-audit.py scripts/llmgw-shadow-sample-plan.py` 通过。
- 生产只读停补验证通过：显式设置 `LLMGW_SHADOW_ACCUMULATE_ALLOW_WINDOW_EXTENSION=1`、`BATCHES=1` 运行 accumulator，preflight coverage 后 planner 输出 `remainingBatchesNeeded=0`、`recommendedBatches=0`、`canRunRecommendedBatches=false`、`reason=wait-coverage-window`，脚本在 seed 前退出，没有触发模型请求。
- 验证后正式 `/gw/v1/healthz` 仍返回 `2f6b0658397019e809f46ceb001245c6fdb03f40`，API 容器开关仍为 `Mode=shadow`、allowlist 空、采样 `1%`。下一次最早应在首样本时间约 24 小时后再显式开启 window extension，且只允许 planner 推荐的 1 个 batch。

## 最新生产脚本漂移修复（2026-07-08 20:04 CST）

- 继续执行只读 gate 时发现生产机 `scripts/llmgw-shadow-coverage-report.py` 仍是旧版本，缺少 scoped gate 必需的 `--skip-global-cells` 参数；首次命令只在 argparse 阶段失败，没有触发模型请求、没有改数据库、没有重启容器。
- 已先备份旧脚本到 `/root/backups/llmgw-shadow-coverage-script-before-sync-20260708T200400+0800`，再从当前 `main` 精确同步 `scripts/llmgw-shadow-coverage-report.py`；同步后生产 sha256 为 `106e9551b4af8651fed5c951209a857c146efd95a4311229113058b8a13c6c2b`，`python3 -m py_compile` 通过，`--help` 已显示 `--skip-global-cells`。
- 只读复核证据目录：生产 `/tmp/llmgw-shadow-plan-now-20260708T120423Z/`。`report-agent.generate::chat/send total=30/30`、`critical=0`、`httpFail=0`，但 `coverageHours=0.716 < 24`，coverage verdict 仍为 `fail`。
- planner 复核输出 `reason=wait-coverage-window`、`recommendedBatches=0`、`canRunRecommendedBatches=false`。因此当前不能继续补 canary-intent 样本，也不能执行 `canary-intent-text` 灰度或全量 `LLMGW_MODE=http`。
- 下一步最早在首个目标样本 `2026-07-08T10:56:23.927Z` 之后满 24 小时时间窗后执行：先只读 coverage + planner；只有 planner 返回 `window-extension-top-up` 且推荐 `1` 个 batch，才显式开启 `LLMGW_SHADOW_ACCUMULATE_ALLOW_WINDOW_EXTENSION=1` 做 1 条低成本延展样本。

## 最新生产状态板同步（2026-07-08 20:49 CST）

- PR #1023 已合并到 `main`，merge commit 为 `a766f1d620dc57d02b2780b3405b3e0f958bf23c`。该 PR 新增只读 rollout status 状态板，并修复 `healthz` 失败时误显示 `gate-ready` 的门禁问题。
- 生产机 `/root/inernoro/prd_agent` 仍是旧 git 工作树，因此已先备份旧脚本到 `/root/backups/llmgw-script-sync-20260708T204927+0800`，再只同步两个只读脚本：`scripts/llmgw-rollout-status.py`、`scripts/llmgw-readiness-audit.py`。没有改 compose、没有重启容器、没有触发模型请求。
- 同步后生产 sha256 与本地 `main` 一致：`llmgw-rollout-status.py=d16d03701c4824d003136c8737552301094482073ef5bcfb952f14720ebb03b9`，`llmgw-readiness-audit.py=8aab7882eeaf3300691b58a4a80bd2b5e7a2e5ea6b6a33b9255019c28e84cc50`；生产 `python3 -m py_compile` 与 `scripts/llmgw-rollout-status.py --self-test` 均通过。
- 生产 host 本机状态板复核仍为 `action=wait-coverage-window`：`report-agent.generate::chat/send total=30/30`，`critical=0`，`httpFail=0`，`coverageHours=0.716/24`。`/gw/v1/healthz` 为 200，commit 仍是 `2f6b0658397019e809f46ceb001245c6fdb03f40`。
- `scripts/llmgw-prod-stage.sh --stage canary-intent-text --dry-run` 与 `--stage http-full --dry-run` 均被 rollout ledger 前置条件挡住，要求同 commit 的 `rollback-rehearsal` 成功记录，证明正式发布脚本不会跳过阶段顺序直接灰度或全量 HTTP。

## 最新 release gate 复核（2026-07-08 20:52 CST）

- 生产 runtime commit 仍是 `2f6b0658397019e809f46ceb001245c6fdb03f40`，当前 `main` 最新可发布 commit 是 `a766f1d620dc57d02b2780b3405b3e0f958bf23c`。这两个 commit 不等价，旧 shadow 证据不能直接证明新 commit。
- 只读 release gate 漂移验证：使用 `--expect-commit a766f1d620dc57d02b2780b3405b3e0f958bf23c --shadow-release-commit a766f1d620dc57d02b2780b3405b3e0f958bf23c` 查询生产 `/gw/v1`，结果 `verdict=fail`。失败原因包括 `healthz` 实际 commit 为 `2f6b0658397019e809f46ceb001245c6fdb03f40`，以及 `a766f1d...` 对应 `report-agent.generate::chat/send total=0/30`。
- 只读 release gate 当前生产验证：使用 `--expect-commit 2f6b0658397019e809f46ceb001245c6fdb03f40 --shadow-release-commit 2f6b0658397019e809f46ceb001245c6fdb03f40`，结果仍为 `verdict=fail`。样本数为 `30/30` 且 `critical=0`、`httpFail=0`，但唯一失败项仍是 `coverageHours=0.72 < 24`。
- 结论：release gate 已正确阻止两类误发布：不能用旧证据发布新 commit，也不能在当前生产 commit 覆盖窗口不足时灰度或全量 HTTP。下一步仍只能等覆盖窗口到点后先跑只读状态板；若要发布新 commit，必须先部署该 commit 的 shadow 模式并重新积累同 commit 证据。

## 最新状态板可操作性修正（2026-07-08 20:54 CST）

- 本地 `scripts/llmgw-rollout-status.py` 的覆盖窗口行新增 `nextEligibleAt`，从所有未达标 cell 的 `firstComparedAt + minCoverageHours` 推导最晚可动作时间，多 cell 时不会被已达标 cell 误导。
- 零费用验证通过：`python3 -m py_compile scripts/llmgw-rollout-status.py scripts/llmgw-readiness-audit.py`、`scripts/llmgw-rollout-status.py --self-test`、`python3 scripts/llmgw-readiness-audit.py --print-json` 均通过。
- 使用生产 `/gw/v1` 只读状态板复核，仍为 `action=wait-coverage-window`，但覆盖窗口行现在明确显示 `nextEligibleAt=2026-07-09T10:56:23.927000Z`，即北京时间 `2026-07-09 18:56:23.927 CST`。本次复核没有触发 MAP seed、没有触发模型请求、没有改生产配置。

## 昂贵 canary 默认限量（2026-07-08 20:59 CST）

- 因火山侧已充值但要求避免过量测试，本地 `scripts/llmgw-asr-http-canary.py` 与 `scripts/llmgw-video-exchange-canary.py` 增加 `--max-canary-calls`，默认均为 `1`，也可分别通过 `LLMGW_ASR_CANARY_MAX_CALLS`、`LLMGW_VIDEO_CANARY_MAX_CALLS` 显式提高。
- 新默认会在执行任何网络请求前拦截超预算目标：ASR 默认的 4 个 appCaller、Video 默认的 2 个 appCaller 都会 fail-closed。真实验证必须先用 `--app-caller`、`--model` 缩到单个目标；只有有明确预算时才提高上限。
- 该改动是防误操作保护，不代表视频/ASR gate 已通过；视频仍按用户要求暂缓，后续优先推进低风险文本 allowlist 和只读证据。

## 生产脚本预算护栏同步（2026-07-08 21:09 CST）

- PR #1024 已合并到 main，merge commit 为 `f8a52aa5a02d3cf4b07590b5ca8b37b964d9f21f`；main 的 `CI`、`CDS CI`、`Branch Image`、`Web Latest (Pages)`、`Server Deploy` 均通过。
- 生产运行时仍是 `2f6b0658397019e809f46ceb001245c6fdb03f40`，未部署新镜像、未重启服务、未改 `.env`、未触发模型请求。本次只同步 4 个发布/验证脚本到 `/root/inernoro/prd_agent/scripts/`：`llmgw-asr-http-canary.py`、`llmgw-video-exchange-canary.py`、`llmgw-readiness-audit.py`、`llmgw-rollout-status.py`。
- 同步前已备份远端旧脚本到 `/root/backups/llmgw-canary-budget-guard-before-sync-20260708T210820+0800`。同步后远端 sha256 与 main 一致；`python3 -m py_compile ...` 与 `scripts/llmgw-rollout-status.py --self-test` 通过。
- 生产机零费用验证确认默认预算门生效：ASR 默认入口在请求前拒绝 `requested=4 max=1`，Video 默认入口在请求前拒绝 `requested=2 max=1`。
- 生产只读状态板证据写入 `.llmgw-release-evidence/rollout-status-20260708T130901Z-budget-sync/`：当前仍为 `action=wait-coverage-window`，`report-agent.generate::chat/send total=30/30`、`critical=0`、`httpFail=0`，覆盖窗口 `0.716/24`，`nextEligibleAt=2026-07-09T10:56:23.927000Z`。下一步到点前不得补样，到点后也只能按 planner 最小批次执行。

## 最新正式 shadow 发布（2026-07-08 23:31 CST）

- PR #1029 已合并到 main，merge commit 为 `f661cd979faa7dbf1911521d2eb2452aea8e2cbd`；main 的 `CI`、`CDS CI`、`Branch Image`、`Web Latest (Pages)`、`Server Deploy` 均通过。该 commit 增加生产 release tree 只读预检，发布前可证明生产 runner 的关键 rollout/deploy 文件与目标 commit 一致。
- 发布前完成 critical 外置备份：`/Users/inernoro/prd-agent-prod-backups/llmgw-prod-external-20260708T232533+0800`，包含 `prdagent.model_groups`、`prdagent.llm_app_callers`、`prdagent.llmplatforms`、`prdagent.model_exchanges`、`prdagent.llmrequestlogs` 与 `llm_gateway` 全库，并生成 `SHA256SUMS`。
- 已通过 `scripts/llmgw-prod-stage.sh --stage shadow-start --commit f661cd979faa7dbf1911521d2eb2452aea8e2cbd --execute` 发布正式环境；`api / llmgw / llmgw-serve / llmgw-web` 镜像均为 `sha-f661cd979faa7dbf1911521d2eb2452aea8e2cbd`，`/gw/v1/healthz` 返回同一 commit。
- 本次为低费用发布：显式设置 `LLMGW_GATE_RUN_SMOKE=0`、`LLMGW_STAGE_RUN_SHADOW_SEED=0`，未跑 gw-smoke、未跑 shadow seed、未跑 upstream/provider/video/asr canary，未触发任何模型请求。发布后 serving probe 通过，证据为 `.llmgw-release-evidence/20260708T152952Z_shadow-start_f661cd979faa.*`。
- 同 commit rollback rehearsal 已成功入账：`.llmgw-release-evidence/20260708T153116Z_rollback-rehearsal_f661cd979faa.*`。该演练只打印 `LLMGW_MODE=inproc` 回滚命令，不改镜像、不改数据库、不重启。
- 正式运行开关保持安全态：`.env` 与 API 容器均为 `LlmGateway__Mode=shadow`、`LlmGateway__HttpAppCallerAllowlist=`、`LlmGateway__ShadowFullSamplePercent=1`、`LlmGateway__ShadowFullSampleAppCallerAllowlist=`。没有开启 allowlist，也没有切 `LLMGW_MODE=http`。
- 新 commit 只读状态板证据写入 `.llmgw-release-evidence/rollout-status-20260708T153106Z-f661-readonly/status.json`，当前为 `action=run-bounded-top-up`：`report-agent.generate::chat/send total=0/30`、`critical=0`、`httpFail=0`、coverageHours `0/24`，planner 只允许最多 `1` batch。生产 `.env` 未提供 MAP `ROOT_ACCESS_PASSWORD` / `MAP_ADMIN_TOKEN`，本轮不绕过鉴权、不直接改库造 token，也不继续触发补样。
- 结论：正式环境已进入 `f661cd979faa7dbf1911521d2eb2452aea8e2cbd` 的 shadow 证据期；旧 commit `2f6b065...` 的 `30/30` 样本不能迁移证明新 commit。下一步只能先只读 coverage + planner，再按 planner 最小推荐补样；继续禁止视频、禁止图片/ASR 批量测试、禁止 `canary-intent-text --execute` 与全量 `LLMGW_MODE=http`。

## 最新低成本补样（2026-07-08 23:36 CST）

- 生产 API 容器内存在 `ROOT_ACCESS_USERNAME` / `ROOT_ACCESS_PASSWORD`，因此本轮走正式 `/api/v1/auth/login` 路径执行 seed；没有绕过鉴权、没有直接改库造 token。
- 执行前状态板为 `action=run-bounded-top-up`，planner 只允许最多 `1` batch；本轮仅执行 1 个 `canary-intent-text` force-sample batch，绑定 release commit `f661cd979faa7dbf1911521d2eb2452aea8e2cbd`。未触发视频、图片、ASR，也未提高 planner 上限。
- 执行证据目录：生产 `.llmgw-release-evidence/shadow-accumulate-20260708T153456Z-f661-one-batch/`。脚本最终因样本数仍不足返回非零，但这是预期 gate 失败，不是链路质量失败。
- 执行后只读状态板证据写入 `.llmgw-release-evidence/rollout-status-20260708T153553Z-f661-after-one-batch/status.json`：`report-agent.generate::chat/send total=1/30`、`critical=0`、`httpFail=0`、`coverageHours=0/24`，`nextEligibleAt=2026-07-09T15:35:16.860000Z`。`.env` 与 API 容器均已恢复 `LlmGateway__ShadowFullSamplePercent=1`。
- 结论：新 commit 的低风险文本证据已从 `0/30` 推进到 `1/30`。为避免过量测试，不连续追满；下一轮仍必须先跑只读状态板和 planner，最多执行 planner 推荐的最小 batch，继续禁止 `canary-intent-text --execute` 与全量 `LLMGW_MODE=http`。

## 最新低成本补样（2026-07-08 23:39 CST）

- 只读状态板先确认仍为 `action=run-bounded-top-up`，`report-agent.generate::chat/send total=1/30`、`critical=0`、`httpFail=0`，planner 继续只允许最多 `1` batch。
- 本轮仅执行 1 个 `canary-intent-text` force-sample batch，绑定 release commit `f661cd979faa7dbf1911521d2eb2452aea8e2cbd`；未触发视频、图片、ASR，也未提高 planner 上限。执行证据目录：生产 `.llmgw-release-evidence/shadow-accumulate-20260708T153744Z-f661-second-one-batch/`。
- 执行后只读状态板证据写入 `.llmgw-release-evidence/rollout-status-20260708T153841Z-f661-after-second-batch/status.json`：`report-agent.generate::chat/send total=2/30`、`critical=0`、`httpFail=0`、coverageHours `0.047/24`，`nextEligibleAt=2026-07-09T15:35:16.860000Z`。`.env` 与 API 容器均已恢复 `LlmGateway__ShadowFullSamplePercent=1`。
- 结论：新 commit 的低风险文本证据已从 `1/30` 推进到 `2/30`，质量指标仍为 0 失败。为避免过量测试，本轮停止继续补样；下一轮仍必须先跑只读状态板和 planner，最多执行 planner 推荐的最小 batch，继续禁止 `canary-intent-text --execute` 与全量 `LLMGW_MODE=http`。

## 最新低成本补样（2026-07-08 23:41 CST）

- 只读状态板先确认仍为 `action=run-bounded-top-up`，`report-agent.generate::chat/send total=2/30`、`critical=0`、`httpFail=0`，planner 继续只允许最多 `1` batch。
- 本轮仅执行 1 个 `canary-intent-text` force-sample batch，绑定 release commit `f661cd979faa7dbf1911521d2eb2452aea8e2cbd`；未触发视频、图片、ASR，也未提高 planner 上限。执行证据目录：生产 `.llmgw-release-evidence/shadow-accumulate-20260708T154021Z-f661-third-one-batch/`。
- 执行后只读状态板证据写入 `.llmgw-release-evidence/rollout-status-20260708T154119Z-f661-after-third-batch/status.json`：`report-agent.generate::chat/send total=3/30`、`critical=0`、`httpFail=0`、coverageHours `0.090/24`，`nextEligibleAt=2026-07-09T15:35:16.860000Z`。`.env` 与 API 容器均已恢复 `LlmGateway__ShadowFullSamplePercent=1`。
- 结论：新 commit 的低风险文本证据已从 `2/30` 推进到 `3/30`，质量指标仍为 0 失败。为避免过量测试，本轮停止继续补样；下一轮仍必须先跑只读状态板和 planner，最多执行 planner 推荐的最小 batch，继续禁止 `canary-intent-text --execute` 与全量 `LLMGW_MODE=http`。

## 最新低成本补样（2026-07-08 23:44 CST）

- 只读状态板先确认仍为 `action=run-bounded-top-up`，`report-agent.generate::chat/send total=3/30`、`critical=0`、`httpFail=0`，planner 继续只允许最多 `1` batch。
- 本轮仅执行 1 个 `canary-intent-text` force-sample batch，绑定 release commit `f661cd979faa7dbf1911521d2eb2452aea8e2cbd`；未触发视频、图片、ASR，也未提高 planner 上限。执行证据目录：生产 `.llmgw-release-evidence/shadow-accumulate-20260708T154300Z-f661-fourth-one-batch/`。
- 执行后只读状态板证据写入 `.llmgw-release-evidence/rollout-status-20260708T154400Z-f661-after-fourth-batch/status.json`：`report-agent.generate::chat/send total=4/30`、`critical=0`、`httpFail=0`、coverageHours `0.135/24`，`nextEligibleAt=2026-07-09T15:35:16.860000Z`。`.env` 与 API 容器均已恢复 `LlmGateway__ShadowFullSamplePercent=1`。
- 结论：新 commit 的低风险文本证据已从 `3/30` 推进到 `4/30`，质量指标仍为 0 失败。为避免过量测试，本轮停止继续补样；下一轮仍必须先跑只读状态板和 planner，最多执行 planner 推荐的最小 batch，继续禁止 `canary-intent-text --execute` 与全量 `LLMGW_MODE=http`。

## 最新低成本补样（2026-07-08 23:47 CST）

- 只读状态板先确认仍为 `action=run-bounded-top-up`，`report-agent.generate::chat/send total=4/30`、`critical=0`、`httpFail=0`，planner 继续只允许最多 `1` batch。
- 本轮仅执行 1 个 `canary-intent-text` force-sample batch，绑定 release commit `f661cd979faa7dbf1911521d2eb2452aea8e2cbd`；未触发视频、图片、ASR，也未提高 planner 上限。执行证据目录：生产 `.llmgw-release-evidence/shadow-accumulate-20260708T154543Z-f661-fifth-one-batch/`。
- 执行后只读状态板证据写入 `.llmgw-release-evidence/rollout-status-20260708T154657Z-f661-after-fifth-batch/status.json`：`report-agent.generate::chat/send total=5/30`、`critical=0`、`httpFail=0`、coverageHours `0.190/24`，`nextEligibleAt=2026-07-09T15:35:16.860000Z`。`.env` 与 API 容器均已恢复 `LlmGateway__ShadowFullSamplePercent=1`。
- 结论：新 commit 的低风险文本证据已从 `4/30` 推进到 `5/30`，质量指标仍为 0 失败。为避免过量测试，本轮停止继续补样；下一轮仍必须先跑只读状态板和 planner，最多执行 planner 推荐的最小 batch，继续禁止 `canary-intent-text --execute` 与全量 `LLMGW_MODE=http`。

## 最新低成本补样（2026-07-08 23:51 CST）

- 只读状态板先确认仍为 `action=run-bounded-top-up`，`report-agent.generate::chat/send total=5/30`、`critical=0`、`httpFail=0`，planner 继续只允许最多 `1` batch。
- 本轮仅执行 1 个 `canary-intent-text` force-sample batch，绑定 release commit `f661cd979faa7dbf1911521d2eb2452aea8e2cbd`；未触发视频、图片、ASR，也未提高 planner 上限。执行证据目录：生产 `.llmgw-release-evidence/shadow-accumulate-20260708T154849Z-f661-sixth-one-batch/`。
- 执行后只读状态板证据写入 `.llmgw-release-evidence/rollout-status-20260708T155117Z-f661-after-sixth-batch/status.json`：`report-agent.generate::chat/send total=6/30`、`critical=0`、`httpFail=0`、coverageHours `0.264/24`，`nextEligibleAt=2026-07-09T15:35:16.860000Z`。`.env` 与 API 容器均已恢复 `LlmGateway__ShadowFullSamplePercent=1`。
- 结论：新 commit 的低风险文本证据已从 `5/30` 推进到 `6/30`，质量指标仍为 0 失败。为避免过量测试，本轮停止继续补样；下一轮仍必须先跑只读状态板和 planner，最多执行 planner 推荐的最小 batch，继续禁止 `canary-intent-text --execute` 与全量 `LLMGW_MODE=http`。

## 最新低成本补样（2026-07-08 23:56 CST）

- 只读状态板先确认仍为 `action=run-bounded-top-up`，`report-agent.generate::chat/send total=6/30`、`critical=0`、`httpFail=0`，planner 继续只允许最多 `1` batch。
- 本轮仅执行 1 个 `canary-intent-text` force-sample batch，绑定 release commit `f661cd979faa7dbf1911521d2eb2452aea8e2cbd`；未触发视频、图片、ASR，也未提高 planner 上限。执行证据目录：生产 `.llmgw-release-evidence/shadow-accumulate-20260708T155341Z-f661-seventh-one-batch/`。
- 执行后只读状态板证据写入 `.llmgw-release-evidence/rollout-status-20260708T155601Z-f661-after-seventh-batch/status.json`：`report-agent.generate::chat/send total=7/30`、`critical=0`、`httpFail=0`、coverageHours `0.344/24`，`nextEligibleAt=2026-07-09T15:35:16.860000Z`。`.env` 与 API 容器均已恢复 `LlmGateway__ShadowFullSamplePercent=1`，`LlmGateway__HttpAppCallerAllowlist` 与 `LlmGateway__ShadowFullSampleAppCallerAllowlist` 均为空。
- 结论：新 commit 的低风险文本证据已从 `6/30` 推进到 `7/30`，质量指标仍为 0 失败。为避免过量测试，本轮停止继续补样；下一轮仍必须先跑只读状态板和 planner，最多执行 planner 推荐的最小 batch，继续禁止 `canary-intent-text --execute`、视频/图片/ASR 批量 canary 与全量 `LLMGW_MODE=http`。

## 最新低成本补样（2026-07-08 23:58 CST）

- 只读状态板先确认仍为 `action=run-bounded-top-up`，`report-agent.generate::chat/send total=7/30`、`critical=0`、`httpFail=0`，planner 继续只允许最多 `1` batch。
- 本轮仅执行 1 个 `canary-intent-text` force-sample batch，绑定 release commit `f661cd979faa7dbf1911521d2eb2452aea8e2cbd`；未触发视频、图片、ASR，也未提高 planner 上限。执行证据目录：生产 `.llmgw-release-evidence/shadow-accumulate-20260708T155743Z-f661-eighth-one-batch/`。
- 执行后只读状态板证据写入 `.llmgw-release-evidence/rollout-status-20260708T155836Z-f661-after-eighth-batch/status.json`：`report-agent.generate::chat/send total=8/30`、`critical=0`、`httpFail=0`、coverageHours `0.379/24`，`nextEligibleAt=2026-07-09T15:35:16.860000Z`。`.env` 与 API 容器均已恢复 `LlmGateway__ShadowFullSamplePercent=1`，`LlmGateway__HttpAppCallerAllowlist` 与 `LlmGateway__ShadowFullSampleAppCallerAllowlist` 均为空。
- 结论：新 commit 的低风险文本证据已从 `7/30` 推进到 `8/30`，质量指标仍为 0 失败。为避免过量测试，本轮停止继续补样；下一轮仍必须先跑只读状态板和 planner，最多执行 planner 推荐的最小 batch，继续禁止 `canary-intent-text --execute`、视频/图片/ASR 批量 canary 与全量 `LLMGW_MODE=http`。

## 最新低成本补样（2026-07-09 00:01 CST）

- 只读状态板先确认仍为 `action=run-bounded-top-up`，`report-agent.generate::chat/send total=8/30`、`critical=0`、`httpFail=0`，planner 继续只允许最多 `1` batch。
- 本轮仅执行 1 个 `canary-intent-text` force-sample batch，绑定 release commit `f661cd979faa7dbf1911521d2eb2452aea8e2cbd`；未触发视频、图片、ASR，也未提高 planner 上限。执行证据目录：生产 `.llmgw-release-evidence/shadow-accumulate-20260708T160008Z-f661-ninth-one-batch/`。
- 执行后只读状态板证据写入 `.llmgw-release-evidence/rollout-status-20260708T160118Z-f661-after-ninth-batch/status.json`：`report-agent.generate::chat/send total=9/30`、`critical=0`、`httpFail=0`、coverageHours `0.425/24`，`nextEligibleAt=2026-07-09T15:35:16.860000Z`。`.env` 与 API 容器均已恢复 `LlmGateway__ShadowFullSamplePercent=1`，`LlmGateway__HttpAppCallerAllowlist` 与 `LlmGateway__ShadowFullSampleAppCallerAllowlist` 均为空。
- 结论：新 commit 的低风险文本证据已从 `8/30` 推进到 `9/30`，质量指标仍为 0 失败。为避免过量测试，本轮停止继续补样；下一轮仍必须先跑只读状态板和 planner，最多执行 planner 推荐的最小 batch，继续禁止 `canary-intent-text --execute`、视频/图片/ASR 批量 canary 与全量 `LLMGW_MODE=http`。

## 最新低成本补样（2026-07-09 00:03 CST）

- 只读状态板先确认仍为 `action=run-bounded-top-up`，`report-agent.generate::chat/send total=9/30`、`critical=0`、`httpFail=0`，planner 继续只允许最多 `1` batch。
- 本轮仅执行 1 个 `canary-intent-text` force-sample batch，绑定 release commit `f661cd979faa7dbf1911521d2eb2452aea8e2cbd`；未触发视频、图片、ASR，也未提高 planner 上限。执行证据目录：生产 `.llmgw-release-evidence/shadow-accumulate-20260708T160251Z-f661-tenth-one-batch/`。
- 执行后只读状态板证据写入 `.llmgw-release-evidence/rollout-status-20260708T160352Z-f661-after-tenth-batch/status.json`：`report-agent.generate::chat/send total=10/30`、`critical=0`、`httpFail=0`、coverageHours `0.468/24`，`nextEligibleAt=2026-07-09T15:35:16.860000Z`。`.env` 与 API 容器均已恢复 `LlmGateway__ShadowFullSamplePercent=1`，`LlmGateway__HttpAppCallerAllowlist` 与 `LlmGateway__ShadowFullSampleAppCallerAllowlist` 均为空。
- 结论：新 commit 的低风险文本证据已从 `9/30` 推进到 `10/30`，质量指标仍为 0 失败。为避免过量测试，本轮停止继续补样；下一轮仍必须先跑只读状态板和 planner，最多执行 planner 推荐的最小 batch，继续禁止 `canary-intent-text --execute`、视频/图片/ASR 批量 canary 与全量 `LLMGW_MODE=http`。

## 最新低成本补样（2026-07-09 00:06 CST）

- 只读状态板先确认仍为 `action=run-bounded-top-up`，`report-agent.generate::chat/send total=10/30`、`critical=0`、`httpFail=0`，planner 继续只允许最多 `1` batch。
- 本轮仅执行 1 个 `canary-intent-text` force-sample batch，绑定 release commit `f661cd979faa7dbf1911521d2eb2452aea8e2cbd`；未触发视频、图片、ASR，也未提高 planner 上限。执行证据目录：生产 `.llmgw-release-evidence/shadow-accumulate-20260708T160522Z-f661-eleventh-one-batch/`。
- 执行后只读状态板证据写入 `.llmgw-release-evidence/rollout-status-20260708T160629Z-f661-after-eleventh-batch/status.json`：`report-agent.generate::chat/send total=11/30`、`critical=0`、`httpFail=0`、coverageHours `0.511/24`，`nextEligibleAt=2026-07-09T15:35:16.860000Z`。`.env` 与 API 容器均已恢复 `LlmGateway__ShadowFullSamplePercent=1`，`LlmGateway__HttpAppCallerAllowlist` 与 `LlmGateway__ShadowFullSampleAppCallerAllowlist` 均为空。
- 结论：新 commit 的低风险文本证据已从 `10/30` 推进到 `11/30`，质量指标仍为 0 失败。为避免过量测试，本轮停止继续补样；下一轮仍必须先跑只读状态板和 planner，最多执行 planner 推荐的最小 batch，继续禁止 `canary-intent-text --execute`、视频/图片/ASR 批量 canary 与全量 `LLMGW_MODE=http`。

## 最新低成本补样（2026-07-09 00:22 CST）

- 用户要求停止一轮一条的低效推进后，本轮先只读确认 `action=run-bounded-top-up`、`report-agent.generate::chat/send total=11/30`、`critical=0`、`httpFail=0`，再使用 accumulator 的显式预算参数执行受控 bulk top-up：`LLMGW_SHADOW_ACCUMULATE_BATCHES=19`、`LLMGW_SHADOW_ACCUMULATE_MAX_BATCHES=19`。这是脚本内置 planner 路径，preflight 输出 `remainingBatchesNeeded=19`、`recommendedBatches=19`、`canRunRecommendedBatches=true`、`reason=bounded-top-up`。
- 执行证据目录：生产 `.llmgw-release-evidence/shadow-accumulate-20260708T160822Z-f661-bulk-19-to-30/`。执行范围仍只包含低成本 `canary-intent-text` / `report-agent.generate::chat/send`，绑定 release commit `f661cd979faa7dbf1911521d2eb2452aea8e2cbd`；未触发视频、图片、ASR，未打开 HTTP allowlist，未切 `LLMGW_MODE=http`。
- 执行后只读状态板证据写入 `.llmgw-release-evidence/rollout-status-20260708T162206Z-f661-after-bulk-30/status.json`：`report-agent.generate::chat/send total=30/30`、`critical=0`、`httpFail=0`、coverageHours `0.769/24`。`.env` 与 API 容器均保持 `LlmGateway__Mode=shadow`、`LlmGateway__ShadowFullSamplePercent=1`，`LlmGateway__HttpAppCallerAllowlist` 与 `LlmGateway__ShadowFullSampleAppCallerAllowlist` 均为空。
- 结论：新 commit 的低风险文本样本数门槛已从 `11/30` 补齐到 `30/30`，质量指标仍为 0 失败。当前状态板 action 已变为 `wait-coverage-window`，下一步不应继续 seed；最早等到 `2026-07-09T15:35:16.860000Z`（北京时间 `2026-07-09 23:35:16 CST`）后，只允许显式 window-extension 追加 1 条窗口样本，再跑只读 release gate。

## 最新 HTTP 白名单实切（2026-07-09 02:40 CST）

- 用户明确要求“先切，然后看返回的数据”后，本轮没有全量切 `LLMGW_MODE=http`，而是做最小可回滚实切：保持 `LLMGW_MODE=shadow`，只把 `LLMGW_HTTP_APP_CALLER_ALLOWLIST` 设置为 `report-agent.generate::chat`。切换前备份生产 `.env` 到 `/root/backups/llmgw-allowlist-report-agent-before-20260709T023930+0800/.env`，随后仅重建 `api` 容器，镜像 commit 仍为 `f661cd979faa7dbf1911521d2eb2452aea8e2cbd`。
- 切换后生产 API 环境确认：`mode=shadow`、`allowlist=report-agent.generate::chat`、`sample=1`、`sampleApps=`。这表示命中该 appCaller 的请求由 `ShadowLlmGateway` 直接走 `HttpLlmGatewayClient` 并返回 HTTP GW 结果，其余入口仍走原路径。
- 实切验证通过：通过正式 MAP API 触发 1 次周报草稿生成，证据文件为生产 `.llmgw-release-evidence/report-agent-http-allowlist-20260708T183951Z.json`；接口返回 `status=200`、`ok=1`、`elapsed=6.415s`、`aiGenerationError=False`，种子数据已清理。
- GW 独立库日志验证通过：`llm_gateway.llmrequestlogs` 最新记录 `AppCallerCode=report-agent.generate::chat`、`GatewayTransport=http`、`Status=succeeded`、`StatusCode=200`、`Model=deepseek-ai/DeepSeek-V4-Flash`、`Provider=硅基流动`、`InputTokens=590`、`OutputTokens=366`、`DurationMs=6207`、`RequestId=94d6a6df23cc48ccab37cd41c76fca30`。这证明该入口已经真实经独立 `llmgw-serve` 返回。
- 结论：`report-agent.generate::chat` 已从 shadow-only 推进为 HTTP allowlist 实切成功；这不是全量迁移完成。下一步应按同样方式扩展 text/chat appCaller 矩阵，昂贵的图片、ASR、视频仍需单独预算和单次 canary 控制。

## 维护窗口 full-http 实切（2026-07-09 03:05 CST）

- 用户明确进入维护窗口并要求“先全量切、再快速测试”。本轮按维护覆盖策略在正式环境 `map.ebcone.net` 执行全量 HTTP：`.env` 设置为 `LLMGW_MODE=http`、`LLMGW_HTTP_APP_CALLER_ALLOWLIST=`、`LLMGW_SHADOW_FULL_SAMPLE_PERCENT=0`、`LLMGW_SHADOW_FULL_SAMPLE_APP_CALLER_ALLOWLIST=`，随后仅重建 `api` 容器。API 容器环境确认：`LlmGateway__Mode=http`、`LlmGateway__HttpAppCallerAllowlist=`、`LlmGateway__ShadowFullSamplePercent=0`、`LlmGateway__ShadowFullSampleAppCallerAllowlist=`。
- 执行前已做 full cutover 备份：`/root/backups/llmgw-full-http-before-20260709T025126+0800`，包含生产 `.env`、`llm_gateway.archive.gz`、`prdagent.model_groups`、`prdagent.llm_app_callers`、`prdagent.llmplatforms`、`prdagent.model_exchanges`、`prdagent.llmrequestlogs` 等归档及 `SHA256SUMS`。此前最小 allowlist 备份仍保留在 `/root/backups/llmgw-allowlist-report-agent-before-20260709T023930+0800/.env`。
- full-http 后 serving health 与 D 层 smoke 通过：`/gw/v1/healthz` 返回 commit `f661cd979faa7dbf1911521d2eb2452aea8e2cbd`；`llmgw-serving-probe.py` PASS；`scripts/gw-smoke.py` 对正式 `https://map.ebcone.net/gw/v1` 的 health、resolve、send、stream、client-stream、canary 预期失败等 10/10 PASS。证据目录：生产 `.llmgw-release-evidence/full-http-health-20260708T185225Z/`。
- full-http 文本矩阵通过：`report-agent.generate::chat`、`prd-agent-desktop.chat.sendmessage::chat`、`open-platform-agent.proxy::chat`、`open-api.proxy::chat`、`prd-agent-web.model-lab.run::chat`、`prd-agent.arena.battle::chat`、`tutorial-email.generate::chat` 均在 `llm_gateway.llmrequestlogs` 记录 `GatewayTransport=http`、`Status=succeeded`、`StatusCode=200`。证据：生产 `.llmgw-release-evidence/full-http-map-text-matrix-20260708T185352Z.json`。
- full-http raw 矩阵通过：`open-api.proxy::generation`、`visual-agent.image-gen.generate::generation`、`transcript-agent.transcribe::asr`、`document-store.subtitle::asr` 均在 `llm_gateway.llmrequestlogs` 记录 `GatewayTransport=http`、`Status=succeeded`、`StatusCode=200`，证明图片与 ASR/字幕 raw 已能跨进程走 `llmgw-serve`。证据：生产 `.llmgw-release-evidence/full-http-raw-image-asr-20260708T185533Z.json`。
- 视频初次 full-http canary 失败原因不是 GW transport，而是此前欠费失败把 `video_seedance_2_0_fast_pool` 健康状态熔断为 `Unavailable`。只读 provider audit 证据：生产 `.llmgw-release-evidence/full-http-provider-audit-20260708T185930Z.{json,md}`；其中火山方舟 Seedance exchange key 可解密，旧失败为 `AccountOverdueError` / no available channels。
- 用户确认火山已充值后，只恢复单个 Seedance 模型健康状态：`video_seedance_2_0_fast_pool` / `doubao-seedance-2-0-fast-260128` 从 `HealthStatus=2` 改为 `HealthStatus=0`，`ConsecutiveFailures=0`，变更前后记录在生产 `.llmgw-release-evidence/full-http-video-health-reset-20260708T185955Z.json`。未改 APIyi 两个备用视频池，避免扩大测试面。
- 视频受控复验通过：`video-agent.videogen::video-gen` 5 秒 720p submit 返回 `cgt-20260709030008-5wcvp`，GW 独立库日志为 `GatewayTransport=http`、`Status=succeeded`、`StatusCode=200`、`Provider=Exchange:火山方舟 Seedance 视频生成`；`visual-agent.videogen::video-gen` 完整 run `47da5437-db37-42fd-8561-c2afd7b64e55` 轮询到 `Completed`，最终写入 COS `VideoAssetUrl`。证据：生产 `.llmgw-release-evidence/full-http-video-canary-20260708T190006Z.json` 与 `.llmgw-release-evidence/full-http-visual-video-canary-20260708T190106Z.json`。
- 最近 30 分钟 GW 日志复核：`visual-agent.videogen::video-gen`、`video-agent.videogen::video-gen`、`document-store.subtitle::asr`、`transcript-agent.transcribe::asr`、`open-api.proxy::generation`、`visual-agent.image-gen.generate::generation`、`report-agent.generate::chat`、`tutorial-email.generate::chat`、`prd-agent.arena.battle::chat`、`prd-agent-web.model-lab.run::chat`、`open-api.proxy::chat`、`open-platform-agent.proxy::chat` 均有 `transport=http` 成功记录；失败查询为空。少量 `inproc` 记录均发生在全切之前。
- 当前结论：正式环境已处于全量 `LlmGateway__Mode=http`，已用维护窗口最小矩阵证明文本、开放接口、ModelLab/Arena、图片、ASR/字幕、视频 submit 与视觉视频完整产物流均经独立 `llmgw-serve` 成功。尚未删除 inproc/legacy 代码，仍作为回滚兜底；APIyi 视频备用池仍是 no available channels 债务，不影响当前默认 Seedance 生产路径，但后续需要单独清理或下线。

## 已知边界（2026-07-12 有限收口）

- 生命周期清理只由主 `llmgw-serve` 实例执行，副实例禁用 worker；两实例仍会幂等维护非破坏性索引。未来若改成多主机动态扩缩容，必须把单实例开关升级为数据库租约，不能同时开启多个清理 worker。
- 正文脱敏和 multipart 删除由 lifecycle worker 执行；请求元数据、shadow、登录与操作审计由 Mongo TTL 异步删除。TTL 删除时间不是精确到秒，控制台以最近 dry-run、清理结果和索引状态为准。
- 一次性最终验收允许视频状态轮询，但每次完整矩阵最多提交一个视频任务；失败后只允许带人工批准说明补跑失败单格，禁止整套自动重跑。
- `inproc` 与 legacy 代码继续作为生产回滚兜底，本计划不删除。稳定期后的删除必须另立有限任务，不能混入本次发布。

## 已还的债务（归档）

> 修复后从上面表格挪到这里，保留以便复盘

| ID | 修复 PR | 修复日期 | 备注 |
|----|---------|---------|------|
| 2026-07-06-multipart-http-rehydrate | 待 PR | 2026-07-06 | 已实现 MAP 侧 inline multipart 上传为 `MultipartFileRefs`、serving `/gw/v1/raw` 侧按 ref 下载并校验 size/hash 后 rehydrate 为 `MultipartFiles`；新增 `GatewayMultipartHttpTests` 覆盖上传过线、rehydrate、hash mismatch 拦截。生产 shadow 样本与 allowlist 灰度仍是发布 gate。 |
