| fix | llmgw | 分离全局发布门与发布后业务冒烟的密钥，避免 legacy key 外用禁令阻断正式发布 |
| test | llmgw | 补充双密钥发布合同与就绪度守卫回归校验 |
| fix | llmgw | 修复 shadow 回滚脚本中误放进 Python heredoc 的网关原地重载函数 |
| fix | llmgw | 流式上游返回 finish_reason 后立即结束读取，并为正式冒烟补齐 scoped key 身份头 |
| fix | llmgw | 对齐正式主站外层代理与 Gateway 请求超时，避免兼容 send 入口被 60 秒提前截断 |
