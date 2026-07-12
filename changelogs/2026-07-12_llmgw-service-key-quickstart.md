| feat | prd-api | 为租户 service key 增加来源 CIDR 和分布式每分钟限流执行门 |
| feat | prd-llmgw | 增加创建者、自有范围、团队、轮换和高级 service key 管理 |
| feat | prd-llmgw-web | 新增组织自助接入与四协议网页 Quickstart |
| test | prd-api | 增加 service key CIDR 和租户分钟窗口集成测试 |
| security | prd-api | CIDR 门禁只消费 nginx 追加的最右侧来源地址，拒绝调用方伪造转发链 |
| fix | prd-llmgw-web | Quickstart 无法确认 serving 地址时使用明确占位，避免误把管理后台作为网关地址 |
