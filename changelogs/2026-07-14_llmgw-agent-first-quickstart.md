| feat | llmgw | 新增同页创建 appCaller、团队密钥、四协议 dry-run、requestId 回查和 Agent Skill 的一页式 Quickstart |
| security | llmgw | 四协议 dry-run 复用服务端租户与 scoped key 身份，在上游调用前结束并写入 tenant/team/key/client/environment 审计日志 |
| test | prd-api | 新增四协议真实入口零上游合同与 Agent-first Quickstart 数据边界守卫 |
| fix | llmgw | 在请求日志列表与详情中展示服务端验证的团队归因 |
