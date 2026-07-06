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
| 2026-07-07-prod-video-asr-upstream-unavailable | critical | 2026-07-07 | 生产视频/ASR raw 发布 gate 无法闭合：`video-agent.videogen::video-gen` 绑定池不可用；APIyi `alibaba/wan-2.6`、`bytedance/seedance-2.0-fast` 均返回 no available channels；ASR APIyi `whisper-1` 返回 no available channels；豆包异步 ASR 返回 Invalid X-Api-Key；豆包流式 ASR 返回 401 | 全量 `LLMGW_MODE=http`、`canary-video-asr`、或宣称视频/ASR/字幕已迁移成功 | open | 已备份 `/root/backups/llmgw-prod-before-video-asr-evidence-20260707T070525+0800` 与 `/root/backups/llmgw-prod-before-restore-shadow-sample-20260707T073402+0800`；生产已恢复到 `LlmGateway__Mode=shadow`、`LlmGateway__ShadowFullSamplePercent=1`、allowlist 空。2026-07-07 复跑 `scripts/llmgw-upstream-readiness.py` 对生产 `/gw/v1/resolve` 取证：视频返回“模型池内所有模型不可用”，两个 ASR caller 均返回“未找到可用模型”；DB 只读盘点显示视频 3 个池全为 Unavailable，ASR 无 `asr` 模型池，两个 ASR caller 的 `ModelGroupIds=[]`。必须补可用视频渠道和 ASR 密钥/模型池后重跑 upstream readiness 与 `scripts/llmgw-map-shadow-seed.py --include-video-direct --include-transcript-asr --include-document-store-subtitle-asr`，得到 `raw` allMatch 且 httpFail=0 后才可进入 video-asr 灰度。 |
## 已还的债务（归档）

> 修复后从上面表格挪到这里，保留以便复盘

| ID | 修复 PR | 修复日期 | 备注 |
|----|---------|---------|------|
| 2026-07-06-multipart-http-rehydrate | 待 PR | 2026-07-06 | 已实现 MAP 侧 inline multipart 上传为 `MultipartFileRefs`、serving `/gw/v1/raw` 侧按 ref 下载并校验 size/hash 后 rehydrate 为 `MultipartFiles`；新增 `GatewayMultipartHttpTests` 覆盖上传过线、rehydrate、hash mismatch 拦截。生产 shadow 样本与 allowlist 灰度仍是发布 gate。 |
