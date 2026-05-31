| feat | prd-api | CDS Agent 工作台优雅降级：新增 Lite 只读审查 runtime 适配器（GatewayReviewRuntimeAdapter），R1 未闭合/官方 sidecar 不可用时不再硬卡报错，改走现有 LLM Gateway 产出只读代码审查 |
| feat | prd-admin | CDS Agent 简单视图新增「Lite 预览 / 官方 SDK」模式徽章与说明横幅；Lite 可用时不再阻塞发起任务 |
| fix | prd-api | InfraAgentSessionService 会话创建/发消息在 lite 兜底可用时不再因 profile 不兼容硬拒绝；运行时按 official/lite/unavailable 三态选择适配器 |
| feat | prd-api | 工作流 CdsAgentRun 事件渲染新增运行状态（Status）渲染，输出明确显示 Lite 预览/官方 SDK 模式，让降级在工作流里也可见 |
| fix | prd-admin | 修复 CDS Agent 工作台请求风暴：SSE pump 改为唯一事件读取器并在收到 done/error/终态 status 时立即停止（杜绝跑完后空转循环请求）；元数据轮询节流（消息/日志 6s、会话列表 12s，不再每 3s 拉 100 个会话） |
| perf | prd-admin | CDS Agent 时间线按 source/level 过滤底层传输 info 级 log（runtime-router/adapter），减少无用渲染，保留 warning/error |
| fix | prd-api | CDS Agent 授权一次即可：GetLongTokenAsync 改 revokeOnFailure:false（解密抖动不再自动吊销授权）；连接被误吊销但凭据仍可解密时自动恢复为 active（TryReactivateIfTokenValidAsync 自愈），不再反复要求重新授权 |
| fix | prd-admin | CDS Agent 后台状态/事件展开：强化噪声过滤（空消息 + 生命周期日志），并让错误/状态/日志等所有事件都能展开看人话细节（错误码/traceId/下一步、运行模式/原因），不再只有工具调用可展开、不再一堆「后台运行日志」无信息 |
