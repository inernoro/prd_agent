| feat | llmgw | 增加 environment、clientCode 与 ServiceKeyId 工作负载归因，Activity 支持按调用身份筛选 |
| security | llmgw | 建立可连续执行的密钥轮换阶段与并发状态约束及拒绝请求归因，历史通配来源 key 可在轮换时一次性升级工作负载身份，失败日志按服务端 requestId 和生命周期标记避免重复且不保存密钥明文或哈希 |
| polish | llmgw | 移动端接入密钥改为工作负载身份卡片，轮换阶段和操作无需横向滚动即可完成，连续轮换仍可在页面结束旧钥 |
| test | llmgw | 增加撤销密钥、拒绝日志和轮换错误顺序的对抗测试 |
