| fix | prd-api | 修复 LLM Gateway client-stream 健康探针标记在跨进程链路中丢失，避免发布 gate 把探针流量误判为用户流量 |
| feat | prd-api | LLM Gateway 请求上下文、日志与兼容入口补充 RunId 业务追踪字段 |
| polish | prd-llmgw-web | LLM Gateway 日志详情抽屉展示业务 RunId，便于从网关日志反查 MAP run |
| feat | prd-llmgw-web | LLM Gateway 日志列表、汇总、时间序列与会话视图支持按 RunId 精确过滤 |
| feat | prd-llmgw-web | LLM Gateway 日志列表、汇总、时间序列与会话视图支持按 RequestId 与 SessionId 精确过滤 |
| feat | prd-llmgw-web | LLM Gateway appCaller 注册表记录最近请求追踪字段，并可跳转日志页按 requestId、sessionId、runId 反查 |
| security | prd-api | LLM Gateway serving 运行时按 GW appCaller 注册表状态拒绝 disabled/archived 调用方 |
| security | prd-llmgw | LLM Gateway 控制台禁止将未绑定 GW 权威模型池或使用 auto 策略的 appCaller 激活 |
| fix | prd-llmgw | LLM Gateway 配置权威自动绑池工具同步将 active appCaller 路由策略规范化为 pool |
| security | prd-llmgw | LLM Gateway 控制台激活 appCaller 前校验绑定池存在可解析成员，自动绑池跳过不可用默认池 |
| security | prd-llmgw | LLM Gateway 控制台禁止将无可解析成员的 GW 模型池设为默认池 |
| security | prd-llmgw | LLM Gateway 控制台阻止默认 GW 模型池在成员删除、更新或批量导入后变为不可解析 |
| feat | prd-api | LLM Gateway serving 新增 GW Native `/gw/v1/invoke` 非流式入口并复用 `/gw/v1/send` 路由治理链路 |
| test | scripts | LLM Gateway D 层 smoke 改为真打 GW Native `/gw/v1/invoke` 主入口，并保留 `/gw/v1/send` 兼容抽样 |
| test | prd-api | LLM Gateway 入口协议契约补齐 Native/OpenAI/Claude/Gemini 的路由元数据一致性断言 |
| feat | prd-llmgw-web | LLM Gateway 日志 Activity 顶部展示入口协议、模型策略和来源系统分布，并支持点击快速筛选 |
| test | prd-api | 增加 LLM Gateway 控制台日志 summary 路由观测字段防退化守卫 |
| fix | prd-api | LLM Gateway 池成员缺少能力快照时从模型配置补齐协议和能力元数据，避免 strict-require 在旧池路径 unknown 放行 |
| feat | prd-api | LLM Gateway OpenAI 兼容非流式响应通过 Extensions 保留并回吐 choice logprobs |
| feat | prd-api | LLM Gateway serving 新增受密钥保护的 `/gw/v1/route-self-test` dry-run 入口，秒级验证四类协议入口路由元数据 |
| ops | scripts | LLM Gateway 生产 preflight 接入 `/gw/v1/route-self-test`，发布前自动校验四类协议入口 dry-run gate |
| ops | scripts | LLM Gateway rollout ledger 拒绝缺少 `gateway_route_self_test` 的 canary/http preflight 证据 |
| ops | scripts | LLM Gateway serving-probe 部署后强制记录并校验 `routeSelfTest`，防止发布后协议入口漂移 |
| ops | scripts | LLM Gateway rollout ledger 强制校验 gw-smoke 的 invoke/send/stream/client-stream 低成本真实 provider canary 行 |
| ops | scripts | LLM Gateway gw-smoke 默认真实 provider 调用收窄为 chat-only，intent/vision 改为显式环境变量打开以避免过量测试 |
| security | scripts | LLM Gateway serving-probe 取消读取短名 `GW_KEY`，仅通过长名环境变量或显式参数取网关密钥 |
| security | prd-api | LLM Gateway `/gw/v1/profile-test` 接入 appCaller 被动注册与状态、预算、限流治理，避免 runtime profile 测试绕过 GW 治理 |
| fix | prd-api | LLM Gateway `/gw/v1/profile-test` 复用同一个 requestId 写 appCaller 观测与 raw 请求日志，保证控制台可按 requestId 串联排查 |
| fix | prd-api | LLM Gateway runtime profile 测试 raw 日志补齐 sourceSystem、ingressProtocol、modelPolicy、transport 上下文，保证控制台筛选统计不漏该类请求 |
| fix | prd-api | Infra Agent runtime profile 测试调用 LLM Gateway 时携带统一 requestId 与路由上下文，使 inproc/http 两种模式日志字段一致 |
| ops | prd-llmgw | LLM Gateway 配置权威 summary 与发布 gate 增加 activeBoundPoolWithoutUsableMember 校验，防止 active appCaller 绑定不可用 GW 池时误判 ready |
| polish | prd-llmgw-web | LLM Gateway 概览页展示 active appCaller 未绑池与不可用池计数，便于定位配置权威退场阻塞原因 |
| polish | prd-llmgw-web | LLM Gateway 概览页配置权威阻塞计数支持跳转到 active appCaller 与模型池治理页面 |
| polish | prd-llmgw-web | LLM Gateway 日志与影子比对页面支持从 URL 读取 releaseCommit 等证据筛选条件，便于按当前发布 commit 复核 runtime gate |
| polish | prd-llmgw-web | LLM Gateway 发布 Gate 卡片增加日志、影子比对、appCaller、模型池和审计深链，阻塞项可直接跳转定位 |
| test | prd-api | LLM Gateway 静态守卫覆盖发布 Gate 深链筛选能力，防止 releaseCommit 日志、shadow 和审计证据入口回退 |
| ops | scripts | LLM Gateway 协议路由静态审计不再把静态证据 100% 表示为迁移完成度 100%，rollout ledger 拒绝误导性完成度证据 |
| feat | prd-llmgw | LLM Gateway runtime gate 响应新增结构化证据链接，控制台优先使用后端 links 定位日志、shadow、appCaller、模型池和审计页面 |
| feat | prd-llmgw | LLM Gateway 控制台新增协议入口覆盖矩阵，按 GW Native、OpenAI-compatible、Claude-compatible、Gemini-compatible 展示 appCaller 注册和运行日志证据 |
