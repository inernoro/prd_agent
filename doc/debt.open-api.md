# debt.open-api

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
3. **预警**：配额跨 80% / 100% 阈值、专属绑定 Key 降级（IsFallback）→ 写 `AdminNotification`
   （Source=open-api，按天 Redis SETNX 去重）。Redis 抖动一律 fail-open，不打断网关。
4. **监控**：管理 tab 展示每 Key 今日请求数 / token；可在线编辑限额。
   Redis 异常时用量读取 fail-open 返回 0。

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
</content>
