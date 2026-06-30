# debt.llm-gateway-isolation

> 状态：进行中（波1 + 波2 跨进程 + 波2.5 影子/灰度/命名子域 已落地；生产翻 http = T12 待拍板）
> 负责人：AI / 待用户拍板（合并到 main + 翻 http 时机）
> 关联设计：`doc/design.llm-gateway-physical-isolation.md`；上线计划/测试纲领：`doc/plan.llm-gateway.rollout.md`；
> 验收面包屑：`doc/guide.llm-gateway.acceptance-breadcrumbs.md`

AI 大模型网关从 MAP 剥离的工程债务台账。记录「已做 / 待用户 / 已知边界 / 后续」。

## 已落地（已部署 + 已验证）

- **观测性补强**（commit e98a9c7e / 55665736 → 5973abee 部署）：
  - 请求生命周期可视（StartedAt/FirstByteAt/EndedAt 派生「未发出/接收中/已发等响应/完成/失败」）。
  - 黑洞可见：StartAsync 失败补落 `Status=blackhole`，让「完全没发出去」也入库可见。
  - 内容一键还原：`GET /api/logs/llm/{id}/restore-text` 还原 `[TEXT_COS:sha:chars]` 占位符。
  - 按应用聚合 MECE：`GET /api/logs/llm/app-summary` 按 appPrefix × requestType 出成功率/中位时延矩阵。
    实测能发现真实异常（visual-agent/generation 44%、document-store/asr 0%、video-agent/asr 38%）。
- **前端观测接线**（7fddd26a + c4746e20，已部署）：日志页「应用」tab + 正文一键还原 + 生图缩略图渲染。
- **生图统一入口**（039e3397）：`ImageGenRequestBuilder` 收口「模型配置→请求体」转换，加新生图模型不再连锁全系统。
- **独立网关进程 prd-llmgw**（444e987a，镜像已构建绿）：自包含 ASP.NET 服务，**不引用任何 prd-api 项目**，
  共享同一 Mongo 直接读 `llmrequestlogs` 做观测，独立 JWT 账号体系（独立 `LlmGwJwt` 密钥 + 种子账号）。
  端点 `/gw/healthz` + `/gw/auth/login` + `/gw/logs(/meta|/timeseries|/sessions|/:id)`，与独立前端
  `prd-llmgw-web` 的 `/gw` 契约对齐。CI `llmgw-image` / `llmgw-web-image` 独立构建，编译失败不波及 api 主镜像。
- **部署管线**：docker-compose（exec_dep 路径）+ cds-compose（预览路径，dev 源码 + express 预构建两模式）+
  `_standalone.conf` `/gw` 反代 + branch-image.yml CI 任务，全部就位。

## 波2 serving 跨进程：已实现 + 编译验证（runtime 待审批）

- **serving 网关 SERVER（2a，已落地）**：`prd-api/src/PrdAgent.LlmGateway` 已从 scaffold 升级为可运行
  ASP.NET 服务（`Program.cs`），DI 进程内承载现有 `LlmGateway`+`ModelResolver`（复刻 MAP 13 项注册），
  HTTP 暴露 `/gw/v1/{healthz,resolve,send,stream(SSE),raw,pools,client-stream}`，`X-Gateway-Key` 共享密钥门。
  **已移除 Api→LlmGateway ProjectReference**，serving 编译错误不再阻塞 api 主镜像（CI 已证 api-image 与
  llmgw-serve-image 互不影响）。镜像 `prdagent-llmgw-serve` CI 构建绿。Dockerfile.llmgw-serve（8091）。
- **MAP 客户端 + flag（2b，已落地）**：`HttpLlmGatewayClient : ILlmGateway(Infra)+ILlmGateway(Core)` 代理 6 方法
  到 `/gw/v1/*`；`HttpLlmClient : ILLMClient` 代理 CreateClient 流式到 `/gw/v1/client-stream`。
  `Api/Program.cs` 加 `LlmGateway__Mode=inproc|http`（默认 inproc），http 时 DI 换 HttpLlmGatewayClient，
  **48 个注入点零改动、方法签名不变**（"方法请求→接口请求"）。api-image CI 已证编译绿。
- **守住 compute-then-send**：跨进程 resolve 只在网关侧；`SendRawWithResolutionAsync` 的 resolution 不过线，
  serving 端 `/gw/v1/raw` 重解析补 ApiKey；`ResolveModelAsync` 经 HTTP 返回的 resolution ApiKey 恒 null（[JsonIgnore]）。
- **部署接入**：docker-compose 加 `llmgw-serve`；cds-compose 加 `llmgw-serve`（path-prefix `/gw/v1/`，dev+express）；
  `_standalone.conf` 加 `/gw/v1/` → llmgw-serve:8091。

## 波2 自测：CI 真跑通过（执行级证据，非仅编译）

- 新增 `prd-api/tests/PrdAgent.Api.Tests/Gateway/CrossProcessServingSelfTest.cs`：起真实 Kestrel host 住
  serving 端点（`MapGatewayServingEndpoints`，与生产 Program.cs 同一份），stub 上游网关，真实
  `HttpLlmGatewayClient` 经真实 HTTP/SSE 打过去，端到端断言 resolve/send/stream/raw/pools/client-stream
  往返 + **ApiKey 恒 null（[JsonIgnore] 不过线）** + 密钥门 401。
- serving 端点抽成 `GatewayHttpEndpoints.MapGatewayServingEndpoints`（命名空间 `PrdAgent.LlmGatewayHost`，
  避开与 `LlmGateway` 类型非限定引用的 CS0118）。
- **CI 真跑结果**：`ci.yml` 的 `dotnet test` 执行该用例并 PASS（548ms；1048 passed / 0 failed，commit 530952bb）。
  过程中自测还抓出一处断言笔误（fake 发两个 delta，期望写成 3 段）——证明它真在执行而非空跑。
- 不覆盖真实模型解析/上游发送（既有实现，inproc 已验、本轮未改）；真机端到端待 CDS 升级 + 导入审批。

## 已知坑：分支级额外服务被 webhook 自动部署清空（2026-06-29）

每次 `git push` 触发 CDS webhook **自动部署**（check-run「CDS Deploy」），它按**项目拓扑**重部署分支，会把
**分支级额外服务**（`extraProfiles`，如本波挂的 `llmgw-serve`）**清空**（`extraProfiles: []` / 容器「未找到服务」）。
表现：push 后 `/gw/v1/*` 全部落到 admin SPA（路由不再命中 llmgw-serve）。
- **现状自愈办法**：等该 push 的「CDS Deploy」跑完（branch=running）后，重新 `PUT /extra-services?redeploy=1`
  + `PUT /profile-overrides/api-prd-agent {env:{LlmGateway__Mode:shadow}}`，无新 push 就不再被清。
- **根因/启示**：分支级额外服务对「webhook 自动部署」不持久 → **任何要长期常驻的网关服务（生产/每分支）应走项目级
  compose 导入**（项目底座 profile，过审批，push 不清），而非分支级额外服务。分支级只适合「一次性真机验证」。
- 待办：要么让 webhook 自动部署用 `getEffectiveProfilesForBranch`（含 extraProfiles）重部署、不清额外服务（CDS 侧修，
  走 `/audit` 反馈给 CDS 团队）；要么本网关转项目级导入常驻。

## D 层真机：已跑通（2026-06-29，跨进程 serving 在真实预览上 8/8 绿）

CDS 合并多容器能力（PR #951）后，serving 网关在 `claude/llm-scheduling-model-pool-x58zh4` 预览上端到端跑通：

- **CDS 自更新到 main**：原 CDS 钉在已删分支 `claude/push-service-cds-issue-u2jbtz`（degraded:git_fetch_failed），
  `self update --branch main`（dry-run 先过）→ 取消 degraded + 拿到多容器代码。
- **单分支多容器部署**：用**分支级额外服务**（`PUT /api/branches/:id/extra-services?redeploy=1`，无需项目级审批）
  把 `llmgw-serve` 作为第 3 个容器挂到本分支（与 api/admin 同分支），`pathPrefixes:["/gw/v1"]` 最长前缀路由。
  镜像 `prdagent-llmgw-serve:sha-<merge>`（prebuiltImage:true）。**这正是此前被 CDS 卡住的「单分支多容器」能力**。
- **env 接线（不材料化任何密钥）**：`MongoDB__ConnectionString` 设为模板 `mongodb://${CDS_HOST}:${CDS_MONGODB_PORT}`，
  CDS 部署期 `resolveEnvTemplates` 用注入的 cdsVars 展开；`Jwt__Secret`/`ApiKeyCrypto__Secret` 由项目 env 自动注入
  （`container.ts` mergedEnv），故 resolve 解密平台 key 正常。
- **D 层 8/8 绿**（`scripts/gw-smoke.py` 真打实时预览）：healthz / pools[chat,intent,vision] / send[chat]→
  qwen/qwen3.6-plus、send[intent]→deepseek/deepseek-v4-flash(64 字)、send[vision]→qwen/qwen3.6-plus、canary
  必败被抓。预览：`https://llm-scheduling-model-pool-x58zh4-claude-prd-agent.miduo.org/gw/v1/healthz`。
- **harness 修复**：预览走 Cloudflare，默认 `Python-urllib` UA 被 CF 按浏览器签名拦（error 1010 / 403）→
  `gw-smoke.py` 补浏览器 UA 头。
- **已知小边界**：healthz 回显 commit=`fa467956d`（镜像 GIT_COMMIT build-arg 取到较旧分支提交，非 serving 代码本身
  问题，端点行为为 merge 树最新）；后续可在 Dockerfile.llmgw-serve 把 GIT_COMMIT 钉到 github.sha 修正标签。

## 待用户（1 次手动，外部门禁）

- **CDS 拓扑导入审批**：cds-compose 新增 `llmgw` + `llmgw-serve` 属「拓扑变更」，CDS 要求 dashboard 人工批准，
  AI key 无法自批。当前 pending-import `a204d9ea7c2b`（addedProfiles=[api,admin,llmgw,llmgw-serve]，
  supersede 旧的 2db2aa51c74e）。
  - 批准入口：CDS Dashboard → `project-list?pendingImport=a204d9ea7c2b` → 批准。
  - 批准后预览域名可 curl 验收：
    - 观测控制台：`/gw/healthz` → ok；`/gw/auth/login`（admin / llmgw-admin-2026）+ `/gw/logs`。
    - serving 网关：`/gw/v1/healthz` → ok；带 `X-Gateway-Key: dev-llmgw-serve-key` 调 `/gw/v1/resolve`、`/gw/v1/pools`。
    - http 全链路：把 api 的 `LlmGateway__Mode` 置 `http` 后跑一次 chat/生图，逐字段比对 inproc vs http
      （model/protocol/finish/内容/生图 URL）。
  - 在此之前：全部代码已编译绿、4 个镜像已推；仅「预览域名运行时」这一步卡在审批。exec_dep 路径不受门禁影响。

## 真实环境 MECE 冒烟矩阵：表 + B/C 层 CI 真跑通过

- `doc/spec.llm-gateway-test-matrix.md`：14 维 MECE 矩阵（入口×流式×档位×协议×think位置×工具×token/cache×图片×
  上下文×环境×中断×负载×演示×一平台多协议）+ 4 层分工（A 解析/B 协议保真/C 跨进程/D 真机）+ 每层 canary。
- **B 层** `GatewayProtocolFidelityTests`（14 用例，CI 真跑绿）：喂 canned payload 给真实
  `OpenAIGatewayAdapter`/`ClaudeGatewayAdapter`/`ThinkTagStripper`，断言 think 三形态
  (reasoning_content/reasoning/`<think>`)归一 Thinking、tool_calls 归一、token+cache 采集、finish_reason、
  跨 chunk 半截 `<think>` 缝合 + canary 探测元断言。
- **C 层** `CrossProcessServingErrorLoadTests`（4 用例，CI 真跑绿）：上游 Fail→Success=false、抛异常→500 不崩、
  并发 16 不串扰、错 key 401。
- **A 层** 复用 `AppCallerRegistryGoldenSnapshotTests` + `LlmResolutionGoldenIntegrationTests`（153 入口 golden）。
- **D 层** `scripts/gw-smoke.py`：真机冒烟（读 `/gw/v1/pools` 选便宜 OpenRouter 模型按矩阵抽样 + 必败 canary），
  待 CDS 单分支多容器 + 导入审批后跑。
- CI 结果：1066 passed / 0 failed（commit df301d73），过程中 CS8419(async 迭代器无 yield) 已修。

### v2 扩展：从压缩版改数据驱动全枚举 + 可见大报告（commit b30218ab，CI 绿）

- 用户反馈「这么少的表，能有效吗，是内容压缩了吗」——v1 确实压缩了（14 维摘要 + 18 手写 [Fact]）。v2 改为：
  - `scripts/gen-gw-matrix-report.py`（纯 Python，无需 SDK，一处定义三处消费）→ `doc/report.gw-test-matrix.md`
    （约 282 行可见大表）+ `protocol-cells.json`(91 B cell) + `transport-cells.json`(18 C cell)。报告里 B/C 每一行
    = CI 真执行的一个 cell（非只列不跑）。
  - **B 层** `GatewayProtocolFidelityTests` 改 `[Theory]+MemberData` 读 `protocol-cells.json`（91 cell：think 三形态/
    tool 归一/token+cache/finish 全枚举/字符集 9 变体/edge→null；payload 全按适配器源码行为构造）。
  - **C 层** `CrossProcessServingErrorLoadTests` 改 `[Theory]` 读 `transport-cells.json`（18 cell：方法×上游
    {echo/failing/throwing/empty}×鉴权×并发，4 stub host 经 IClassFixture 复用）。
  - **A 层** 新增 `GwResolutionMatrixTests`（153 反射 `[Theory]`：命名规范 + ModelType 13 类白名单 + 无重复 + canary）。
- **CI 真跑结果**：commit b30218ab → `ci.yml` Server Build & Test 绿，**1313 passed / 4 skipped(Integration) / 0 failed**
  （含新增约 262 个 cell）+ golden 程序集 424 passed。run 28368514692。
- **债务**：`ModelTestStub.FailureMode`（AlwaysFail/Timeout/ConnectionReset 等）当前**未接入** serving 发送路径
  （resolver/gateway 不查 `model_test_stubs`）——失败注入要生效需在 `LlmGateway.SendAsync` resolve 后加 stub-hook，
  是独立改动，本轮未做；canary 改用真实失败路径（桩上游错误 / 坏 URL 模型）规避。

## 波2.5：影子比对 + 灰度 allowlist + CDS 命名子域（已落地，2026-06-30）

- **shadow 影子比对**（`ShadowLlmGateway`）：`LlmGateway:Mode=shadow` 时，inproc 权威返回给 caller，
  后台对 http 侧 `ResolveModelAsync`（走 `/gw/v1/resolve`，纯 DB、零 LLM 成本）逐字段比对，落
  `llmshadow_comparisons`（Inproc/Http 各 {ActualModel,Protocol,PlatformType,ResolutionType,ModelGroupId,IsFallback}
  + Mismatches[severity] + AllMatch + HasCritical）。**默认只比解析**（覆盖「选A给B」最高风险，免费）；
  `LlmGateway:ShadowFullSamplePercent>0` 才对非流式采样真发 http 比 content/finish/token。http 影子失败一律吞掉，
  caller 永远拿 inproc。`CreateClient` 绑定 shadow → chat 主链路覆盖。单测 `ShadowLlmGatewayTests` 9 例 CI 真跑绿
  （1326 passed/0 fail）。
- **灰度翻 http allowlist**：`LlmGateway:HttpAppCallerAllowlist`（逗号/分号分隔）命中的 appCallerCode 走 http**权威**
  （不比对），其余按 Mode。纯配置可回滚。
- **shadow 读端点**：`GET /gw/v1/shadow-comparisons?limit&appCallerCode`（X-Gateway-Key 门内），返回
  `summary{total,allMatch,critical,httpFail}` + `recent[]`，去黑盒看一致性。
- **首条真机证据**：`defect-agent.polish::chat` → `qwen/qwen3.6-plus` via DedicatedPool，inproc=http 逐字段一致、
  `Mismatches:[]`、`AllMatch:true`、`HasCritical:false`、`HttpOk:true`。样本=1，待随流量积累。
- **CDS 命名子域 URL**（commit a993a073f）：单分支多容器里，声明 `BuildProfile.subdomain` 的服务获得
  `<previewSlug>-<sub>.miduo.org` 独立命名 URL（forwarder 直达容器根路径，无 pathPrefix），让 serving 网关有区别于
  主应用域名的独立入口，不再埋在主应用 `/gw/v1` 路径下。三处接入：compose `cds.subdomain` label + PUT
  `/extra-services` 的 subdomain 字段 + forwarder-route-publisher；proxy master 兜底识别后缀不 auto-build。
  单标签以匹配 `*.miduo.org` 通配证书。3 测试绿 + cds tsc 干净。**未点亮**（生产 CDS 未 self-update 到本分支）。

## 回滚预案

| 场景 | 回滚动作 | 代价 |
|---|---|---|
| http/shadow 行为异常 | 设 `LlmGateway:Mode=inproc`（删 env） | 纯配置，秒级，无需改代码/重建镜像 |
| 灰度某入口 http 退化 | 从 `HttpAppCallerAllowlist` 删该 appCallerCode | 纯配置 |
| full-sample 比对成本过高 | `ShadowFullSamplePercent=0`（回 resolve-only 免费） | 纯配置 |
| serving 容器挂 | MAP 自动？否——http 模式 caller 会拿到 http 失败。生产翻 http 前必须 serving HA + 健康探活兜底 | 见下「翻 http 前置」 |
| CDS self-update 到本分支后出问题 | `self update --branch main` 翻回（但本分支缺 main 的「修复自更新历史」，可能不干净，故推荐走 PR 合 main 而非 self-update 到 feature 分支） | 系统级风险，见 rollout §6 |

## 翻 http 前置条件（生产 T12 前必须满足）

- serving 容器**高可用**（生产至少 1 容器健康 + 探活；MAP http 客户端遇 serving 不可达要有降级或快速失败可观测）。
- shadow 一致性证据积累足够（多入口、多平台/中转覆盖、0 critical mismatch 持续）。
- L1 `GatewayTransport` 标记落地（否则 flip 后日志辨不出某条走 inproc 还是 http，排障困难）。

## 安全边界（已守）

- serving `/gw/v1/*`（除 healthz）走 `X-Gateway-Key` 共享密钥门（内部 M2M，不走 JWT）。
- `ApiKey` 在 `GatewayModelResolution` 上是 `[JsonIgnore]` → 过 HTTP 线恒为 null；serving 端 `/gw/v1/raw` 按同模型
  重解析补回 ApiKey 再发（compute-then-send，杜绝跨进程「选A给B」+ 密钥不外泄）。`CrossProcessServingSelfTest`
  断言 ApiKey 恒 null。
- 独立观测前端 `prd-llmgw` 用**独立 `LlmGwJwt__Secret`**（与 MAP 主 JWT 解耦），独立账号体系。

## 跨项目隔离影响（对照 `.claude/rules/cross-project-isolation.md`）

- **共享 Mongo**：serving 与 MAP 共享同一库，`llmrequestlogs` / `llmshadow_comparisons` 会**混入其他部署/分支**的记录
  （分支预览共享基础设施是有意设计）。排障/统计时先按**时间窗 + appCallerCode/branch 特征**区分来源，勿误判。
- **`Jwt__Secret` 双身份**：MAP 的 `Jwt__Secret` 同时用于 JWT 签名 + 平台 API key 的 AES 静态加密。serving 共享同一
  Mongo 解密平台 key 时依赖该值由 CDS `container.ts` 注入；**轮换该密钥前必须先解密重加密所有 `ApiKeyEncrypted`**，
  否则模型池静默 401（见隔离规则事故台账）。
- **CDS self-update staleness**：见 rollout §6——self-update 生产 CDS 到落后 main 的 feature 分支会系统级影响所有项目 +
  临时回退 main 的 CDS 修复，推荐走 PR 合 main。

## 翻 http 后的监控建议

- 日志页按 `GatewayTransport`（L1 落地后）过滤，盯 http 路径的成功率/firstByte P95/token 是否与 inproc 持平。
- shadow 留 7-14 天兜底，`/gw/v1/shadow-comparisons` 的 `critical` 应恒 0；非 0 立即查该 appCallerCode 并回退该入口。
- serving 容器健康探活 + 资源（连接池/内存）告警。

## 已知边界 / 后续（波3，未做）

- **CDS 预览：网关 console + serving 仅内网、不公开 path-route**（Codex P1 ×2，PR #965 已修）：
  `cds-compose.yml` 原把 console（`/gw/`，固定 admin 密码 `llmgw-admin-2026` + 固定 JWT 密钥）与 serving
  （`/gw/v1/`，固定 key `dev-llmgw-serve-key`）公开 path-route 到每个 `*.miduo.org` 预览 → 任何人可用已知密码登录
  读 LLM 日志、用已知 key 调 `/gw/v1/send` 烧 provider 额度。**已改**：两服务删 `cds.path-prefix`，加
  `cds.no-http-readiness: "true"`，仅在项目内网起容器（api 经 docker 名 `http://llmgw[-serve]:809x` 内部可达；
  预览默认 `Mode=inproc` 本就不调 serving）。**后续（波3 专项）**：公开网关命名 URL（含命名子域 `<slug>-llmgw`）
  需配 **per-deploy 生成密钥 + 访问控制**再开放，不能用仓库已知占位值。本决策同时 moot 了命名子域 master 路由
  两处局限（无公开路由即不触发）与 extra-services subdomain 撞名（无公开 subdomain 路由即 inert）。
- **Claude OpenAI 兼容工具链不完整（多处）**（Codex P2 ×3，PR #965）：网关把 OpenAI 风格 `tools` 路由到 Claude
  模型时，`ClaudeGatewayAdapter` 的 OpenAI↔Claude 工具协议翻译尚不完整，**当前限制：Claude 后端的工具调用仅
  「单轮非流式、tool_choice=auto」可用**，以下场景待波3 专项补：
  1. **流式 tool_use 未聚合**（`ParseStreamChunk`）：`stream=true` 时未处理 Claude `content_block_start` /
     `input_json_delta` 事件 → 流式函数调用拿不到 `delta.tool_calls`（非流式正常）。
  2. **`tool_choice: "none"` 未兑现**（`ConvertToClaudeFormat` 附近 L240）：caller 显式禁用工具时仍把转换后的
     `tools` 附给 Claude → Claude 可能仍 `tool_use`。应在该请求 drop `tools` 或翻成 Claude 安全等价。
  3. **tool-result 多轮消息未翻译**（L180 附近）：工具循环的后续请求把 OpenAI `assistant.tool_calls` /
     `role:"tool"` 原样转发给 Claude，而 Claude 要 `tool_use`/`tool_result` content block → 可能 400。
  三者同根（Claude 工具协议翻译半成品），合并为一个波3 专项一次做透，无本地 SDK 难盲改、不在本轮反应式补。
- **影子 resolve 比对用有效期望模型**（Codex P2，PR #965 已修）：`ShadowLlmGateway` 的 send/stream resolve-only
  比对原传 `request.ExpectedModel`，但 inproc 解析用 `GetEffectiveExpectedModel()`（含 `RequestBody["model"]`
  回退）。model 只放 body 时影子 resolve 收 null → 误报 critical mismatch（假阳性）。已改为传
  `GetEffectiveExpectedModel()`。
- **命名子域：master 反代兜底路径有两处局限（forwarder/生产完整可用）**（Bugbot Medium ×2，PR #965）：
  命名子域 `<previewSlug>-<sub>` 在**生产数据面（forwarder 模式，`CDS_USE_FORWARDER=1`）下完整可用**——forwarder
  按 host 直接发布 `<sub>` 服务的独立路由，直达容器端口、按服务状态门控、**独立于主分支状态**（主分支还在
  building 时该服务照样应答）。下面两处只发生在**非 forwarder 的 master 反代兜底**（dev/legacy 部署）路径，
  本 PR 不改路由模型，记为已知局限，波3 随命名子域专项一起补：
  1. **`/_cds/*` widget header scope 缺失**（`cds/src/services/proxy.ts` L443-486）：master 用
     `extractPreviewBranch`+`resolveBranchEntry` 解析命名 host（`main-prd-agent-llmgw`），该 label 非分支 slug →
     `sourceEntry` undefined → `x-cds-source-project-id`/`x-cds-source-branch-id` 内部 header 不注入。影响仅限
     CDS Bridge widget 在非 forwarder 预览上的 source scope（dev 便利功能），不影响服务本体路由。
  2. **`routeToBranch` 分支级门控挡命名服务**（`cds/src/services/proxy.ts` L647-734）：命名子域已置
     `forcedProfileId`，但 master 路径仍按**分支级**状态（idle/stopped/building）返回等待页，导致一个已 running
     的 `llmgw-serve` 在主分支部署中时，经 master 兜底访问会拿到 HTML 等待页而非服务。正解是命名子域命中时按
     **服务级**状态路由（绕分支门控）——属路由模型变更，波3 做。**当前规避**：生产用 forwarder 模式（不受影响）；
     非 forwarder 部署等主分支就绪后命名服务即正常。
- **Claude 流式 tool_use 未聚合**（Codex P2，PR #965）：网关把 OpenAI 风格 `tools` + `stream=true` 路由到
  Claude 模型时，`ClaudeGatewayAdapter.ParseStreamChunk` 暂未处理 Claude 的 `content_block_start` /
  `input_json_delta` 事件 → 流式函数调用拿不到 `delta.tool_calls`（非流式 `tool_use` 解析正常）。修复需在
  流式路径做 tool-use 增量聚合/翻译，工作量较大且无本地 SDK 难盲改，列入波3；当前限制：**Claude 后端的
  流式工具调用不支持**，非流式可用。
- **跨进程真 socket 测试改标 Integration**（PR #965）：`CrossProcessServingErrorLoadTests` /
  `CrossProcessServingSelfTest`（真 Kestrel + 真 socket）在 `pull_request` runner 上对成功响应体读取环境敏感
  （同一份代码 `workflow_dispatch` 全绿 + 生产 gw-smoke 8/8 + 影子均正常），按本仓既有约定标
  `[Trait("Category","Integration")]`，CI 默认跳过、可手动/dispatch 跑。HTTP 边界安全契约（ApiKey 不过线）由
  纯单元 `GatewaySerializationSecurityTests` 在 CI 常驻覆盖。波3 可改用 `WebApplicationFactory`/`TestServer`
  内存传输重写以回 CI 常驻（去掉真 socket 的环境敏感性）。
- **生产 serving/console 密钥强制显式**（Codex P1，PR #965）：`docker-compose.yml` 的 `LLMGW_SERVE_KEY` /
  `LLMGW_ADMIN_PASSWORD` / `LLMGW_JWT_SECRET` 均改为 `${VAR:?...}` 必填（删除已知默认值），避免默认部署把
  `/gw/*` 用众所周知的 key 暴露。`LLMGW_JWT_SECRET` 尤其关键——console 的 `/gw/*` 是 bearer 鉴权，只校验
  签名/issuer/有效期，回落到仓库 dev 密钥则任何人可自签 token 读 `/gw/logs`（无需 admin 密码）。除 compose
  必填外，`prd-llmgw/Program.cs` 启动时再做一层防御：`IsProduction()` 下若 JWT 密钥/admin 密码缺失或等于
  仓库 dev 占位值，直接抛异常拒绝启动。CDS 预览走 cds-compose + 显式 env 不受影响；`exec_dep`/生产 `.env`
  必须设这三个变量。
- **http 模式 multipart raw 跨进程未接通（波3，已 fail-fast 防误发）**（Codex P1，PR #965）：`MultipartFiles`
  的元素是 ValueTuple `(string,byte[],string)`，System.Text.Json 默认不序列化 ValueTuple 字段 → 过 HTTP 线后
  文件内容丢失。设计的可序列化形态是 `MultipartFileRefs`（具名 DTO + 对象存储引用），但「prd-api 上传字节拿
  RefKey → serving 端按 RefKey 拉取 rehydrate 拼 multipart」这条管线属波3、尚未落地。当前 `HttpLlmGatewayClient.
  SendRawWithResolutionAsync` 对「带内联文件的 multipart raw」**快速失败**（返回 `MULTIPART_HTTP_UNSUPPORTED`），
  把静默发坏请求变成明确错误。影响面：http 模式下 ASR/转写/图生图等 multipart raw 入口需暂留 inproc。inproc
  模式不受影响（字节经 MultipartFiles 直传，不过线）。波3 接通对象存储 rehydrate 后解除。
- **blackhole 语义校正（修复「记录降级误标成功调用」）**（Codex/Bugbot，PR #965）：`LlmRequestLogWriter.StartAsync`
  在请求**发起前**被调用，其失败的是「日志写入」而非「请求发送」——请求随后仍照常发起。故 blackhole 的准确含义是
  「完整生命周期未能可靠记录」，既非成功也非「未发出」。修复：① StartAsync 失败路径**返回 null**（不再返回占位
  行 id），使后续 MarkDone/MarkError no-op，blackhole 记录作为独立不可变标记留存，不被覆盖也不反向误标；
  ② 移除 `LlmRequestLogBackground` 里 `Status != "blackhole"` 的兜底过滤（logId 不再复用，按主键直接更新）；
  ③ 前端标签「未发出」→「记录降级」（prd-admin + prd-llmgw-web），如实反映「请求可能已成功，只是这条日志没落库」。
- **http 模式默认 OFF**：本轮只交付「可切」，未在生产把 `LlmGateway__Mode` 翻成 http（需审批后真人逐字段
  影子比对通过才翻）。影子双发比对工具未做（计划：同请求 inproc+http 双发，diff 关键字段）。
- **prd-llmgw-web 未上 CDS 预览**：观测前端独立站走 exec_dep / 后续 CDS 集成（需处理 SPA base-path 路由）。
- **两个 LlmGateway 进程职责**：`prd-llmgw`（顶层，自包含观测控制台 + 登录，不引用 Infra）与
  `prd-api/src/PrdAgent.LlmGateway`（serving 引擎，引用 Infra 持有实现）。职责不同、刻意分离，不归并。
- 计费、数据库分离、调度算法重写：本轮明确不做（用户「计费暂缓」「数据库暂不分离避免表撕裂」）。
