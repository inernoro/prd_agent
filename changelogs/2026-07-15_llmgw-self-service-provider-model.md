| feat | llmgw | 新增租户内 Provider 与模型自助创建流程，密钥加密落库并按模型用途幂等追加默认池 |
| security | llmgw | Provider 和模型查询、唯一索引、审计与写入均包含 TenantId，拒绝跨租户 Provider 绑定 |
| polish | llmgw | 重构 Provider 与模型空态引导，隐藏高级批量维护并明确未知费用与币种边界 |
| test | llmgw | 新增配置校验、协议继承、服务端租户来源、费用未知与能力映射测试 |
