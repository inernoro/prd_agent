# debt.open-platform.open-api

> 类型：debt（工程债务台账） | 模块：开放接口（OpenAI 兼容）对外网关 | 状态：active
> 最后更新：2026-06-03

## 背景

把开放平台做成贴近真实开放平台的对外 LLM 网关（借鉴 OpenRouter 的 OpenAI 兼容风格）。外部调用方用标准 OpenAI
请求方式接入（base_url 指到本服务），每个 `sk-ak-*` Key 绑定自己的固定模型 / 专属池，
未绑定回落默认池。Phase 1 落地核心网关 + 按 Key 绑定 + 默认回落 + 导航修复；
韧性（限流/降级可见/预警/监控 UX）分到 Phase 2。

## 关键设计不变量（勿回退）

- **伞形 appCallerCode 必须静态注册**：`open-api.proxy::chat` / `open-api.proxy::generation`
  写在 `AppCallerRegistry`。原因：`LlmGateway.TryValidateAppCaller` 用静态注册表反射校验，
  未注册即 `APP_CALLER_INVALID`（400）；`AppCallerRegistrySyncService` 据此建 `llm_app_callers`
  DB 记录，没记录则 `ModelResolver.ResolveAsync` 直接返回 `NotFound`，未绑定 Key 无法回落默认池。
  守卫测试：`tests/PrdAgent.Tests/OpenApiRegistrationTests.cs`。
- **不为每个 Key 派生动态 appCallerCode**（会被上述门禁拦下）。绑定一律走
  `ModelResolver` 的 `expectedModel` 通道：`FindPreferredModel` 支持按模型 id 或模型池 Code 匹配。
- **客户端 body 的 model 不参与调度**：网关移除后由 Gateway 注入解析模型，避免外部任意挑模型。
- **LLM 调用用 `CancellationToken.None`**：客户端断开不取消上游（server-authority）。

## Phase 2 已偿还（2026-06-04）

1. **按 Key 限流桶**：`OpenApiUsageService`（Redis）实现 `or:rate:{keyId}` 每分钟滑动窗口，
   按 `AgentApiKey.OpenApiRateLimitPerMin`（null=默认 120/min）限流；在 `OpenApiController`
   chat/image 入口 `CheckAndReserveAsync` 准入，超限返回 429 + Retry-After。不再依赖粗粒度 user 桶。
2. **每日配额拦截**：`or:reqs:{keyId}:{day}` / `or:tok:{keyId}:{day}` 计数，按
   `OpenApiDailyRequestQuota` / `OpenApiDailyTokenQuota`（null=不限）拦截，超额 429。
   请求配额走 **INCR-then-check + 超额回滚（DECR）** 原子占用，消除"读-判-写"竞态
   （Codex/Bugbot PR#732 复检项）。token 配额因 token 数请求前未知，保留只读预检（已知边界）。
3. **预警**：配额跨 80% / 100% 阈值、专属绑定 Key 降级（IsFallback）→ 写 `AdminNotification`
   （Source=open-api，按天 Redis SETNX 去重）。Redis 抖动一律 fail-open，不打断网关。
4. **监控**：管理 tab 展示每 Key 今日请求数 / token；可在线编辑限额。
   Redis 异常时用量读取 fail-open 返回 0。

## Phase 3 已偿还（2026-06-04）

1. **model 字段语义**：从"静默忽略"改为**按 Key 模型白名单**——client 可在白名单内自选，
   越界 400 `model_not_allowed`，不填用白名单第一个（默认），白名单空=默认池。
   白名单条目支持**模型 id 或模型池 code**两类（后端 `FindPreferredModel` 双档匹配，
   管理 UI 选择器同列两类，池 code 让客户走整池故障转移）。
2. **密钥自省** `GET /api/v1/key`：返回白名单/配额/今日用量/有效期，不打模型。
3. **可观测性对齐**：响应 `id = chatcmpl-<requestId>` 与日志同源可回溯；成功/429 回写
   `X-RateLimit-Limit/Remaining/Reset`。
4. **成本防爆**：单请求输入字符上限 `MaxInputChars=200000`，超限 400 `input_too_large`。
   字符统计含多模态 `image_url`（base64 数据 URI 或 url 字符串），大图不绕过上限（Codex PR#732 P2）。
5. **接入指南**：`doc/guide.open-platform.open-api.md`（quickstart + 契约 + 白名单语义）。

## 仍未做（按优先级排期，本轮我主动决定不做的）

- **并发上限**：限流只算每分钟次数，未限同时并发流。并发计数器需所有路径（含流式断开）
  可靠 decrement，泄漏风险高，单独排期。
- **成本/额度账本**：只有 token 计数，无 credits / `usage.cost` / 计费对账。商用前补。
- **单次生成回查 `/v1/generation?id=`**：日志已存大部分字段，缺独立查询端点。
- **embeddings 端点**：`/v1/embeddings` 返 404（无 embedding 模型池验证）。
- **鉴权/scope 错误体非 OpenAI 形状（Bugbot PR#732 Med）**：`[Authorize(ApiKey)]` 的 401 与
  `[RequireScope]` 的 403 走内部 `ApiResponse` 信封，其余错误走 OpenAI `{error:{message,type,code}}`。
  OpenAI SDK 客户端遇到鉴权/scope 失败会拿到非预期错误体。**完整修法**需改共享鉴权基础设施
  （自定义 ApiKey challenge + 给 open-api 路由套错误体重写中间件/过滤器，或不用共享 `[RequireScope]` 改 inline），
  `[RequireScope]` 被 marketplace 等其他控制器复用且依赖内部信封，单独排期。当前错误仍被正确拒绝，仅信封形状不同。
- **/v1/images/generations 仅支持 OpenAI 兼容图片池（Codex PR#732 P2）**：原始 body 经
  `SendRawWithResolutionAsync` 直发，只注入 model，不走 `IImageGenPlatformAdapter.BuildGenerationRequest`
  的 schema 转换（OpenAIImageClient 才走）。若 Key 绑定到原生供应商图片池（Google/Volces 等非 OpenAI schema），
  prompt/size 请求会以错误 schema 打原生端点而失败。**修法**：图片端点改走 image-gen 适配器/客户端路径，
  或显式限制只接受 OpenAI 兼容图片池。当前默认 image 池（gpt-image-2-all）OpenAI 兼容、工作正常；
  原生池为已知边界，属 image-gen 适配器架构改动，单独排期。
- **图片端点真实出图未端到端验**：只验路由/鉴权；图片无 token/成本计。
- **日志索引/TTL 待 DBA 建**：`open_api_request_logs` 含 IP/UA，按 no-auto-index 规则禁止应用自建索引。
  所需索引（`KeyId+CreatedAt` 抽屉查询、`CreatedAt` 全局序、`RequestId` 定位、可选 CreatedAt TTL）已写入
  `doc/guide.platform.mongodb-indexes.md`，由 DBA 手动建（Codex PR#732 P2）。
- **MaxInputChars 全局常量**：未做按 Key 可配。统计已含 messages 文本/多模态图片/prompt/tools+functions schema，
  但仍是字符近似（非精确 token），且未做"原始 body 字节硬上限"。
- **绑定失效检测靠控制器启发式**（PR#732 P2 已缓解）：绑定的模型/池被删改时，`ModelResolver` 静默走默认调度
  且不置 `IsFallback`。控制器侧按 `ExpectedModel` vs `ActualModel`（精确/前缀）+ `ModelGroupCode`（池 code）
  判定是否"未honored"，未honored 则补发降级预警。**权威修法**应由 `ModelResolver` 在 expectedModel 未命中分支
  显式置一个 `ExpectedModelHonored=false` 信号（属共享核心改动，单独排期）；当前控制器启发式对极端别名/大小写
  边界可能漏判，但不会误拒请求。
  **策略决定（用户 2026-06-04 PR#732）**：ModelResolver 的「版本容差」前缀匹配（如绑定 model-v3.2、池里 model-v3）
  视为「已遵守」**不报警**，贴合 ModelResolver 设计意图、避免版本容差绑定刷屏；仅彻底回落默认池才报警。
  Bugbot 建议「任何非精确匹配都报警」未采纳（会对版本容差客户产生噪音）。
- **chat 工具调用 tool_calls / 多选(n) / finish_reason=length 丢失（Codex PR#732 P2，流式+非流式）**：
  非流式把上游压成单条 `finish_reason=stop` + `message.content=Content`；流式只发 role/content delta，
  不发 `delta.tool_calls`。两者同一根因：`ILlmGateway` 只暴露归一化的 `Content`/reasoning/finish 文本，
  不暴露结构化 `choices/tool_calls/finish_reason`；`RawResponseBody` 是**上游原始格式**（Claude 适配器返回
  Claude 格式，非 OpenAI），**直接透传不安全**。正解需 Gateway 层补「provider-agnostic 结构化 choices +
  流式 ToolCall chunk」再由本控制器重建 OpenAI body——属 Gateway 架构改动，单独排期。
  当前对纯文本 chat（流式/非流式）正确，工具/多选/截断场景为已知边界。
- **流式 pre-stream 错误已修**（PR#732 P2）：解析/上游在吐第一个 token 前失败时，原先写 SSE error chunk 但
  HTTP 仍 200（客户端误判成功）。现改为 `Response.HasStarted==false` 时返回 502 + JSON 错误体；
  已开始的流仍只能发流内 error 事件 + `[DONE]`（HTTP 头已 200 发出，无法回改状态码）。

## 已知边界（Phase 2 留尾）

1. **监控仅当日 + 列表级**：用量看当天 Redis 计数 + 最近日志，未做跨天趋势图/聚合报表。
2. **预警仅站内**：走 AdminNotification，未接外部 Webhook（如需推到客户侧再扩 WebhookNotificationService）。
3. **配额按 UTC 日切**：`yyyyMMdd` UTC，未按客户时区。
4. **伞形 chat 需求被 sync 自动绑定到默认 chat 池**：`AppCallerRegistrySyncService` 会把所有
   chat 类 AppCaller 的空 `ModelGroupIds` 自动回填默认 chat 池。结果：未绑定 Key 的 chat 命中
   该默认池（`DedicatedPool` 解析类型而非 `DefaultPool`），但模型即默认 chat 模型，行为正确。
   generation 不被自动绑定 → 走 `DefaultPool`（default:image）。两者对未绑定 Key 都等价于「默认」。
   **CDS 实测项**：确认未绑定 Key 的 chat/image 解析到的就是默认池模型。
5. **/v1/models 仅返回该 Key 解析出的 chat + image 模型**（最诚实的「这个 Key 能用什么」），
   未列出池内全部成员。需要更全清单时 Phase 2 扩展。
6. **未做 embeddings 端点**（首版范围外）。
7. **非流式 chat 走 Gateway normalized Content**（非上游原始 body 透传）。OpenAI 兼容字段齐全，
   但如客户端依赖上游专有字段（如 logprobs）则不可见。Phase 2 评估原始透传模式。

## 验证状态

- 本地无 .NET SDK，C# 改动走 CDS 远端编译验证（cds-first-verification）。
- CI 守卫：`OpenApiRegistrationTests` + `AppCallerCodeRegistryGuardTests`（kebab-case）。
- 前端：`navCoverage.test.ts` 确认 `/open-platform` 已进 NAV_REGISTRY。
- 端到端：CDS 部署后用 `sk-ak-*` Key 打 `/api/v1/chat/completions`（流式+非流式）、
  `/api/v1/images/generations`、`/api/v1/models` 验收；绑定 Key→固定模型、未绑定→默认池。
