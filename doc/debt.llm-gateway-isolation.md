# debt.llm-gateway-isolation

> 状态：进行中（波1 大部分落地，serving 跨进程 = 波2 未做）
> 负责人：AI / 待用户 1 次审批
> 关联设计：`doc/design.llm-gateway-physical-isolation.md`

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
- **债务**：`ModelTestStub.FailureMode`（AlwaysFail/Timeout/ConnectionReset 等）当前**未接入** serving 发送路径
  （resolver/gateway 不查 `model_test_stubs`）——失败注入要生效需在 `LlmGateway.SendAsync` resolve 后加 stub-hook，
  是独立改动，本轮未做；canary 改用真实失败路径（桩上游错误 / 坏 URL 模型）规避。

## 已知边界 / 后续（波3，未做）

- **http 模式默认 OFF**：本轮只交付「可切」，未在生产把 `LlmGateway__Mode` 翻成 http（需审批后真人逐字段
  影子比对通过才翻）。影子双发比对工具未做（计划：同请求 inproc+http 双发，diff 关键字段）。
- **prd-llmgw-web 未上 CDS 预览**：观测前端独立站走 exec_dep / 后续 CDS 集成（需处理 SPA base-path 路由）。
- **两个 LlmGateway 进程职责**：`prd-llmgw`（顶层，自包含观测控制台 + 登录，不引用 Infra）与
  `prd-api/src/PrdAgent.LlmGateway`（serving 引擎，引用 Infra 持有实现）。职责不同、刻意分离，不归并。
- 计费、数据库分离、调度算法重写：本轮明确不做（用户「计费暂缓」「数据库暂不分离避免表撕裂」）。
