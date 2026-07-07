# LLM 网关与模型池 · 债务台账

> **版本**：v1.0 | **日期**：2026-07-07 | **状态**：开发中
> **关联设计**：`design.llm-gateway-unification.md`（统一方案）、`design.llm-gateway.md`、`design.model-pool.md`

## 总览

当前 open: 21 / paid: 1 / 总计: 22

本台账记录"LLM 网关与模型池统一"迁移过程中已识别、但尚未在代码中偿还的边界与风险。详细方案见 `design.llm-gateway-unification.md`。

## 债务列表

| ID | 严重度 | 创建日期 | 描述 | 触发条件 | 状态 | 备注 |
|----|--------|---------|------|---------|------|------|
| 2026-06-24-protocol-on-platform | high | 2026-06-24 | 接口模式（adapter/transformer 选择）绑在平台 `PlatformType`，模型无法覆盖；图片另起 5 分支按 apiUrl 猜 | 任何"同平台多协议"或"某模型换格式"需求 | open | 解法=Protocol 下沉到模型，提升 Transformer 为统一协议层（设计 §决策一） |
| 2026-06-24-dead-strategy-engines | medium | 2026-06-24 | 6 个策略引擎 + ModelPoolDispatcher 不在服务链路，唯一调用是管理预览；纯死复杂度 | 可删（已取证：main 17 池 100% FailFast，2026-06-25） | open | 取证已过，删除排在 P3 黄金快照建立之后 |
| 2026-06-24-legacy-flag-tier | high | 2026-06-24 | 调度第 3 层 legacy 标记与默认池功能重叠。**取证升级（2026-06-25）：91/153 (60%) code 实际经 legacy 层路由**（非遗迹，是承重墙） | 必须先建 chat/intent/vision/generation 默认池 + 黄金快照确认 91 个 code 改走 DefaultPool 后 | open | 顺序硬约束：直接删 = 砸 60% 调用方；删除前全栈审计（enum-ripple-audit） |
| 2026-06-25-seven-notfound-codes | medium | 2026-06-25 | 7 个 code 解析到空(NotFound)：open-platform-agent.proxy::embedding/rerank、video-agent.audio::tts、video/visual-agent.scene.codegen::code、workflow-agent.cli-agent/webpage-generator::code | 这些 code 真被调用时 | open | 存量隐患（无池无默认无 legacy 的冷门 modelType）；统一设计应显式暴露缺口或补默认 |
| 2026-06-24-appcaller-sync-no-delete | low | 2026-06-24 | AppCallerRegistrySyncService 只增不删，156 条 code 越积越多 | code 降级为标签时 | open | 改对账式 + DeletedAt 软删 + 面板一键清 |
| 2026-06-24-key-descend-rotation | high | 2026-06-24 | Protocol 下沉后更多 ApiKeyEncrypted 落到模型级，密钥轮换需先解密重加密所有字段 | 任何密钥轮换 | open | 受 cross-project-isolation.md 规则 #2 约束，迁移时不放大存量债 |
| 2026-06-24-openrouter-single-point | medium | 2026-06-24 | 默认走 OpenRouter 享受统一，但 OR 故障/限流/消费上限会全系统瘫（不止宕机，throttle 也是 SPOF） | OR 不可用或被限流时 | open | 必须保留一条直连兜底，这是池不能删干净、只能缩短的原因 |
| 2026-06-24-protocol-drift-3-places | high | 2026-06-24 | "协议绑平台"散在 3 处各写一遍：LlmGateway + ModelLabController + ArenaRunWorker 各自按 platformType 建 Claude/OpenAI 客户端，OpenAIImageClient 另有 anthropic 禁 /images 守卫 | 只改网关时 | open | 统一必须一起收口，否则修一漏三；回归测试 `ProtocolBinding_*_AllRouteThroughRegistry` |
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
| 2026-07-07-production-runner-channel | critical | 2026-07-07 | LLM Gateway 生产 shadow-start 已有 CI、镜像、preflight 和 dry-run 证据，但正式 stage 默认 runner `self-hosted,prd-agent-prod` 未注册，且 workflow 默认 token 无权查询 runner API；`fast.sh/exec_dep.sh` 不能在 GitHub-hosted runner 上冒充生产执行 | 执行 `LLM Gateway Production Stage` 的 `execute=true` 或继续 rollback/canary/http-full | open | 需恢复/注册生产 self-hosted runner，或配置具备 runner 查询权限的 `PRD_AGENT_PROD_GITHUB_TOKEN` 并提供等价生产主机执行通道；当前正式域名仍为旧 commit，`/gw/v1/healthz` 返回 admin HTML |
| 2026-07-07-prod-video-asr-upstream-unavailable | critical | 2026-07-07 | 生产 video/ASR raw 发布 gate 仍未闭合：`video-agent.videogen::video-gen` 绑定池不可用；APIyi `alibaba/wan-2.6`、`bytedance/seedance-2.0-fast` 均返回 no available channels；豆包 ASR 已补池并可解析，但真实 raw seed 返回 `Invalid X-Api-Key` | 全量 `LLMGW_MODE=http`、`canary-video-asr`、或宣称视频/ASR/字幕已迁移成功 | open | 已备份 `/root/backups/llmgw-prod-before-video-asr-evidence-20260707T070525+0800`、`/root/backups/llmgw-prod-before-restore-shadow-sample-20260707T073402+0800`、`/root/backups/llmgw-prod-before-video-reprobe-20260707T074011+0800`、`/root/backups/llmgw-prod-before-asr-pool-bootstrap-20260707T080433+0800`、`/root/backups/llmgw-prod-before-asr-seed-20260707T081332+0800`。生产仍为 `LlmGateway__Mode=shadow`、`LlmGateway__ShadowFullSamplePercent=1`、allowlist 空。2026-07-07 已用 `scripts/llmgw-prod-asr-pool-bootstrap.sh` 新增 `asr_doubao_bigmodel_pool` 并绑定四个 ASR caller：`document-store.subtitle::asr`、`transcript-agent.transcribe::asr`、`video-agent.v2d.transcribe::asr`、`video-agent.video-to-text::asr`。新版 upstream readiness 取证：四个 ASR caller 均解析为 DedicatedPool `doubao-asr-bigmodel` / `Exchange:豆包 ASR (BigModel)` / `protocol=exchange` / `Healthy`；视频仍返回“模型池内所有模型不可用”。同日备份后跑真实 MAP seed：`seed[1].session_chat` 成功，`seed[1].transcript_asr` 与 `seed[1].document_store_subtitle_asr` 均失败，错误为豆包 ASR `code=45000010, message=Invalid X-Api-Key`，证据文件在生产 `/tmp/llmgw-asr-seed-after-bootstrap.json`。只读 provider config audit 报告在生产 `/tmp/llmgw-provider-config-audit.json`：ASR key 可解密、长度 36、UUID 单 key 形态、`TargetAuthScheme=XApiKey` 合理；失败项为 no Healthy video-gen model 以及两个 ASR seed 失败。此前短时把原视频池健康恢复为 Healthy 且采样提到 100% 后跑 `--include-video-direct`，真实业务入口仍失败：`video direct upstream failed ... HTTP 404`，raw shadow `httpFail=5`。下一步必须补可用视频渠道和有效豆包 ASR key/resourceId，并重跑 `scripts/llmgw-prod-provider-config-audit.py --seed-evidence-json <new-seed>` 与 `scripts/llmgw-map-shadow-seed.py --include-video-direct --include-transcript-asr --include-document-store-subtitle-asr`，得到 `raw` allMatch 且 httpFail=0 后才可进入 video-asr 灰度。 |

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
- 结论更新：图片 raw 四类核心入口已经各自出现至少 1 条真实 MAP shadow 成功样本；视频、ASR、图片的跨进程 raw 能力不再是“完全未通”。但最近 24 小时/当前 commit 下仍有一条已归因的 vision policy httpFail 历史样本，且每个核心 appCaller 尚未达到 30 条、覆盖窗口尚未满 24 小时。因此仍禁止宣称全量迁移完成，下一步应从 clean-ref 时间点之后重新累计样本，并只允许按 allowlist 小批灰度。

## 已还的债务（归档）

> 修复后从上面表格挪到这里，保留以便复盘

| ID | 修复 PR | 修复日期 | 备注 |
|----|---------|---------|------|
| 2026-07-06-multipart-http-rehydrate | 待 PR | 2026-07-06 | 已实现 MAP 侧 inline multipart 上传为 `MultipartFileRefs`、serving `/gw/v1/raw` 侧按 ref 下载并校验 size/hash 后 rehydrate 为 `MultipartFiles`；新增 `GatewayMultipartHttpTests` 覆盖上传过线、rehydrate、hash mismatch 拦截。生产 shadow 样本与 allowlist 灰度仍是发布 gate。 |
