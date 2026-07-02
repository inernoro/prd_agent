| feat | prd-llmgw | 网关控制台配置可写第一刀：ConfigWrite 策略 + 平台/模型启用停用、模型池默认互斥切换端点（写共享 Mongo，MAP 立即生效，不碰密钥不删数据） |
| feat | prd-llmgw | 网关控制台新增「概览」首页：容器拓扑（7 容器职责，治「多只脚」）+ 配置计数 + 影子一致率 + 快速入口；日志页移到 /logs |
| feat | prd-llmgw-web | 网关控制台前端接入配置写：平台页启用/停用按钮、模型池「设为默认」按钮、概览页 |
| feat | cds | Mongo Console 从只读 find 升级为受控写：放行 insertOne/updateOne/updateMany/deleteOne/deleteMany/replaceOne 等定点写（需 data-write 权限），删库/删集合/索引/eval/runCommand/跨库/aggregate 写出等高危操作一律拦截 |
