| feat | prd-llmgw | 网关控制台配置可写第一刀：ConfigWrite 策略 + 平台/模型启用停用、模型池默认互斥切换端点（写共享 Mongo，MAP 立即生效，不碰密钥不删数据） |
| feat | prd-llmgw | 网关控制台新增「概览」首页：容器拓扑（7 容器职责，治「多只脚」）+ 配置计数 + 影子一致率 + 快速入口；日志页移到 /logs |
| feat | prd-llmgw-web | 网关控制台前端接入配置写：平台页启用/停用按钮、模型池「设为默认」按钮、概览页 |
| feat | cds | Mongo Console 数据操作：自由命令行保持只读（find/findOne/countDocuments/distinct，多重防注入），写操作改走新增的「结构化写入」面板——固定 action(insertOne/updateMany/deleteMany) + JSON 参数，服务端不 eval 用户文本，需 data-write 权限 + 资源名确认，从根上杜绝 mongosh eval 注入 |
