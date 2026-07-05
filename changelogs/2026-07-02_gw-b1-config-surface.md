| feat | prd-llmgw | 网关配置面第一刀（只读）：新增 GET /gw/pools（模型池+每模型健康）、/gw/platforms、/gw/models、/gw/shadow-comparisons，复用 logs 同款 JWT（LogsRead）+ BsonDocument 安全映射；平台/模型密钥字段一律不返回，只回 hasKey |
| feat | prd-llmgw-web | 控制台从「只有日志」升级为多页：ConsoleLayout 顶部导航（日志/模型池/平台/影子比对）+ 三个只读页（模型池健康、平台清单、影子比对汇总+对照），让网关看得见能配的第一步 |
