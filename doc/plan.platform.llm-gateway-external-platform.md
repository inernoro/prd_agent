# LLM Gateway 外部平台化与控制台体验收口 · 计划

> **版本**：v1.31 | **日期**：2026-07-17 | **状态**：全部完成并生产交付

## 1. 目标

把已经承载 MAP 生产 AI 流量的 LLM Gateway，从“内部可运维网关”推进为“外部团队可以安全、自助、低心智接入的统一 AI 治理平台”。

本计划不重做模型池、不重做 full-http 迁移，也不复制 OpenRouter。它只补齐五类有限能力：

1. 租户、用户、团队、成员和角色权限。
2. 外部系统可管理、可撤销、可审计的接入身份。
3. 网页版快速接入教程和四协议示例。
4. appCaller 级提示词前缀/后缀与版本化治理。
5. 面向普通使用者的控制台信息架构、图表和金额可信度。

## 1.1 执行目标与推进合同

本文件是本任务唯一计划和进度 SSOT，不再创建第二份并行计划。执行目标是按 PR-1 至 PR-5 依次完成外部平台化；每个 PR 必须独立评审、验证、发布和验收，前一个 PR 未完成时不得提前混入后一个 PR 的功能。

| PR | 当前状态 | 分支 | 独立完成门 |
|---|---|---|---|
| PR-1 | 已合并；CI、Codex Review、CDS 与预览验收通过；Bugbot 因订阅停用记为不适用 | `codex/llmgw-tenant-rbac` / [PR #1085](https://github.com/inernoro/prd_agent/pull/1085) | tenant/team/user/membership/RBAC、服务端租户解析、全租户数据隔离与跨租户拒绝测试 |
| PR-2 | 已合并；CI、CDS、直连预览和替代人工复审通过；Bugbot 不适用 | `codex/llmgw-service-key-quickstart` / [PR #1086](https://github.com/inernoro/prd_agent/pull/1086) | tenant-scoped service key、自助接入、四协议 Quickstart；四协议各一次真实请求，其余假上游 |
| PR-3 | 已合并；CI、CDS、直连预览和替代人工复审通过；Bugbot 不适用 | `codex/llmgw-prompt-policy` / [PR #1087](https://github.com/inernoro/prd_agent/pull/1087) | PromptPolicy 版本、预览、审计及 chat/vision 注入合同 |
| PR-4 | 已合并；CI、CDS、直连预览和替代人工复审通过；Bugbot 不适用 | `codex/llmgw-console-experience` / [PR #1088](https://github.com/inernoro/prd_agent/pull/1088) | 控制台 IA、左侧导航、首页、Activity 图表与金额可信度，多视口双主题验收 |
| PR-5 | 已合并；CI、CDS、直连预览和替代人工复审通过；Bugbot 不适用 | `codex/llmgw-final-platform-acceptance` / [PR #1089](https://github.com/inernoro/prd_agent/pull/1089) | 跨租户安全、四协议、完整接入流程和迁移收口验收 |

每个 PR 的固定流程：从最新 `main` 建独立分支 → 实现有限范围 → 本地静态、单元与行为测试 → 中文 commit → push → 创建独立 PR → 等待 CI、Codex Review、CDS → 直连预览域名验收 → 修复所有阻塞项 → 合并后再开始下一 PR。Bugbot 自 2026-07-12 起因用户停止续费而不再作为门禁，统一记录为不适用，不触发、不等待。

PR-1 证据（2026-07-12）：`prd-api`、`PrdAgent.Api.Tests`、`llmgw/console-api` 编译通过；.NET 8 容器连接临时 Mongo 实跑 Gateway 相关测试，0 失败；真实 `llmgw/console-api` HTTP 流程验证 tenant B 对 tenant A 的 team/key 列表泄漏为 0，跨租户资源写入返回 404，viewer 对审计和组织写入返回 403，无 membership 的租户切换返回 403，membership 版本变化后旧 token 返回 401。GitHub CI、四个相关镜像、Codex Review、CDS Deploy 与直连预览验收通过，PR #1085 已 squash 合并为 `19a33c7f4461eae24861f8ad59123b0ec0679389`。

PR-2 证据（2026-07-12）：保留既有 `gwk_*`、一次性明文和 SHA-256 存储；新增创建者、key prefix、可选 TeamId、来源 CIDR、有效期、每分钟限流与轮换关联。Developer 查询和撤销同时按 TenantId 与 CreatedByUserId 收口。serving 只从经过 trusted proxy 处理后的连接远端地址检查 CIDR；分钟窗口唯一索引包含 TenantId，首分钟并发 upsert 的 duplicate-key 竞争会转为非 upsert 原子递增。`llmgw/console-api`、`PrdAgent.LlmGateway` 与 `llmgw/web` 构建通过，Gateway 筛选测试 110 项、数据域守卫 55 项通过；本地真实登录浏览器已完成空列表、创建 key、一次性显示及桌面/移动 Quickstart 验收。最终提交 `b618d17f2` 的 GitHub CI 10 项成功、四镜像、CDS Deploy 和 smoke 3/3 通过，serving health 精确回显同 commit；独立控制台 Quickstart 深链返回 200，无法确认 serving origin 时的线上产物使用明确占位域名。Codex 自动复审因云端额度耗尽无法覆盖最终提交，按仓库 `human-verify` 完成正确性、错误处理、安全、边界、数据流与用户场景替代复审并修复发现的问题。PR #1086 已 squash 合并为 `f2550f2e298ec7621480facd77f33661de99d78c`；Bugbot 不适用。

PR-3 证据（2026-07-12）：新增 `llmgw_prompt_policies` 不可变版本集合，唯一索引为 TenantId + AppCallerCode + RequestType + Version；控制台 GET/预览/保存/回滚全部先以服务端会话 TenantId 过滤 appCaller 和策略。实跑临时库完成无版本、预览、保存 v1、陈旧版本 409、禁用 v2、回滚新建 v3，操作审计不含前缀/后缀正文。serving 只在四协议统一后的 chat/vision `messages` 应用策略，合并顺序为前缀、请求 system、后缀；raw/非 chat/vision 回归保持原请求。日志向上游发送合并正文，但 `RequestBodyRedacted` 只保留策略标记，`SystemPromptText` 置空，仅写 id/version/hash/chars。PromptPolicy 定向行为 4/4、日志脱敏 1/1、数据域守卫 58/58 通过；GitHub 标准 .NET 8 CI、四镜像与 CDS Deploy 全绿，CDS smoke 3/3，serving health 精确回显提交 `1c7073fa51e5c01f1508572bd5d70650d07f490d`。自动 Codex Review 因额度耗尽未生成结果，已用人工对抗审查替代并修复禁用策略回退与索引方向漂移。PR #1087 已 squash 合并为 `6b98efd19da42b39e9eeab0c79fee0ab8538afad`；Bugbot 不适用。

PR-4 本地证据（2026-07-12）：顶部收口为品牌、租户切换、requestId 搜索、文档和用户菜单，页面导航迁入工作区、路由、开发者、组织、治理、设置六组左侧栏；移动端使用可关闭抽屉。普通首页第一屏只呈现健康状态、四协议 Quickstart、最近请求与费用可信度，runtime gate、配置权威迁移和容器拓扑整体迁到 `/governance`。Activity 保留请求量图并增加状态分布图，费用汇总新增 `pricedRequests`、`unknownCostRequests`、`priceCoveragePercent` 与按原币种 `estimatedCosts`；只有 token 使用量对应价格快照完整的请求才计为 covered，只有明确 USD 快照进入 `EstimatedCostUsd`，没有 USD 样本时返回 null。临时 Mongo + 真实控制台后端验证四条日志中完整 USD 1.25、完整 CNY 8.00、无价格和仅输入价格两条均为 unknown，覆盖率 50%；部分 USD 估算未混入 USD 汇总，CNY 与 USD 未相加。租户列表由服务端 userId 与 TenantId membership 解析。浏览器验证桌面和移动无水平溢出、移动抽屉、深浅主题、两张 Activity 图、unknown 显示、requestId 全局搜索和筛选均通过，0 console warning/error。控制台构建、后端 0 warning/0 error、数据域守卫 61/61 通过。

PR-4 发布证据（2026-07-12）：最终提交 `5fba56b9552e161f16b74cb720b8be2c17a09311` 的 GitHub CI、四镜像、CDS Deploy 与 smoke 3/3 全绿，serving health 精确回显同 commit，独立控制台和 serving 深链均返回 200。Codex 自动复审因云端额度耗尽未生成结果，已用人工对抗审查替代并修复 requestId 同路由刷新与部分价格快照覆盖率两个缺陷。PR #1088 已 squash 合并为 `3217c862a8da7ce9fe78eef086e5b4a7a7dfd2f7`；Bugbot 不适用。

PR-5 精确计划（2026-07-12）：不再增加平台能力，只做有限验收收口。第一，修复生产治理验收脚本在 PR-1 后仍伪造无租户 claim JWT、Mongo 查询和清理缺少 TenantId 的漂移，改为通过真实控制台登录与 `/auth/context` 取得服务端租户。第二，用既有假上游合同覆盖 tenant-scoped key 的授权、越权、撤销和 GW Native、OpenAI、Claude、Gemini 四协议，不批量调用付费模型。第三，串联 PR-1 至 PR-4 的租户创建、密钥接入、PromptPolicy 元数据、Activity、费用可信度与桌面/移动证据，避免重复建设 full-http、模型池和发布 gate。第四，PR 分支在 CI、Codex Review 或替代人工复审、CDS、直连预览和完整测试租户清理全部通过后才能合并。

PR-5 证据（2026-07-12）：治理验收脚本已改用 `/gw/auth/login` 与 `/gw/auth/context`，所有临时配置、预算、并发租约、日志和审计清理均包含服务端解析的 TenantId，并删除对 JWT secret 和手工签名的依赖；脚本语法、默认 dry-run 与数据域静态守卫通过。四协议 fidelity 与 service-key 鉴权合同合计 179/179 通过，数据域守卫 62/62 通过，控制台前端 TypeScript 与生产构建通过。首页协议列表已与 Quickstart 的 GW Native、OpenAI、Claude、Gemini 对齐。最终融合验收使用真实 `llmgw/console-api`、真实 `PrdAgent.LlmGateway`、独立 Mongo 和本地假上游：从控制台创建测试租户与团队，保存 PromptPolicy v1，创建一次性 `gwk_*`，GW Native、OpenAI、Claude、Gemini 四协议各返回 200 并在 Activity 形成四条同租户日志；四次上游请求均按前缀、请求 system、后缀顺序应用策略，日志只保留 policy id/version/hash，未保存策略正文。切换回内部租户后，组织、key、appCaller、日志、usage 和策略审计均不可见；撤销 key 后 serving 返回 401。验收后逐集合检查测试 TenantId、租户、团队、membership 和用户引用均为 0。未增加付费调用。最终提交的 GitHub CI、四镜像和 CDS Deploy 全绿，独立预览首页、Quickstart 与 Activity 深链均返回 200。PR #1089 已 squash 合并为 `90559e64ed63594fa5cd43c922e9713ddb7622ed`。Codex 自动复审因云端额度耗尽未生成结果，已用人工对抗审查替代；Bugbot 不适用。

### 1.2 完成后产品化与生产硬化收口

前序五个有限 PR 完成后，针对真实用户反馈和生产发布事故继续采用独立 PR 收口，没有重新打开模型迁移、模型池调度或 full-http 发布 gate。

| 范围 | 状态 | 证据 |
|---|---|---|
| 控制台产品化与根目录收拢 | 已完成 | PR #1090 至 #1093 已独立完成双主题、请求记录中文化、自动 Gateway 地址与安全直测、租户首页、学习中心、模型池信息分层，以及根目录 `llmgw/` 原子收拢；详细证据继续由 `doc/plan.platform.llm-gateway.console-productization.md` 维护 |
| OpenRouter App 归因 | 已完成 | PR #1108 将 OpenRouter 出站标题统一为 `G-${appCallerCode}`，内部 `AppCallerCode` 原值、日志与路由语义保持不变；定向假上游测试捕获 `HTTP-Referer=https://prd-agent.miduo.org` 和 `X-OpenRouter-Title=G-product-agent.marketing-consult::chat`，非 OpenRouter 上游不注入 |
| 生产静态站恢复与防回归 | 已完成 | PR #1113 增加静态目录权限规范化、`index.html` 与实际入口资源完整性校验；生产恢复运行 `rel_624b31cda1c2046c` 成功，恢复前备份及 SHA256 校验保留于 `/root/backups/prdagent-static-recovery-rel_72243372921f35bb/`，恢复批次校验账本位于 `/root/backups/prdagent-static-recovery-rel_624b31cda1c2046c/SHA256SUMS` |
| 维护发布账本门禁 | 已完成 | PR #1115 修复维护发布继承基线配置时的重复门禁；CDS 运行 `dr_510b99aa22f211e8b5537e75` 与 main 部署 `dr_5a4dc114d09b3fcc86677661` 成功 |
| 公网与生产 Gateway 验收 | 已完成 | `https://map.ebcone.net/`、`/llmgw/`、`/gw/v1/healthz` 均返回 200；Gateway health 回显 commit `b905831619773d510738ec729cb1e5570ca4fe24`。最终 full-http 验证发布 `rel_86cad16c6368c125`、release gate、3 次 serving 稳定采样和 9 项受保护路由检查全部通过 |
| 临时生产权限清理 | 已完成 | 临时控制台用户、membership、service key 与 token 均已停用或删除；清理复核 `rel_14c4f9a0786d81ef` 返回临时用户和 membership 活跃数均为 0。生产目标 `rt_a4eefc0f7aed` 与临时目标 `rt_c00f704bfee3` 均已逐字段恢复原配置并设为禁用；没有重置任何既有用户密码 |

OpenRouter 页面中仍显示旧标题的三条记录，原始 JSON 时间为 `2026-07-13T14:09Z` 至 `14:10Z`，早于本次生产发布，且当前生产租户在相同时间窗没有对应 Gateway 日志，因此不能作为上线后回归证据。生产验收严格遵守一次真实 chat 上限：唯一真实请求实际路由到硅基流动，其余归因验证使用假上游和只读日志，没有追加第二次付费调用。后续首条自然命中 OpenRouter 的新请求应显示 `G-${appCallerCode}`；历史记录不会被改写。

### 1.3 低认知 Agent 复测与真实治理缺口

2026-07-14 使用一个不继承项目背景的独立 Agent，从公网入口模拟“首次接入 -> 理解租户 -> 获取 key -> 选择 OpenAI 协议 -> 安全测试 -> 复制 curl -> 定位请求和费用”。Agent 未使用生产账号、真实 key 或付费模型。公网首页和 health 均返回 200，生产 Gateway commit 为 `f6a0299b2845f125a28a160c8cace645f9b0e35f`。

| 发现 | 事实 | 结论 |
|---|---|---|
| 公开首次接入 | 未登录用户只能看到账号密码登录，没有申请账号、加入首个租户或联系管理员的入口 | 完整外部自助评分 4/10；预置账号和成员关系后约 8/10 |
| Quickstart key | key 创建与 Quickstart 分页；创建后不携带 appCaller；安全测试固定调用 `gw-native` 的 `route-self-test` | 仅授权 OpenAI 的 key 会在安全测试时因缺少 `gw-native` 或 `route:read` 返回 403 |
| 团队边界 | service key 创建只校验 TeamId 属于当前租户，没有校验 appCaller 是否属于同一 TeamId；serving 治理查询也只按 TenantId + appCaller + requestType | 团队 A 的 key 可被配置为调用团队 B 的 appCaller，属于真实缺口 |
| Developer 权限 | Developer 可以在自己创建的 key 中使用 `*` appCaller、协议或 scope | “只能管理自己的 key”不等于“只能创建最小权限 key”，需要限制通配符 |
| 成员生命周期 | membership disabled 会让控制台 session 失效，但不会自动处理该成员创建的长期 M2M key | 离职或移出租户后，历史 key 仍可能继续调用，需要显式所有权转移或撤销策略 |
| 成功请求归因 | scoped key 授权对象有 KeyId，但请求上下文和请求日志只保留 TenantId、TeamId、SourceSystem、appCaller，没有 ServiceKeyId | 当前不能精确回答“哪一把 key 发起了这次成功请求” |
| 费用 | 当前只保存 token、池成员价格快照、原币种估算和 USD 明确值，没有供应商账单金额、供应商请求 ID 和对账状态 | 现状是可复算的 estimated cost，不是 actual 账单双向对账 |

这些发现不推翻 PR-1 至 PR-5 的租户隔离结论：请求自报 TenantId 仍会被服务端 key/session 解析结果覆盖，跨租户读写、日志、预算、限流、取消和执行状态已有 TenantId 防线。补强重点是租户内部的 Team 边界、工作负载身份归因、身份生命周期和首次接入闭环。

### 1.4 后续五个有限 PR

后续补强继续一次只做一个 PR，不混回已经完成的 PR-1 至 PR-5，也不重做 full-http、模型迁移、模型池路由算法或发布 gate。

| PR | 范围 | 独立完成门 |
|---|---|---|
| PR-6 | Team/service key 对抗安全、会话与组织生命周期 | 团队 A 用户和 key 读取或调用团队 B 资源拒绝；Developer 通配 key 拒绝；Tenant、Team 或 Membership 停用后关联调用立即拒绝；改密后旧 token 失效；租户和新用户创建失败不留半成品；所有反例先红后绿 |
| PR-7 | 工作负载身份、密钥轮换与成功请求归因 | service key 增加 environment/clientCode；成功请求日志只写 ServiceKeyId、clientCode、key prefix 快照，不写 key/hash；Activity 可筛选调用身份；轮换流程明确区分新 key 已创建、客户端已切换、旧 key 已撤销 |
| PR-8 | Agent-first 一页式 Quickstart | 同页创建 appCaller 和一次性 key；测试使用所选协议的假上游或 dry-run；复制 curl、环境变量和 Agent Skill 接入包；直接跳到 requestId 日志 |
| PR-9 | 程序池类型、默认池原子切换与 append-only 默认池 | 类型注册表为唯一来源；租户初始化幂等创建默认池；默认池切换具备原子性且不能直接清空唯一默认池；平台模型只追加兼容且不存在的成员，不覆盖、不删除、不重排；特殊 appCaller 使用专属池 |
| PR-10 | 费用对账合同、环境独立 key 灰度与 legacy key 收口 | 内部复算与供应商账单分层；unknown 保持 unknown；测试与正式的 MAP runtime、release gate、canary、每个外部平台各用独立 key；legacy shared key 具备调用清单、截止时间和告警，双 key 观测后撤销 |

PR-6 已完成：PR [#1121](https://github.com/inernoro/prd_agent/pull/1121) 已合并，合并提交为 `02a503a2980f6ee19c60061f794fb98a834f1cfe`。两个租户、每租户两个团队、每团队两个用户与两把密钥的对抗矩阵，团队资源隔离、主体停用级联、Developer 通配拒绝、会话安全版本、创建补偿与并发窗口均已通过本地 Mongo、GitHub CI、CDS 和直连验收；Bugbot 不适用。

PR-7 完成证据（2026-07-15）：PR [#1122](https://github.com/inernoro/prd_agent/pull/1122) 已把 `ServiceKeyId`、`clientCode`、`environment` 和 key prefix 快照从服务端密钥鉴权结果贯通到成功与失败请求日志，日志模型不包含 key 或 KeyHash；Activity 列表、详情和全部聚合接口支持按三类调用身份筛选。隔离本地 Mongo 与真实控制台 HTTP 流程验证：切换前撤销旧 key 返回 409，确认切换后误撤新 key 返回 409，正确撤销旧 key 返回 200，完成态 key 可再次发起轮换并返回 201；撤销 key 的运行时鉴权返回 401 且仍保留非敏感审计身份。独立对抗审查发现并修复“上一轮未完成仍可链式轮换”和“确认切换与撤销新 key 并发造成部分状态”两个边界；自动复审继续发现并修复第二代 key 因保留 predecessor 而不能结束下一轮、无客户端 requestId 时失败日志重复、创建返回死 key、切换与中止竞态以及历史阶段缺失误恢复等问题。最终方案把新 key 先写为 `IssuanceState=creating`、`Enabled=false` 并从租户列表隐藏，交付响应前以条件更新切到可调用但仍不可查询、切换或撤销的 `delivering`，响应完成后最多重试三次收口为 `issued`，避免 201 后首调短暂 401；审计写入失败会恢复前驱、删除哈希目录并撤销新 key，返回 503 且不交付明文；极端情况下残留超过 30 秒的 `delivering` 会在同租户列表查询时收口为 `issued`，不形成永久隐藏且不可管理的 key。真实 Mongo failpoint、并发切换与中止、历史阶段缺失恢复以及创建后首调均通过。最终提交 `66d0aa9c7ceaf4e96f5c366803c939598c0c7234` 的 GitHub CI、四镜像、CDS Deploy、smoke 3/3 和公网 health 精确提交回显全部通过；PR #1122 已 squash 合并为 `218e3229bb8337cea6a151811eae7cf10b92ba00`。Codex Review 最终未返回结果，按 `human-verify` 完成替代复审；Bugbot 不适用，未触碰生产环境。

PR-8 完成证据（2026-07-15）：在 `/quickstart` 同页完成当前租户团队选择、appCaller 幂等创建、一次性团队 scoped key 签发、所选 GW Native/OpenAI/Claude/Gemini 真实协议路径 dry-run、requestId 日志直达，以及 cURL、环境变量和 Agent Skill 接入包复制。dry-run 先通过真实 service key、租户、团队、appCaller、协议和 scope 鉴权，在模型解析、预算预占和上游发送前结束；成功日志仅保存服务端解析的 TenantId、TeamId、ServiceKeyId、clientCode、environment 与 key prefix 快照，不保存明文 key 或 hash，费用字段保持 unknown。真实控制台与 serving HTTP 流程验证同一 appCaller 同团队重放返回同 id、跨团队抢占返回 409；OpenAI 兼容入口返回 `upstreamCalled=false`，日志列表与详情均能按 requestId 核对团队和工作负载身份。四协议假上游合同 1/1、数据域守卫 74/74、PrdAgent.Tests 654/654、Api.Tests 1598 通过与 4 跳过；Console API 0 warning/0 error，Serving 0 error，Web TypeScript 与生产构建通过。`human-verify` 发现并修复 console 独立启动缺少租户 appCaller 唯一索引、审计失败遗留未审计 appCaller、日志失败前先递增观察计数和日志 DTO 不返回 TeamId 四个问题。最终提交 `cfd240614770be945547607a05bc0cc4c6c908a3` 的 GitHub CI、console/serving/web 镜像和 CDS Deploy 运行 `dr_74b812510553b10d7f04b4e7` 全绿；CDS 5/5 服务运行且无运行漂移，三个 LLM Gateway 镜像均精确使用该提交，分层 smoke 3/3 通过。公网 `/quickstart`、`/gw/healthz` 及实际入口 JS/CSS 返回 200，Gateway health 精确回显该提交。隔离浏览器验收完成默认账号认领、一键创建、OpenAI dry-run、requestId 详情回查、桌面与移动无水平溢出、深浅主题和零 console warning/error；详情明确显示 Team、ServiceKeyId、client、environment、unknown cost 与 `upstreamCalled=false`。Codex Review 已覆盖最终提交且无改动建议；Bugbot 不适用。隔离测试数据库、临时账号、token 和一次性 key 已全部清理；未调用付费上游，未修改生产环境、共享预览账号或既有密码。

PR-9 完成证据（2026-07-15）：新增 tenant-scoped `llmgw_model_pool_types` 类型注册表，默认池权威从跨文档布尔标记改为 `TenantId + Code + DefaultPoolId` 单文档原子指针；运行时先按该指针解析，类型文档存在但指针失效时 fail-closed，不回退历史布尔值。新租户及幂等创建重放会初始化 13 类默认池，存量租户仅允许 `ConfigWrite` 显式补齐，Viewer 的 GET 不产生写副作用。平台托管默认池只接受来自同租户 enabled 平台权威模型的兼容成员，使用不存在条件的原子 Push；不允许覆盖、删除、重排、伪造价格/币种/协议、历史 MAP 认领覆盖或价格币种批量校准。特殊 appCaller 的 pinned 模型必须位于专用池内，并继续按池候选解析以保留池级路由、费用和审计语义。独立刁钻审查发现并推动修复 Viewer 触发写入、专用池被误收编、负向能力误判、并发初始化 E11000、整数组写回丢成员、默认切换与删除最后成员 TOCTOU、伪造价格及旧维护端点绕过等反例。隔离 Mongo 与真实 Console HTTP 已完成：32 路并发初始化全部 200，最终 13 类与 13 个唯一默认池；16 路并发补齐后 chat 与 embedding 各只追加正确模型，orphan 和 disabled-platform 模型均未进入；伪造 CNY/零价格写入后落库仍为模型权威 USD 3/4；100 路 A/B 默认切换为 37 次成功、63 次受控 409，最终恰好一个默认；30 轮切换与删除最后成员交叉并发未出现空默认。Gateway 专项测试 115/115，Console API 与 Web 构建、GitHub CI、四个相关镜像和 CDS Deploy `dr_d18d2bb6073068177d9580fe` 全绿；CDS 5/5 服务精确运行提交 `f2b1a1c60c348e39923a50197469b9798079e28f`，公网 `/pools` 与 `/gw/healthz` 返回 200。隔离浏览器完成一键补齐、托管只追加说明、详情维护边界、桌面与移动无横向溢出、深浅主题及零 console warning/error 验收。PR [#1126](https://github.com/inernoro/prd_agent/pull/1126) 已 squash 合并为 `cc6c9eebaf46c61f1c894195cf7dde523a475604`；Bugbot 不适用，未调用任何上游或修改生产配置。

PR-10 精确计划（2026-07-15）：第一，在请求完成时从既有价格字段生成不可逆 `PriceSnapshotHash`，从供应商响应头提取 `ProviderRequestId`；估算字段仍按请求时快照复算，任一价格或 token 缺失继续保持 unknown。第二，新增 tenant-scoped 供应商账单导入与对账记录，逐请求通过 `TenantId + provider + ProviderRequestId` 关联，供应商仅提供汇总账单时按明确时间窗和 ServiceKeyId 记录 window 粒度；原始 estimated 与 provider actual 不互相覆盖。相同币种才直接计算 delta，不同币种只有同时提供 `FxSnapshotId` 与明确汇率才换算，否则状态为 `fx-unavailable` 且 delta 为 null。第三，在现有 `clientCode + environment` 上增加单值 key purpose，固定为 `runtime`、`release-gate`、`canary`、`external-platform`；同一把 key 不能跨用途或环境，控制台展示 MAP 测试/正式三个用途以及每个外部平台的独立 key 覆盖缺口，轮换继承原用途。第四，legacy shared key 仅允许 `sourceSystem=map`，每次调用按 internal TenantId、appCaller、协议和来源形成清单；tenant-scoped 收口策略保存截止时间、允许清单、后继 scoped key 与状态，过期或 revoked 后返回 401，外部来源始终拒绝。生产撤销仍必须在双 key 观测达标后由人工显式执行，本 PR 只交付能力、假数据和隔离环境验收，不改生产 key、Secret 或任何用户密码。

PR-10 本地证据（2026-07-15）：请求日志新增不可逆价格快照哈希和仅来自供应商响应头的请求 ID；tenant-scoped 对账记录支持 request/window 两种粒度，外部导入体不接受 TenantId，查询、唯一索引、团队范围、审计和汇总均由服务端租户上下文约束。供应商 actual 与内部 estimated 分栏保存，不相互覆盖；未知估算保持 null，相同币种才计算 delta，跨币种无 `FxSnapshotId` 与汇率时返回 `fx-unavailable`。逐请求重复账单、同 request ID 不同外部记录、重叠窗口、已逐请求对账后再覆盖窗口、已存在窗口后再导入逐请求均返回受控 409；汇总使用全量 Mongo 聚合，不受详情 500 条上限影响，非数值 actual 不会被折算为 0。密钥用途固定为四类，来源与用途不匹配、跨用途或跨环境轮换均拒绝；Quickstart 只签发 `external-platform`。legacy shared key 只对 internal MAP 生效，外部租户 403，过期或撤销 401；每把后继 scoped key 都必须分别达到观测阈值才能人工撤销，撤销状态不可恢复。隔离 Mongo 与真实 Console HTTP 已验证恶意 body 自报 tenantId 不改变归属、相同 provider request id 可被两个租户各自隔离对账、内部租户不可读取外部记录、unknown 不显示 0、CNY 与 USD 无汇率不相加、幂等重试与冲突、双粒度防重复、用途边界和每后继观测门。完整解决方案构建 0 error，Web TypeScript 与生产构建通过；Api.Tests 1604 通过、4 个既有显式跳过，PrdAgent.Tests 659 通过，合计 2263 通过、0 失败。首轮 GitHub CI 与相关镜像全绿，CDS 在共享存量库正确发现旧四字段索引与新增 `Purpose` 五字段索引同名冲突并阻断启动；修复改为新增版本化索引名，保留旧索引。隔离库先创建旧索引后，Console 与 Serving 均成功启动且两个索引并存，两个 health 端点返回 200；随后完整构建和 2263 项回归再次通过。所有上游场景使用假数据或隔离数据库，未调用付费模型，未修改生产 key、Secret、账号或密码。

PR-10 真实接入复验补充（2026-07-15）：第二轮 GitHub CI 与 CDS run `dr_f747e9671cbafd21b138428b` 已通过，五个服务均运行目标 commit。使用唯一临时外部租户从移动端依次完成登录、创建团队、一键生成 appCaller 与 `external-platform` key，并对网页展示的同源 `/v1/chat/completions` 地址执行零费用 dry-run；该真实用户路径发现 llmgw-web 内层 nginx 只代理 Console `/gw/*`，兼容协议 POST 被 SPA 静态层返回 405。修复为在 SPA fallback 前把 `/gw/v1/*`、`/v1/*`、`/v1beta/*`、`/gemini/v1beta/*` 明确代理到 `llmgw-serve:8091`，并允许 vision 请求体通过内层 nginx。同轮还发现外部租户页面展示 MAP runtime/release-gate/canary 覆盖，且可自报 `sourceSystem=map`；服务端现以会话中的 `IsInternalTenant` 强制拒绝外部租户创建 MAP 内部用途 key，前端对外部租户固定显示 `external` 与 `external-platform` 并隐藏 MAP 覆盖。

PR-10 最终远程证据（2026-07-15）：修复提交 `0e25a3cb1975a166098009fc21844eebc347dc8c` 的 GitHub CI、四个相关镜像、Server Build & Test 与 CDS Deploy `dr_c699dc6cfd827e5b2d7b362a` 全绿；CDS 5/5 服务均运行该提交，无缺失、异常或提交漂移。隔离外部租户从网页完成团队创建，并为 OpenAI、Claude、Gemini、GW Native 四种协议分别执行一次 Quickstart：每次均通过团队边界和密钥鉴权、生成 requestId、写入租户请求记录并明确 `upstreamCalled=false`，未访问付费上游。外部租户创建表单固定为 `sourceSystem=external`、`purpose=external-platform`；直接伪装 `sourceSystem=map` 与 `purpose=runtime` 返回 403 `INTERNAL_KEY_PURPOSE_FORBIDDEN`。390x844 深色与浅色、1280px 浅色均无横向溢出，浏览器 warning/error 为 0。验收数据首次清理删除 TenantId 关联记录 30 条、用户 1 条、租户 1 条，再次遍历全部目标集合和 identity 计数均为 0；一次性辅助程序与内存凭据已删除。未修改生产数据、生产 key、Secret 或任何既有账号密码；Bugbot 因订阅停用记为不适用。

PR-10 最终审查反馈（2026-07-15）：Codex Review 在提交 `0e25a3cb1` 上新增四条未过时意见。legacy shared key 的 GW Native 请求必须和 scoped key 一样从 body 解析 MAP/appCaller 身份；导入体省略 `providerReportedCost` 必须返回 400，不能把缺失值当成实际 0；无 ServiceKeyId 请求只能被 tenant/team/provider 相同且同样无 ServiceKeyId 的窗口覆盖；开发 compose 必须运行 `llmgw-serve`，否则 llmgw-web 新增的四协议代理在本地返回 502。四项均纳入本轮修复和回归，修复后重新等待 CI、CDS 与受影响链路验收，不沿用先前完成结论直接合并。

PR-10 审查修复验收（2026-07-15）：提交 `3d3c5f568babe6ed09b422cf7e1a8e7f8464fcfe` 已完成上述四项修复。legacy shared key 的 GW Native body 身份动态契约通过；供应商 actual 改为必填可空 DTO 后显式校验，隔离 Mongo 与真实 Console HTTP 验证省略字段返回 400 `INVALID_PROVIDER_COST`；已存在 keyed 窗口时，无 ServiceKeyId 请求仍可独立导入 actual 并返回 201，不再被错误覆盖；开发 compose 已补齐 `llmgw-serve`，配置解析通过。完整回归为 Api.Tests 1605 通过、4 个既有显式跳过，PrdAgent.Tests 659 通过，合计 2264 通过、0 失败；GitHub CI、Console/Serving/Web/API 镜像、Server Build & Test 与 CDS Deploy `dr_1419000f52a111029369b05d` 全绿。CDS 五个服务均运行目标提交，无缺失、异常或提交漂移；公网 `/gw/healthz` 与 `/gw/v1/healthz` 均返回目标提交，远程一次性外部租户再次验证缺失供应商 actual 返回 400。四协议不重复调用，沿用同源代理未改动时已完成的每协议一次 dry-run 证据，继续保持 `upstreamCalled=false`。本轮临时数据首次清理删除 TenantId 关联记录 2 条、用户 1 条、租户 1 条，第二遍全部为 0；一次性辅助文件和内存凭据已删除。未调用付费模型，未修改生产数据、生产 key、Secret 或任何既有账号密码；Bugbot 因订阅停用记为不适用。

PR-10 最终安全复核补充（2026-07-15）：线程级复核发现外部租户仍可提交 `sourceSystem=*`，由于通配来源可在 Serving 匹配 MAP 流量，仅限制显式 `map` 不足以形成来源边界。本轮改为所有 service key 均必须声明明确来源，服务端拒绝通配来源并返回 400 `INVALID_KEY_SOURCE`；外部租户仍只能使用 `external-platform` 用途。修复提交 `448cf7817d217542ad96bab97676e67d8c48d563` 的 Console 编译 0 警告、0 错误，定向守卫 1 项通过，与 CI 一致的完整非集成、非手工回归为 2264 通过、4 个既有显式跳过、0 失败；GitHub 相关镜像、Server Build & Test、CI Status 与 CDS Deploy `dr_9e55d05d8061a41e3055915e` 全绿，CDS 五个服务均运行目标提交且无漂移。公网健康端点返回目标提交；一次性外部租户从公网提交通配来源 key，返回 400 `INVALID_KEY_SOURCE`，没有生成 key。临时数据首次清理删除 TenantId 关联记录 2 条、用户 1 条、租户 1 条，第二遍全部为 0；辅助文件和内存凭据已删除。未调用付费模型，未修改生产数据、生产 key、Secret 或任何既有账号密码；Bugbot 因订阅停用记为不适用。

PR-10 最终链路审查补充（2026-07-15）：最新 Codex Review 发现普通、流式与 raw 的常规完成日志仍用合成响应头，导致供应商真实 request id 在进入 `LlmRequestLogBackground` 前丢失；同时 legacy 退场配置只校验 MAP 来源，test/development key 可能被当作生产后继累计观测并误触生产撤销。本轮要求日志只保留 content-type 与受信 request id 头，三类常规完成链路均透传真实响应头且不记录 cookie 等其他头；legacy 后继配置只接受 production MAP scoped key，Serving 对非 production key 不累计后继观测。修复后重新执行动态契约、完整回归、CI、CDS 和假上游逐请求对账验收，未通过前不得合并。

PR-10 最终验收结论（2026-07-15）：最终代码提交 `e0b2ae40d6c0a48a77b8d3910440e7c929b5790a` 把 legacy 只读预检限定为服务端识别的受信 route-self-test/readyz 场景，并保证预检和普通 `route:read` 不累计退场证据，只有 `invoke`、`stream:invoke`、`raw:invoke` 三类真实业务调用计数；后继 key 必须是 production MAP runtime 身份并覆盖 legacy 允许的 appCaller、四协议和完整运行 scopes。密钥 Purpose 数据面门固定为 MAP 普通流量仅 `runtime`、`release-gate` 仅受信只读预检、`canary` 在没有专用受信路由前对普通数据面 fail-closed、外部租户仅 `external-platform`，所有 service key 禁止通配来源。供应商 request/window 导入由 `TenantId + Provider + TeamId` 原子短租约串行，逐请求幂等重试会修复日志 actual 投影；estimated 与 actual 不互相覆盖，unknown 不显示为 0，跨币种没有可审计 FX 快照时 delta 保持 null。隔离 Mongo 动态契约与完整非集成、非手工回归最终为 Api.Tests 1618 通过、4 个既有显式跳过，PrdAgent.Tests 660 通过，合计 2278 通过、0 失败；GitHub CI 0 失败。Codex Review 最终未发现重大问题，最终提交无新增行级意见，18 条审查线程未解决数为 0。CDS 精确运行 `dr_9c337f2b2bf0f761c7c121e6` 在提交 `e0b2ae40d6c0a48a77b8d3910440e7c929b5790a` 上完成，生成不可变版本 `dv_f1b30fc3b55c1a086eb9e22d`，5/5 服务就绪、无漂移且 `smokeOk=true`；API、Console、Serving 与 Web 镜像均使用该提交。公网 `/gw/healthz` 与 `/gw/v1/healthz` 返回 200 并精确回显该提交。Bugbot 因订阅停用记为不适用；未调用付费模型，未修改生产数据、生产 key、Secret、账号或任何既有密码。

### 1.4.2 最终交付补洞：关联配置就地预览

2026-07-17 按“用户无需跳页验证关联字段”的交付自检，确认四个剩余体验断点：Provider 的接口信息只能读表格、模型到 Provider 需要跨页比对、appCaller 绑定模型池后看不到候选与健康、Exchange 的 adapter 与目标路由需要进入编辑页理解。本批只新增一个复用的只读关联抽屉，在 Provider、模型、appCaller 和 Exchange 当前行或卡片展示已有权限范围内的配置摘要；不新增 API、不改变路由、不读取密钥明文、不发起上游请求，也不重做模型池、full-http 或发布 gate。

完成证据：四类预览均通过键盘 Escape、关闭后焦点返回、移动端单列滚动和安全边界检查；Web 生产构建 1620 个模块通过，Gateway 定向测试 174/174 与 647/647，解决方案构建 0 error，完整非集成套件为 PrdAgent.Tests 679/679、PrdAgent.Api.Tests 1702 通过与 4 个既有跳过。浏览器只通过可见导航连续走完 113 个证据点，覆盖深色、浅色、390 像素移动端、系统运维入口、发布 Gate 和三个独立 Gateway 容器，0 warning、0 console/network 自动发现；四协议合同套件另有 92/92 真实执行结果。PR #1168 已合并为 `ab560ba28cc0b6a973b2c276c14d8cbfd8d5d4b3`；GitHub CI、Codex Review、CDS exact commit、smoke 3/3 和公网预览均已通过。最终 L2 验收报告与 MAP 生产发布、备份、临时 Key 撤销证据统一记录在 §9.1，本批状态为已生产交付。

每个 PR 都必须等待 CI、Codex Review 或替代人工复审、CDS 和验收。Bugbot 因订阅停用记为不适用。生产 key 切换固定使用“清单 -> 新 key -> 双 key 并存 -> 按 ServiceKeyId 观测 -> 撤销旧 key”，禁止直接覆盖共享 key，也禁止修改任何既有用户密码。

### 1.4.1 对抗安全执行账本

2026-07-14 在已有跨租户验收之上增加团队内部、身份生命周期、并发一致性和失败原子性反例。以下“确认缺陷”来自静态控制流和数据流审计；在对应 PR 中必须先写失败测试复现，再修改运行时代码。未完成动态复现前不得把静态结论升级为生产事故结论。

| ID | 风险 | 静态事实 | 归属 PR | 验收断言 |
|---|---|---|---|---|
| ADV-01 | Team A 用户读取 Team B 日志或请求正文 | Developer、Viewer 拥有日志与请求正文权限，公共数据过滤仅包含 TenantId，没有使用会话 TeamIds | PR-6 | 非 Owner/Admin 读取非所属 TeamId 的列表、详情、汇总、会话和元信息均返回空或 404 |
| ADV-02 | Team A key 调用 Team B appCaller | key 创建只校验 TeamId 属于租户，appCaller 治理只按 TenantId、AppCallerCode、RequestType 查询 | PR-6 | key.TeamId、appCaller.TeamId、运行时 TeamId 任一不一致均返回 403，并写 tenant-scoped 拒绝审计 |
| ADV-03 | Tenant、Team 或 Membership 停用后历史 key 继续调用 | scoped key 鉴权只复查 key Enabled、过期时间和 scope，没有复查租户、团队或创建者成员状态 | PR-6 | 三类主体任一停用后，关联 key 下一次请求立即拒绝；Owner 显式转移所有权的 key 除外 |
| ADV-04 | Developer 创建通配超级 key | appCaller、协议和 scope 当前允许 `*`，Developer 没有额外最小权限约束 | PR-6 | Developer 使用任一 `*` 创建返回 403；Owner/Admin 必须二次确认且写高风险审计 |
| ADV-05 | 改密后旧 JWT 继续有效 | JWT 有效期 12 小时，token 只携带 Membership Version，改密不提升用户安全版本 | PR-6 | 改密、停用用户和强制退出后，全部旧 token 下一次请求返回 401；其他用户不受影响 |
| ADV-06 | 创建租户或成员中断留下半成品 | tenant、team、membership、user 当前分多次写入，只对部分 DuplicateKey 路径补偿 | PR-6 | 对每个可捕获写失败执行补偿后，租户、团队、成员和用户引用要么全部存在，要么全部不存在；按 slug 或成员目标重复提交重放既有结果。进程硬退出不伪称事务原子，进入 `2026-07-14-tenant-provision-crash-consistency` 债务，在开放匿名注册前用 pending 状态机和修复器偿还 |
| ADV-07 | 轮换 key 后旧 key 仍被误认为已撤销 | RotatesKeyId 当前只记录关联，不改变旧 key 状态 | PR-7 | UI 和 API 返回明确轮换阶段；只有完成撤销后才显示“轮换完成”，旧 key 随后返回 401 |
| ADV-08 | 成功请求无法定位具体 key | 授权结果包含 ServiceKeyId，但成功请求日志没有持久化该调用身份 | PR-7 | 每条成功和失败请求均可按 TenantId、TeamId、ServiceKeyId、clientCode 查询；不保存明文或 hash |
| ADV-09 | 两个管理员并发切换默认池得到零默认池 | 当前流程分别执行“本池置默认”和“清其他池”，交错执行可互相清空 | PR-9 | 至少 100 轮并发切换后，每个 TenantId + ModelType 恰好一个默认池；失败不改变旧默认 |
| ADV-10 | 通用更新直接取消唯一默认池 | 通用模型池更新允许直接写 `IsDefaultForType=false` | PR-9 | 取消唯一默认池返回 409；只能通过另一个具备可用成员的池完成替换 |
| ADV-11 | legacy shared key 泄漏后进入内部租户 | legacy key 仍直接映射 internal tenant，不具备 scoped key 的团队和工作负载身份 | PR-10 | 建立 legacy 调用方清单、告警与截止时间；外部来源永远不能使用 legacy key；收口后 legacy key 返回 401 |

PR-6 的最小测试矩阵固定为两个租户、每租户两个团队、每团队两个用户和两把 key。测试必须同时覆盖列表、详情、汇总、写入、调用、停用、改密和失败注入，禁止只验证正常 CRUD。PR-7 至 PR-10 复用同一矩阵和假上游，不增加批量付费调用。

PR-6 的 owner 变更租约覆盖常规并发和版本冲突，但不把“进程暂停超过租约后恢复”宣称为已解决；该多副本 fencing 边界记录在 `2026-07-14-owner-mutation-lease-fencing`，必须在开放外部组织自主管理前偿还。

### 1.5 目标架构与影响边界

```text
Agent / 外部平台 / MAP workload
  -> environment + clientCode + tenant-scoped service key
  -> 四协议适配层（GW Native / OpenAI / Claude / Gemini）
  -> 服务端解析 TenantId / TeamId / ServiceKeyId
  -> appCaller 治理（状态 / RBAC / 限流 / 预算 / PromptPolicy）
  -> 程序池类型注册表
       -> 默认池：租户初始化时幂等存在
       -> 专属池：特殊 appCaller 显式绑定
  -> 池成员（只追加兼容模型，不覆盖既有成员配置）
  -> GW 平台模型 / Exchange
  -> 供应商
  -> 请求日志（tenant + key identity + route + token + price snapshot）
  -> 费用层（estimated 复算 / provider actual / reconciliation）
```

新平台提供的模型先进入租户范围内的平台模型目录，再按能力匹配追加到已存在的默认池或专属池。模型目录、池和 appCaller 是引用关系，不复制模型，也不改写 MAP 已有模型标识。没有匹配类型、模型不可用、价格币种不明或池不存在时均保持原状，不自动创造业务语义。

### 1.6 费用双向校验合同

费用分三层，不能把三者混成一个金额：

1. `estimated`：使用请求完成时保存的 input/output/cache token 与价格快照复算；价格不完整时为 unknown。
2. `provider actual`：供应商响应或账单导入的实际金额，必须同时记录 provider request id、币种和账单时间窗。
3. `reconciled`：以 TenantId、ServiceKeyId、provider、provider request id、模型和时间窗关联 estimated 与 actual，记录差额和状态，不覆盖原始值。

新增字段只保存非敏感证据：`ServiceKeyId`、`ClientCode`、`Environment`、`ProviderRequestId`、`ProviderReportedCost`、`ProviderCostCurrency`、`PriceSnapshotHash`、`FxSnapshotId`、`ReconciliationStatus`、`ReconciliationDelta`。没有供应商金额时状态为 `actual-unavailable`；没有汇率快照时不同币种禁止计算差额。供应商不提供逐请求费用时，只能做账单时间窗汇总对账，页面必须明确粒度。

### 1.7 可复用经验

- 身份、业务用途和路由必须分开：key 表示“谁在调用”，appCaller 表示“为什么调用”，模型池表示“去哪里调用”。禁止再用一个字段承担三种语义。
- 安全自测必须使用与用户所选协议完全一致的授权合同；不能让 OpenAI key 隐式依赖 GW Native scope。
- 所有首次接入必须形成零费用闭环：生成身份、测试鉴权、产生 test-mode 记录、跳到日志；真实付费请求是可选下一步。
- 默认配置只能幂等补齐和 append-only 增强；已有池成员的优先级、价格、协议和参数能力均不得被批量导入覆盖。
- 金额先标来源再展示数值。estimated、actual、unknown 和 reconciled 是四种状态，不是四个 UI 文案。
- 生产密钥永远先增加、后观测、再撤销；不原地覆盖，不重置用户密码，不把 key 写入仓库、日志、命令行参数或聊天。
- 外部易用性必须由无背景 Agent 实测；“登录后能用”不能替代“从公开入口能开始”。

执行期间保持以下边界：

- 不重做 full-http、模型迁移、模型池、配置权威或发布 gate。
- 不在相邻 PR 之间夹带实现；为后续 PR 预留的 DTO、路由或页面必须等对应 PR 再增加。
- 不批量调用付费模型；每类真实协议最多一次，其余使用假上游和固定数据。
- 所有进度以本节状态表、GitHub PR 证据和 CDS 验收结果为准，不用聊天文字替代落盘状态。

## 2. 当前事实

### 2.1 已有能力，不得重做

| 能力 | 当前事实 |
|---|---|
| 生产执行 | MAP 已运行 `Mode=http`，活跃 appCaller 的 MAP 配置 fallback 已关闭 |
| 协议入口 | GW Native、OpenAI-compatible、Claude-compatible、Gemini-compatible 已进入统一 IR |
| 配置权威 | appCaller、模型池、平台、模型、Exchange、上游 key 已归 `llm_gateway` |
| 外部密钥基座 | 已有 `gwk_*` scoped service key，支持 appCaller、ingress protocol、scope、过期时间和撤销 |
| 日志与审计 | 请求日志、shadow、登录审计、操作审计已独立写入 `llm_gateway` |
| 发布保障 | 同 commit 发布、runtime gate、回滚演练和六类一次性验收已落地 |

### 2.2 真正缺失

| 缺口 | 当前问题 |
|---|---|
| 租户体系 | PR-1 已补齐租户归属与数据隔离；PR-2 已补齐 key 自助约束和接入体验 |
| 用户与团队 | PR-1 已补齐 tenant/team/user/membership/RBAC；PR-2 已完成网页组织入口和自助流程 |
| 外部开发者体验 | PR-2 已补齐网页版四协议 Quickstart、错误排查和 requestId 定位 |
| appCaller 提示词策略 | PR-3 已补齐版本、预览、回滚、审计以及 chat/vision 应用 |
| 首页可理解性 | PR-4 已把普通用户首要任务前置并通过独立发布门验证 |
| 导航 | PR-4 已落地左侧分组导航与移动抽屉并通过独立发布门验证 |
| 金额可信度 | PR-4 已区分 estimated/unknown 并按原币种汇总，通过独立发布门验证 |
| 图表 | PR-4 已完成请求量、状态分布、空态、窄屏与双主题验收 |

## 3. 产品与数据边界

### 3.1 身份层级

```text
Tenant
  -> Team
     -> Membership(User + Role)
     -> AppCaller
     -> ServiceKey
     -> Budget / RateLimit / PromptPolicy
```

角色固定为：

| 角色 | 权限 |
|---|---|
| `owner` | 租户所有权、成员、账单、全部配置 |
| `admin` | 团队、appCaller、模型池绑定、key、审计 |
| `developer` | 创建和撤销自己范围内的 key、查看调用日志和教程 |
| `viewer` | 只读日志、统计、配置 |
| `billing` | 只读费用、预算和用量，不读取请求正文 |

硬约束：tenant 必须由登录会话或 service key 服务端解析，禁止相信请求 body/header 自报的 tenantId。所有 `llm_gateway` 业务集合必须带 `TenantId`；团队资源再带 `TeamId`。查询、唯一索引、审计和预算必须包含租户边界。

### 3.2 service key 演进

保留现有 `gwk_*` 和 scope 语义，在其上增加：

- `TenantId`、可选 `TeamId`、创建人、名称、前缀、最后使用时间。
- key 明文仍只显示一次，数据库只存 hash。
- 可限制 appCaller、协议、scope、来源 CIDR、到期时间和每分钟限流。
- 轮换采用“新旧短时并存 -> 客户切换 -> 撤销旧 key”，不能原地显示旧明文。
- 兼容现有 MAP 内部共享 key，但新外部租户不得使用内部共享 key。

### 3.3 appCaller 提示词策略

新增版本化 `PromptPolicy`，至少包含：

| 字段 | 说明 |
|---|---|
| `TenantId/TeamId/AppCallerCode/RequestType` | 策略作用域 |
| `SystemPromptPrefix` | 请求系统提示词前追加的治理内容 |
| `SystemPromptSuffix` | 请求系统提示词后追加的补充内容 |
| `Enabled/Version` | 启停和乐观并发版本 |
| `AllowedVariables` | 允许插值的变量白名单，禁止任意表达式执行 |
| `MaxChars` | 长度上限 |
| `CreatedBy/UpdatedBy/UpdatedAt` | 审计字段 |

合并顺序固定为：平台安全策略 -> 租户策略 -> 团队/appCaller 策略 -> 请求自身 system prompt。日志只记录 policy id、version、hash 和字符数；默认不重复存储完整敏感提示词。

提示词策略首版只作用于明确支持 system instruction 的 `chat/vision`。图片、视频、ASR、raw passthrough 不允许静默拼接，除非对应 adapter 有显式合同测试。

## 4. 控制台目标信息架构

顶部只保留全局上下文：品牌、租户/团队切换、全局搜索、开发文档、用户菜单。

左侧导航分组：

| 分组 | 页面 |
|---|---|
| 工作区 | 概览、Activity/日志、appCaller |
| 路由 | 模型池、模型、平台、Exchange |
| 开发者 | Quickstart、API Keys、协议参考、错误码 |
| 组织 | 团队、成员、角色 |
| 治理 | 预算与用量、审计、shadow、运行状态 |
| 设置 | 租户设置、安全、保留策略 |

首页第一屏必须回答四件事：

1. 网关现在是否可用。
2. 如何在五分钟内发出第一条请求。
3. 最近请求是否成功、失败在哪里。
4. 当前金额是否可信，可信度和价格覆盖率是多少。

容器拓扑、config-authority、runtime gate 等内部发布信息移到“治理/运行状态”，不得继续占普通用户第一屏。

## 5. 金额与图表规则

- 金额区分 `actual`、`estimated`、`unknown`，不得把 unknown 渲染成 `$0.00`。
- 没有价格快照的请求显示“缺价格”，并展示价格覆盖率，例如“73% 请求可估算”。
- CNY 与 USD 不直接相加。需要换算时必须记录汇率来源和时间；首版可按原币种分组，避免伪精确。
- `Estimated USD` 只能汇总明确为 USD 或有可审计换算记录的数据。
- 图表必须验证非空像素、横纵轴、时间范围、tooltip、零值、单点、窄屏和双主题。
- 日志详情展示本次请求使用的价格快照，不回算历史价格。

## 6. 网页接入教程

新增 `/docs` 或 `/quickstart`，不要求用户先理解模型池。页面至少包含：

1. 创建租户/团队与 service key。
2. 选择或创建 appCallerCode。
3. GW Native、OpenAI、Claude、Gemini 四种可复制示例。
4. `auto/pool/pinned` 的最短解释和示例。
5. 流式、图片、vision、ASR、视频的能力边界。
6. 401/403/404/409/429/5xx 的排查方式。
7. requestId 如何在 Activity 中定位。

示例必须使用占位 key，不允许把真实生产 key 写入 HTML、日志、截图或仓库。

## 7. 有限 PR 顺序

| PR | 范围 | 完成门 |
|---|---|---|
| PR-1 | tenant/team/user/membership/RBAC 数据模型与服务端租户隔离 | 跨租户读写、key 冒用、审计越权测试全部拒绝 |
| PR-2 | tenant-scoped service key、自助接入、四协议 Quickstart | 新租户从网页创建 key 后四协议各成功一次；越权 403、撤销后 401 |
| PR-3 | appCaller PromptPolicy、版本、预览、审计和 chat/vision 应用 | 前缀/后缀顺序、禁用、版本冲突、日志 hash、raw 不误注入测试通过 |
| PR-4 | 控制台信息架构、左侧导航、首页、Activity 图表与金额可信度 | 桌面/移动、双主题、空态、长文本、图表像素和金额覆盖率验收通过 |
| PR-5 | 端到端安全验收、迁移脚本、文档收口与生产灰度 | 一个测试租户完整走通，删除测试数据；不改 MAP full-http 主链 |

一次只做一个 PR。每个 PR 合并前先合入最新 main，等待 CI、Codex Review 和 CDS 完成；不得把五个 PR 合成不可审查的大提交。Bugbot 因订阅停用统一记为不适用。

## 8. 调研要求

- 只使用 OpenRouter 官方文档和实际网页作为对标依据，重点调研 Quickstart、API Keys、Activity、Models、Provider Routing、Organizations/Teams、Usage/Costs。
- 对标的是信息层级、首次接入路径、错误解释和治理能力，不做像素级抄袭，不复制品牌、文案和受版权保护的视觉资产。
- 先用浏览器记录当前 GW 在桌面和移动端的真实问题，再改布局；不得仅凭源码想象页面。
- 模型池核心调度本轮不改，除非发现阻断租户隔离的安全问题。

### 8.1 OpenRouter 登录态页面借鉴结论

2026-07-12 已在用户授权的登录态浏览器中只读核对 OpenRouter 的 Workspace、Logs、Activity 和 Models 页面。后续实现只借鉴信息结构与交互原则：

- 顶部只承载品牌、全局搜索、产品级入口、组织/个人上下文和用户菜单；Workspace 与 Account 的管理入口进入左侧分组。
- Workspace 范围集中放 API Keys、Routing、Guardrails、Observability 和 Settings；Account 范围集中放 Activity、Logs、Credits、Management Keys、Privacy 和 Preferences。
- Logs 先给日期、复合筛选、请求趋势和请求表，再把 model、provider、appCaller、输入、输出、cost、usage type、speed、finish reason、client user id、API key 作为可配置列；GW 不复制字段命名，但保留同等可定位性。
- Activity 分 Overview、Trends、Explore、Guardrails；首页指标优先为 spend、requests、token volume、cache hit rate，并提供 Top API Keys、Top Apps、Usage by model、Usage type、Request volume、Token breakdown 和 Prompt caching 的下钻。
- 无数据必须明确显示“无数据/未知”，缓存命中率等不可计算指标显示占位状态；不得用 0 伪装未知值。金额仍遵守本计划的 actual/estimated/unknown、币种和价格覆盖率规则。
- Models 的模态、上下文、价格、支持参数、provider、作者、数据保留和区域筛选可作为 PR-4 信息密度参考；本轮不复制其视觉资产，也不重做现有 GW 模型池和 provider router。

## 9. 验收

- 新用户不读内部架构文档，五分钟内能从 Quickstart 发出第一条请求。
- tenant A 无法读取 tenant B 的用户、团队、key、appCaller、日志、预算和审计。
- service key 只能调用授权 appCaller、协议和 scope。
- appCaller 提示词策略可预览、版本化、回滚、审计，且不会污染不支持的请求类型。
- 首页第一屏不出现需要滚动后才理解的核心统计，也不把 runtime gate 当普通用户主任务。
- 左侧导航承载工作区和治理页面，顶部只保留全局操作。
- 金额 unknown 不显示为 0；所有估算都显示币种、覆盖率和估算标识。
- 图表在 1440x900、1024x768、390x844 和深浅主题下无空白、溢出或错误比例。
- 不做重复付费模型测试：协议接入每格最多一次，UI/权限优先使用假上游和固定数据。

### 9.1 最终交付增量证据（2026-07-17）

PR #1168 在不重做 full-http、模型迁移、模型池算法或发布 Gate 的前提下，关闭了最后一组用户体验和独立部署缺口：Provider、模型关联 Provider、appCaller 显式模型池和 Exchange 路由均可在当前列表打开只读抽屉；抽屉不返回密钥明文、不发写请求，支持 Escape、Tab 焦点约束、关闭后焦点恢复和 390px 内部滚动。Quickstart、费用、Activity、租户、策略与模型池既有主链未被复制。

证据按提交边界分别记录，禁止把不同 SHA 的结果混写。功能提交 `6a0d128fe04a49f967d526de64030b7cbc49a8ba` 共 16 项检查通过或按条件跳过，其中 Build & Test、Server、CDS、Docker、三个 Gateway 镜像、CI Status 和 CDS Deploy 均为成功，CDS 部署 `dr_5716a46ddd7b0afb5a25ca03` 运行该精确提交。PR #1168 合并前末端提交 `c1b99dbbf87d58d2e79d4e0804d9652a0b7d230b` 的 Build & Test、Server、CDS Build & Test、Docker 和三个 Gateway 镜像通过；squash 合并提交 `ab560ba28cc0b6a973b2c276c14d8cbfd8d5d4b3` 由主分支部署 `dr_28c1eb47d2faa9ee5f74ac1b` 验证为 5/5 服务运行且自动 smoke 3/3。Bugbot 因用户停止续费记为不适用。

`llmgw-web` 不再依赖旧 `branch-main` 预构建镜像，Console API、Serving 和 Web 可以随 prd-agent 作为独立服务更新。为防存量 profile 从预构建切回源码时仍跳过 worktree 挂载，Compose 与解析器同时保留显式 `prebuilt=false`，定向解析测试 51/51 通过。合并后复核还发现非默认项目只给 profile id 加项目后缀、没有同步改写应用间 `dependsOn`，部署拓扑会把未知依赖误判为已满足并让 Web 抢跑。PR #1169 在 Quickstart 写入、本地主节点部署、远程 executor 派发和 executor 执行四处闭环项目内应用依赖；远程 payload 即使乱序也按拓扑层启动，只有同项目目标真实存在时才改写，MongoDB、Redis 等基础设施依赖保持原名。CDS TypeScript 构建、作用域纯函数 4/4、定向链路 7/7 和 CDS 全量 2852/2852 测试通过，另有 1 个既有 Docker 条件测试跳过；因此升级前的存量 profile 不需要删除重建。

公网独立网关子域的首页、Provider、模型、appCaller、Exchange、Quickstart、Activity、用量、治理和学习中心共 10 个页面以及 Console/Serving 双健康端点均返回 200；GW Native、OpenAI、Claude、Gemini 四入口没有 Gateway Key 时全部返回 401，没有调用付费上游。远端源码页面完成 113/113 浏览器截图和 Exchange 连续故事 3/3，自动发现、功能缺陷、console error 与 network error 均为 0。[最终 L2 验收报告](https://cds.miduo.org/reports?project=prd-agent&folder=2d16c45faee0490387098c6979935b3b&report=819a8f3bebad449d893d003884f4c6e3) 已读回 64,337 字节、12 个步骤、12 张内容寻址图片和 4 个验收深链。PR #1168 已 squash 合并为 `ab560ba28cc0b6a973b2c276c14d8cbfd8d5d4b3`；生产发布 `rel_aaae1903c97652b6` 首次更新 37 项，第二次 37 项全部 noop；只读复核 `rel_3c0ae6c6fc0ce838` 确认备份 SHA256 匹配、临时发布 Key 活跃数为 0 且最新 Key 已撤销。公共教程分享页和 API 返回 200，四类关联预览说明均可从对应章节读回；旧 49% 临时进度条目已原位更新为 100% 最终验收总览，公共正文哈希与本地目标一致。CDS 目标恢复原命令后已禁用。因此本段状态结算为“功能已合并、教程已生产发布、临时权限已安全收尾；启动顺序加固由 PR #1169 独立闭环”。

### 9.2 最终生产、独立容器与发布稳定性闭环（2026-07-17）

- 合并边界：PR #1169 合并提交 `8c781cd33b77ad301bfdbf1fa8cf5c1a0756d9fb` 闭环 CDS 跨项目依赖；PR #1170 合并提交 `b463269ca138fee92935c38fcea446453217add2` 使 CDS 自更新在共享工作树中通过隔离运行分支对齐 `main`；PR #1173 合并提交 `b905831619773d510738ec729cb1e5570ca4fe24` 把精确 `/gw/v1/shadow-comparisons` 收口为服务端派生的只读 scope，没有放宽其他路径。
- 代码质量：PR #1173 的 GitHub CI、Server、CDS、三个 Gateway 镜像及五镜像工作流全部成功；最终本地非集成回归为 `PrdAgent.Tests` 687/687 与 `PrdAgent.Api.Tests` 1712 通过、4 跳过、0 失败，合计 2399 通过。Bugbot 因停止续费继续记为不适用。
- 生产备份：外置目录 `/Users/inernoro/prd-agent-prod-backups/llmgw-prod-external-20260717T095754+0800` 保存六个受影响集合归档，`SHA256SUMS` 与逐包 gzip 完整性均通过。
- 生产发布：安全容器更新发布 `rel_92cc75f65a6d1ee7` 将 API、Console API、Web 与 Serving 对齐 `b9058316`；随后标准 full-http 验证发布 `rel_86cad16c6368c125` 成功。release gate、3 次健康采样、9 项受保护路由检查、route self-test、生产 health preflight 和 `http-full` rollout ledger 均通过，失败数为 0；视频、ASR 和供应商 canary 均保持禁用，没有新增付费调用。
- 公网验收：根页及 `/platforms`、`/models`、`/app-callers`、`/exchanges`、`/quickstart`、`/logs`、`/usage`、`/governance`、`/learn` 共 10 个页面全部 200；实际入口 JS 554,466 字节、CSS 44,300 字节且 MIME 正确；10 次 health 采样均精确返回 `b9058316`；GW Native、OpenAI、Claude、Gemini 四入口无 key 均为 401，未触发上游。
- 独立 CDS 容器：main 精确部署 `dr_b81c9be1b631b2cfd64457bd` 的 API、Admin、Console API、Serving、Web 五个服务全部运行；三个 LLM Gateway profile 均为 `express`，镜像精确对应 `b9058316`。共享预览 `/llmgw/` 返回 200，证明 Gateway 能随 prd-agent 更新并继续以独立容器存在，无需删除重建 profile。
- 教程与验收：公共《模型网关权威教程》为 33 章、253 步、132 张唯一图片、222 个步骤映射和 292 个正文图片引用，正文 SHA256 为 `83b2e0253c5538bd5079ed55f1368c7becb4c3a903829b5538445ce25b329973`；教程地址为 `https://map.ebcone.net/s/lib/PNyJj8JYqXJN?entry=3e4e51616ce64cb8f9e09c105dc7aaaa`，最终 L2 报告继续使用本节 9.1 的固定链接。
- 权限与恢复：`rel_14c4f9a0786d81ef` 证明临时用户与 membership 活跃数均为 0；两个 CDS 目标分别按配置哈希 `b1b7226583996002af33c9a226915440dac7e19f9c8c3ef4e9010d0c0e058775` 与 `e1c318dfd8c65a74531e28dd1d912138e88d0a6aac7a2bf34e47768a08a1705b` 原样恢复并禁用；临时 CDS 自更新分支已删除，没有修改任何既有用户密码。
- 事故闭环：两次早期发布尝试因重新创建 gateway 容器改变反向代理目标地址而短暂出现 502，均由自动回滚和显式恢复发布恢复。收尾分支将所有发布路径改为只强制更新 gateway 之外的服务；非 gateway 容器更新完成后先用当前配置原地 reload gateway 刷新 API/LLMGW 地址，再进入较长 readiness。gateway 仅在不存在时首次启动，已有容器随后同步其真实宿主挂载中的 standalone 配置，再 `nginx -t` 与第二次热重载。inproc 紧急回滚和保守 shadow 恢复也只重启 API、原地 reload gateway。契约测试锁定正常发布、静态复用、inproc 回滚和 shadow 恢复都不得对 gateway 执行 `--force-recreate`。
- 发布面闭环：`deploy/web/dist` 保持 gateway 的稳定 bind 根，静态产物不再清空在线目录，而是在根内 `.staging-*` 中完成权限归一化、index 与实际入口资源校验，再原子切换 `current`，由 `previous` 保存上一版；standalone Nginx root 指向 bind 根内的 `current`。任一强制探针失败会恢复 previous，并原地 `nginx -t`、reload 后复验公网，正常发布、复用发布和回滚都不改变 gateway 容器 IP。不可变产物必须具备可核验 SHA256，`./exec_dep.sh release` 恢复为 latest 兼容别名。发布后强制验证主 HTML、实际 JS/CSS、根级 health、API 版本、LLMGW 页面和双健康，并以操作者、主机、release PID、目标、hash、权限、链接、首个失败阶段与回滚结果生成不可覆盖 JSON；相同公网探针每 6 小时独立执行。因此 `doc/debt.platform.production-release.md` 的四项历史 open 已迁入已还归档。

## 10. 不做

- 不重新迁移 MAP 模型请求。
- 不重新设计 GW 模型池调度算法。
- 不删除 inproc/legacy 回滚代码；该任务由 full-cutover 最后阶段负责。
- 不伪造供应商账单、价格或汇率。
- 不把 MAP 用户表直接当 GW 多租户表复用。
- 不在没有租户隔离测试前开放公网自助注册。

## 11. Agent 交接提示词

```text
你接手的是 LLM Gateway 外部平台化与控制台体验任务。唯一 SSOT 是：
doc/plan.platform.llm-gateway-external-platform.md

先阅读：
1. doc/plan.platform.llm-gateway-protocol-router.md
2. doc/plan.llm-gateway.full-cutover.md
3. doc/debt.llm-gateway.md
4. llmgw/console-api/Program.cs
5. llmgw/web/src/App.tsx
6. llmgw/web/src/components/ConsoleLayout.tsx
7. llmgw/web/src/pages/OverviewPage.tsx

当前生产已经 full-http。不要重做模型迁移、模型池或发布 gate。现有 gwk_* scoped service key 是基座，不是完整租户体系。你的目标是按 PR-1 到 PR-5 有限推进：租户/团队/用户/RBAC、tenant-scoped key 与网页 Quickstart、appCaller PromptPolicy、控制台 IA/图表/金额可信度、最终安全验收。

开始前必须浏览 OpenRouter 官方 Quickstart、API Keys、Activity、Models、Provider Routing、Organizations/Teams、Usage/Costs，并用浏览器检查 https://map.ebcone.net/llmgw/ 当前桌面与移动页面。只借鉴信息架构和交互，不复制品牌资产。

硬约束：
- tenant 只能由会话或 key 服务端解析，不能信任请求自报 tenantId。
- 所有新集合先对照现有 Model 写法；所有查询和索引带 TenantId。
- 提示词策略首版只用于 chat/vision，日志只记 policy id/version/hash。
- unknown cost 不得显示为 0，CNY/USD 不得无汇率直接相加。
- 顶部只放全局上下文，左侧承担页面导航；普通首页不展示发布 gate 和容器拓扑。
- 不进行批量付费模型测试；每类真实协议最多一次，其余用假上游。
- 每个 PR 独立完成测试、CI、Codex Review、CDS 预览和交接，不允许一次实现五个 PR；Bugbot 因订阅停用记为不适用。

先输出仓库事实审计和 PR-1 的精确实施计划，确认没有重复建设，再开始编码。每次进度用表格汇报：事项、完成百分比、证据、阻塞、下一步。
```
