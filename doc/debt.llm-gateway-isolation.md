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

## 已知边界 / 后续（波3，未做）

- **http 模式默认 OFF**：本轮只交付「可切」，未在生产把 `LlmGateway__Mode` 翻成 http（需审批后真人逐字段
  影子比对通过才翻）。影子双发比对工具未做（计划：同请求 inproc+http 双发，diff 关键字段）。
- **prd-llmgw-web 未上 CDS 预览**：观测前端独立站走 exec_dep / 后续 CDS 集成（需处理 SPA base-path 路由）。
- **两个 LlmGateway 进程职责**：`prd-llmgw`（顶层，自包含观测控制台 + 登录，不引用 Infra）与
  `prd-api/src/PrdAgent.LlmGateway`（serving 引擎，引用 Infra 持有实现）。职责不同、刻意分离，不归并。
- 计费、数据库分离、调度算法重写：本轮明确不做（用户「计费暂缓」「数据库暂不分离避免表撕裂」）。
