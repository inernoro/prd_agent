| feat | prd-api | 商品溯源智能体：业务知识/线上问题支持导入文件入库（知识 1 文件 1 条、案例 AI 解析为多条结构化案例 SSE 流式） |
| feat | prd-api | 商品溯源智能体代码对比改造：内置 fc_codeapi/fc_YmSystem 两仓库，新增 ChannelTraceCodeScanService 子 agent（描述抽关键词→克隆扫描→命中代码→AI 异同分析），GitHub PAT 走配置 ChannelTrace__GitHubToken |
| feat | prd-admin | 商品溯源智能体：知识/案例 Tab 增加导入文件入口；代码对比 Tab 改为描述驱动，展示内置仓库/关键词/命中代码 + token 未配置告警 |
