# LLM 网关物理独立设计 · 设计

> **版本**：v2.0 | **日期**：2026-07-17 | **状态**：已落地

> 范围：MAP 与独立 LLM Gateway 的控制面、数据面和迁移边界

## 1. 结论

LLM Gateway 已从 MAP 业务进程中剥离为独立 serving 数据面和独立 console 控制面。生产主路径由 MAP 的 `HttpLlmGatewayClient` 跨进程调用 `llmgw-serve`；模型解析、上游发送、协议转换、模型池健康、网关日志和配置权威均在网关侧完成。

MAP 保留业务上下文、业务 Run 和自身日志，不再拥有模型池与平台配置权威。旧 `inproc` 与 `shadow` 实现仅用于迁移证据和显式破玻璃回滚，不能成为生产漏配时的静默默认值。

## 2. 组件与职责

| 组件 | 职责 | 暴露范围 |
| --- | --- | --- |
| MAP `prd-api` | 业务鉴权、Run、业务上下文、调用网关 | 业务 API |
| `llmgw-serve` | resolve、send、stream、raw、协议适配、模型池、网关日志 | 部署内网 |
| `llmgw` console API | 账号、权限、配置、审计、日志与发布证据 | 经 `llmgw-web` 访问 |
| `llmgw-web` | 网关运维控制台 | 命名预览入口 |
| `llm_gateway` 数据库 | 网关配置、账号、审计、请求日志和 shadow 证据 | 网关服务专用 |

控制台后端和 serving 后端不应作为普通公网业务页面发布。浏览器只访问控制台 Web；MAP 与 Web 在部署内网调用对应后端。

## 3. 数据面契约

### 3.1 DTO 与序列化

跨进程契约以 `GatewayRequest`、`GatewayResponse`、`GatewayStreamChunk`、`GatewayModelResolution` 和 raw DTO 为事实源。新增字段必须满足：

- JSON 可序列化且前后端字段语义一致；
- 可选字段保持向后兼容；
- 二进制内容使用对象引用或 multipart 专用路径，不塞入普通 JSON；
- `ApiKey`、exchange 私密配置和内部凭据不得越过 MAP 到 serving 的 HTTP 边界；
- 取消、超时和错误使用稳定错误码，不依赖异常文本判断。

具名 DTO 优先于 `ValueTuple`、裸字节数组和匿名对象。序列化契约由 serving 合同测试与 MAP 客户端测试共同守卫。

### 3.2 compute-then-send

一次调用必须分为“算”和“发”：

1. serving 根据 tenant、appCaller、模型类型、期望模型和可选 pin 解析平台、协议和模型。
2. serving 在本进程内取得并解密平台凭据。
3. 发送阶段接收同一次解析结果，不允许兄弟调用重新 resolve 覆盖已选模型。
4. MAP 可调用轻量 resolve 获取无密钥的展示信息，但不能把该结果当作携带凭据的发送对象。

这一边界防止“用户选择 A，发送时又解析成 B”，也保证明文平台密钥不经过 MAP 与 serving 之间的 HTTP payload。

### 3.3 Serving 端点

内部原生契约位于 `/gw/v1/*`，覆盖：

- `healthz`、`readyz` 和路由自检；
- `resolve`、`invoke`、`send`、`stream` 与 `raw`；
- request cancel 与 status；
- profile test、pools、client stream 和 shadow comparisons。

兼容入口覆盖 OpenAI Responses、Chat、Images，Anthropic Messages 和 Gemini generate/stream。兼容入口仍必须经过同一租户、权限、预算、解析、日志和协议适配链，不能另建直连旁路。

### 3.4 凭据、租户与完整性

除 `healthz` 外，serving 端点必须通过 gateway key 或 scoped service key 鉴权。授权决策至少绑定 source、appCaller、协议、scope、tenant 和环境；拒绝请求也要写入可审计日志。

平台 API key 的密文、解密密钥和 legacy key ring 只注入 serving。`PlatformKeyIntegrityWorker` 与模型池探活在网关侧运行，保证配置权威、密钥可解密性和健康状态的写入职责不分裂。

外部租户可配置 URL 必须通过安全出站校验，拒绝内网、保留地址、危险重定向和 DNS 重绑定路径。

### 3.5 流式、取消与背压

流式调用由 serving 读取上游并按 SSE 透传，MAP 只做协议代理和业务事件映射。客户端断开、业务取消和服务超时必须传播到上游请求；长流不能依赖普通短请求超时。

首字节、结束原因、工具调用数、token、requestId 和 transport 应由权威执行进程记录。日志与影子写入失败不能改变已经产生的模型结果，但必须留下可观测告警。

### 3.6 响应与 Server Authority

同步请求直接返回结构化结果；长任务由 Run/Worker 持有服务端生命周期，浏览器 SSE 只订阅进度。浏览器断线不得取消已接受的权威任务，重新连接应能按 cursor 续读。

错误响应必须区分鉴权、预算、无可用模型、协议不支持、上游失败、超时、取消和网关不可用。MAP 不应把网关 5xx 改写成空成功结果，也不能在失败时静默直连模型。

## 4. 运行模式与迁移

| 模式 | 权威路径 | 用途 |
| --- | --- | --- |
| `http` | 独立 serving | 生产目标和当前主路径 |
| `shadow` | 非白名单走 inproc，后台比对 HTTP；白名单走 HTTP | 切流前积累证据 |
| `inproc` | MAP 进程内旧实现 | 本地开发或显式破玻璃回滚 |

生产必须显式配置模式。`HttpAppCallerAllowlist` 用于按 appCaller 灰度，不得长期形成双权威。shadow 默认只比较解析，完整内容采样必须受百分比和 allowlist 控制，避免无界双倍模型费用。

每条请求记录真实 transport。shadow 编排状态不能覆盖实际 `inproc` 或 `http` 传输事实。

## 5. 配置与数据权威

网关数据库 `llm_gateway` 是以下数据的权威来源：

- appCaller 注册与模型池绑定；
- 平台、模型、exchange 和协议配置；
- scoped service key、租户和权限；
- 网关请求日志、shadow comparison、操作与登录审计；
- 发布 gate 和配置迁移证据。

MAP 数据库继续保存 MAP 业务日志、会话、Run 和业务产物。两侧通过 requestId、sessionId、appCaller 和 traceId 关联，不把两种日志混成单一集合。

控制台账号长期权威在网关数据库。环境口令只允许首次 bootstrap 或明确破玻璃重置，不能在重启时覆盖已修改口令。

## 6. 部署拓扑

生产和 CDS 预览均使用多容器同构拓扑：MAP API、至少一个 serving、console API 和 console Web。MAP 通过内部 gateway 地址访问 serving；console Web 通过内部反代访问 console API。

关键部署约束：

- serving 与 MAP 使用兼容的契约版本；
- serving 实例共享同一网关数据库、平台解密配置和资产存储配置；
- 多 serving 通过内部负载均衡访问，不能把 MAP 固定到临时单实例；
- `healthz` 返回构建 commit，`readyz` 验证数据库、配置和必要依赖；
- serving 与 console API 默认不声明公开子域。

## 7. 故障、回滚与降级

| 故障 | 预期行为 |
| --- | --- |
| serving 不可达 | MAP 明确失败；不静默直连 |
| 无可用模型 | 返回可诊断错误并保留解析证据 |
| 日志或对象存储失败 | 主调用按策略继续或失败，但记录告警 |
| 单 serving 失效 | 内部负载均衡转到健康实例 |
| 配置或协议回归 | 阻断 release gate，回滚发布 |
| 必须恢复旧路径 | 显式执行破玻璃回滚到 `inproc`，并记录操作 |

回滚是受控运维动作，不是应用代码里的自动 fallback。恢复 HTTP 前必须重新跑当前 commit 的健康、协议、transport 和真实 appCaller 证据。

## 8. 发布门禁

进入或维持 full-http 至少需要：

- serving `healthz`、`readyz` 和构建 commit 一致；
- 原生与兼容协议合同测试通过；
- scoped key、租户隔离、预算和安全出站测试通过；
- 当前版本无非预期 direct/inproc transport；
- active appCaller 具备真实 send、stream 或 raw 证据；
- shadow critical 与 httpFail 为零，或满足维护发布的受控证据保留规则；
- 配置权威报告 ready，MAP fallback 对象已按门禁收口；
- 回滚脚本 dry-run 和 serving 真机 smoke 通过。

可执行命令、样本阈值和波次进度只维护在计划、测试矩阵与脚本中，不复制到本设计。

## 9. 当前状态与剩余边界

已落地：生产 full-http 主路径、独立 serving、独立控制台、网关数据域、协议兼容入口、日志 transport、shadow 证据、配置权威与发布 gate。

仍保留但不承载正常生产流量：MAP 内 `LlmGateway`、`ShadowLlmGateway` 和部分 legacy resolver。它们的删除窗口、跨项目隔离和剩余风险记录在计划与债务文档中。保留旧代码不代表允许新调用绕过网关。

## 10. 关联文档

- `doc/plan.llm-gateway.full-cutover.md`
- `doc/spec.llm-gateway-test-matrix.md`
- `doc/debt.llm-gateway-isolation.md`
- `doc/design.platform.llm-gateway.migration-retrospective.md`
