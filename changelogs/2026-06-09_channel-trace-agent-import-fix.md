| fix | prd-api | 修复商品溯源「线上问题」导入大文件（如 93 条缺陷汇总）耗时很久且最终失败：原单次 LLM 解析全文 → 输出超 max_tokens 被截断 → JSON 解析失败。改为分段解析 + 逐条入库 + 增量进度 + 容错 JSON 提取，单段失败不影响整体 |
| feat | prd-api | 商品溯源代码扫描 GitHub PAT 解析增加通用环境变量兜底（GITHUB_TOKEN/GH_TOKEN/GITHUB_PAT/GITHUB_ACCESS_TOKEN/MIDOUTECH_GITHUB_TOKEN），不再仅限 ChannelTrace__GitHubToken |
