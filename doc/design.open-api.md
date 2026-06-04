# 开放接口（OpenAI 兼容对外网关）技术设计

> **版本**：v1.0 | **日期**：2026-06-04 | **状态**：已落地

## 1. 管理摘要（30 秒）

开放接口让**外部客户**用标准 OpenAI 兼容方式（借鉴 OpenRouter 风格）调用本平台模型：对方把 SDK 的 `base_url` 指到本服务、填入签发的 `sk-ak-*` 密钥即可。核心价值是**按客户隔离模型**——每个密钥配一个模型白名单，客户只能在白名单内选，平台改总模型池不会误伤已配置客户。配套限流、配额、降级预警、用量统计与密钥自省，保证对外开放不被流量打挂、可计量、可排障。

本设计不重造模型调度：复用现有三级模型池（ModelResolver），密钥的模型选择通过 `expectedModel` 通道钉到具体模型。路由保持顶层 `/api/v1/chat/completions` 等 OpenAI 形态，便于零改造接入。

## 2. 问题背景

平台已有内部多 Agent 共用的模型池，但缺一条**对外**的标准调用通道。直接把内部接口暴露给客户有三个硬伤：

| 痛点 | 后果 |
|------|------|
| 客户和内部应用共用模型调度 | 平台调整总池→静默影响客户，难追责 |
| 没有标准请求/返回形态 | 客户接入成本高，无法用现成 OpenAI SDK |
| 没有对外的限流/配额/计量 | 外部流量可打挂内部；用量不可计、不可billing |

借鉴 OpenRouter 的「OpenAI 兼容 + 按 key 管控」哲学，做一条独立、可隔离、可观测的对外网关。

## 3. 设计目标与非目标

**目标**
- 标准 OpenAI 兼容（chat / images / models），现成 SDK 改 base_url 即用
- 按密钥隔离：模型白名单 + 独立限流/配额，平台改总池不误伤客户
- 可观测、可排障：每请求日志 + 用量统计 + 密钥自省 + 可回溯 id
- 韧性优先：限流基础设施抖动时 fail-open，不打断主链路

**非目标（本期不做，见 debt.open-api）**
- 计费/额度账本（credits/cost）、单次生成回查、embeddings、并发上限、日志 TTL

## 4. 核心决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 模型选择 | **按密钥模型白名单**，客户在白名单内自选；越界 400；空白名单→默认池 | 既给客户 OpenRouter 式自选，又把范围锁死在平台允许集合内 |
| 调度复用 | 复用 ModelResolver 三级池，密钥绑定走 `expectedModel` 钉模型 | 不重造调度，白名单只是"指针视图"，复用健康/故障转移 |
| 路由形态 | 顶层 `/api/v1/*`，OpenAI 兼容 | 零改造接入；这是"借鉴 OpenRouter"的落点 |
| 鉴权 | 复用 `sk-ak-*` AgentApiKey + scope `open-api:call` | 复用既有长效 M2M 密钥体系，不新造 |
| 韧性策略 | Redis 限流/配额，异常一律 fail-open | 可用性优先，限流故障不能拖垮对外服务 |
| 韧性边界 | LLM 调用 `CancellationToken.None` | 客户端断开不取消上游（server-authority） |

---
> 以下为开发者细节（允许精简代码）。

## 5. 整体架构

```
外部客户 SDK (base_url=/api/v1, Bearer sk-ak-*)
   │
   ▼  ApiKeyAuthenticationHandler  → 注入 boundUserId / scopes / agentApiKeyId
[RequireScope(open-api:call)]
   │
   ▼  OpenApiController
   ├─ 1. 读 body，模型白名单选择 ResolveModelChoice(whitelist, body.model)
   │      命中→用；不填→白名单[0]；越界→400 model_not_allowed；空白名单→null(默认池)
   ├─ 2. 输入大小上限 CountInputChars > 20万 → 400 input_too_large
   ├─ 3. 准入 IOpenApiUsageService.CheckAndReserveAsync（限流桶 + 每日配额）
   │      允许→回写 X-RateLimit-*；拒绝→429 + Retry-After
   ├─ 4. BeginScope(UserId=owner) → ILlmGateway.StreamAsync / SendAsync (CT.None)
   │      ExpectedModel=chosen → ModelResolver 三级解析 → 上游
   ├─ 5. GatewayStreamChunk → OpenAI SSE（id=chatcmpl-<requestId>，可回溯）
   └─ 6. LogAsync(OpenApiRequestLog) + RecordTokensAsync（配额阈值/降级发预警）
```

模型解析（复用，非新造）：伞形 `open-api.proxy::chat`/`::generation` 走 ModelResolver；
`expectedModel`=白名单选中模型，命中后该模型被置顶解析；为空走默认池。

## 6. 数据设计

**AgentApiKey 扩展字段**（`OpenApiChatModels` / `OpenApiImageModels` 白名单 + 配额/限流）：

| 字段 | 类型 | 说明 |
|------|------|------|
| OpenApiChatModels | `List<string>` | chat 白名单（model id / 池 Code），第一个=默认，空=默认池 |
| OpenApiImageModels | `List<string>` | image 白名单 |
| OpenApiDailyTokenQuota / RequestQuota | `long?` | 每日配额，null=不限 |
| OpenApiRateLimitPerMin | `int?` | 每分钟速率，null=默认 120 |

`AgentApiKey` 标注 `[BsonIgnoreExtraElements]`，容忍历史字段（改名/改 schema 不炸鉴权反序列化）。

**OpenApiRequestLog 集合**（`open_api_request_logs`）：keyId、ownerUserId、requestId、endpoint、requestedModel、resolvedModel、resolvedPool、resolutionType、isFallback、prompt/completionTokens、statusCode、errorCode、durationMs、clientIp、userAgent、createdAt。

**Redis 计量键**（fail-open）：`or:rate:{keyId}`（每分钟滑动窗口 ZSET）、`or:reqs:{keyId}:{day}`、`or:tok:{keyId}:{day}`、`or:alert:{type}:{keyId}:{day}`（预警按天去重）。

## 7. 接口设计

| 端点 | 说明 |
|------|------|
| `POST /api/v1/chat/completions` | OpenAI 兼容，`stream:true` SSE |
| `POST /api/v1/images/generations` | OpenAI 兼容 |
| `GET /api/v1/models` | 该 Key 可用模型（有白名单返白名单，无则默认池） |
| `GET /api/v1/key` | 密钥自省：白名单/配额/今日用量/有效期，不打模型 |
| `GET/PUT /api/open-api/bindings[/{keyId}]` | 管理端：列出/设置每 Key 白名单 + 限额 |
| `GET /api/open-api/logs` | 管理端：调用日志（排障） |

错误码（OpenAI 式 `{error:{message,type,code}}`）：`model_not_allowed`、`input_too_large`、`rate_limit_exceeded`、`daily_request_quota_exceeded`、`daily_token_quota_exceeded`。
响应头：成功/429 均带 `X-RateLimit-Limit/Remaining/Reset`；429 带 `Retry-After`。

## 8. 问题汇总（开发/验收中真实踩过）

| 问题 | 根因 | 状态 |
|------|------|------|
| 动态 per-key appCallerCode 被拒 | LlmGateway 静态注册表门禁 + ModelResolver 无记录直接 NotFound | 改伞形 code + expectedModel 通道 |
| 改名后旧字段 Key 鉴权 500 | BSON 默认严格，旧字段 FormatException | 加 `[BsonIgnoreExtraElements]` |
| 绑定列表 500 | 误用 `User.Id`（实际 `UserId`） | 改 UserId 关联 |
| 新建文件编译失败 CS1022 | 文件末尾误入工具标记 | 已清理 |
| 表格新列被裁 | `overflow-hidden` | 改横向滚动 + 收窄控件 |

**遗留概念边界（非 bug，需知晓）**：白名单是"客户能用的模型清单"，模型池是底层资源；白名单经 `expectedModel` 钉模型，**仍过 ModelResolver**（绑单模型时调度等于空转，绑多模型/池时仍会故障转移）。未配白名单的 Key 骑共享默认池——平台改默认池会影响这类 Key，只有配了白名单的才真隔离。

## 9. 边界场景 / 可能情况

| 场景 | 行为 |
|------|------|
| client 不填 model，Key 有白名单 | 用白名单第一个（默认） |
| client 填白名单内 model | 用之 |
| client 填白名单外 model | 400 model_not_allowed + 返回允许清单 |
| Key 无白名单 | 回落默认池，client model 被忽略 |
| 上游不返回 usage | token 计 0（低估，已知边界） |
| 流式中途客户端断开 | 上游续跑（CT.None）；SSE 写失败则停止后续 yield，可能漏记尾部 usage |
| Redis 不可用 | 限流/配额 fail-open 放行（可用性优先，故障期无防护） |
| 专属白名单首选模型不可用 | ModelResolver 健康降级，`isFallback=true`→站内预警 |
| 配额跨 80%/100% | 站内 AdminNotification 预警（按天去重） |
| 旧 scope（open-router:call）Key | 不匹配 `open-api:call`→403 |
| 输入超 20 万字符 | 400 input_too_large（先于占额，不耗配额） |

## 10. 压力测试方案

**目标**：验证对外网关在高并发/突发流量下不打挂内部、限流配额准确、fail-open 行为符合预期。

| 维度 | 用例 | 通过标准 |
|------|------|----------|
| 限流准确性 | 单 Key 设 N/min，按 2N/min 打 | 恰好 N 个 200，其余 429 + Retry-After，误差 ≤1 |
| 配额准确性 | 设每日 M 请求，打 M+10 | 第 M+1 起 429 daily_request_quota_exceeded |
| 并发隔离 | 多 Key 并发，各自限流 | Key A 触限不影响 Key B（独立桶） |
| 突发吞吐 | 100 并发流式 30s | 内部 API 不 5xx、不 OOM；p95 延迟可观测 |
| fail-open | 压测中断 Redis | 请求继续放行（不 500），Redis 恢复后限流恢复 |
| 大输入防护 | 批量 20 万+字符请求 | 全部 400 input_too_large，不进上游、不耗配额 |
| 上游故障注入 | 绑定模型置 Unavailable | 降级到默认 + isFallback 日志 + 预警 |

**工具**：`k6` / `wrk` / `hey` 对预览域名打 `/api/v1/chat/completions`（短 prompt，非流式为主）。
**观测指标**：429 比例、p50/p95/p99 延迟、上游错误率、Redis 命中、容器 CPU/内存、`open_api_request_logs` 落库完整性。
**注意**：压测会真实消耗上游 token/成本——用 stub 模型池或限定小额度 Key，避免烧钱。

## 11. 可观测性与调试（重点）

**"某个时刻能对某个客户排障"的三条路径**：

1. **请求级日志**：每次调用落 `open_api_request_logs`（requested vs resolved 模型、池、isFallback、tokens、status、errorCode、latency、IP/UA）。管理端 `GET /api/open-api/logs?keyId=` 按 Key 拉最近调用。
2. **响应 id 回溯**：客户拿到的 `id=chatcmpl-<requestId>`，`requestId` 即日志主键 → 客户报"这条请求出错"，凭 id 直接定位该条日志 + 关联 LLM 日志（`llmrequestlogs`）。
3. **密钥自省**：客户/客服 `GET /api/v1/key` 一条 curl 看白名单/配额/今日用量/有效期，无需打模型，最快判断"是不是配额满了/key 过期了"。

**实时计量**：成功响应带 `X-RateLimit-Remaining`，客户自己能看余量。管理端「开放接口」tab 显示每 Key 今日请求/token。降级与配额阈值发站内 AdminNotification。

**后续增强（debt）**：管理端调用日志查看器（消费 `/logs` 出 UI 表 + 详情抽屉）、单次生成回查端点、跨天趋势图。

## 12. 影响范围

- 新增：`OpenApiController` / `AdminOpenApiController` / `OpenApiRequestLog` / `IOpenApiUsageService`+实现；前端「开放接口」tab。
- 修改：`AgentApiKey`（白名单+配额字段）、`AppCallerRegistry`（伞形 code）、`MongoDbContext`（新集合）、`AgentApiKeysController`（scope 白名单）、`Program`（DI）、`PublicModelsController`（让出 `/api/v1/models`）。
- 不动：内部 Agent 调用链、ModelResolver 核心逻辑。

## 13. 风险

| 风险 | 缓解 |
|------|------|
| 未配白名单 Key 受总池变更影响 | 文档明示；建议运营给商用 Key 必配白名单 |
| 上游无 usage→token 计 0 | 已知；后续接 tokenizer 估算 |
| Redis 故障期无限流 | fail-open 选择；可加二级内存限流兜底（debt） |
| 压测烧上游成本 | 用 stub 池/小额度 Key |

## 14. 关联文档

- `doc/guide.open-api.md`：客户接入指南（quickstart + 契约）
- `doc/debt.open-api.md`：债务台账（并发/账本/embeddings/日志TTL 等留尾）
- `doc/design.model-pool.md`：三级模型池调度
- `.claude/rules/llm-gateway.md`、`server-authority.md`、`compute-then-send.md`
</content>
