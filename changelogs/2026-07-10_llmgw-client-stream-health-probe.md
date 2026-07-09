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
