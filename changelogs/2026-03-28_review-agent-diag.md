| fix | prd-api | ParseReviewOutput 新增多策略解析：JSON 解析失败时自动用正则兜底提取 key/score 对 |
| fix | prd-api | ParseReviewOutput 现记录详细 parseError 诊断信息，存入 ReviewResult.ParseError |
| fix | prd-api | 处理 LLM 返回空内容的情况，以诊断信息标记而非静默产生 0 分 |
| feat | prd-admin | 评审结果页：当所有维度 0 分时显示诊断面板，含解析错误原因和原始 AI 输出 |
| fix | prd-api | 修复 ReviewAgent AppCallerCode 注册失败：将 ReviewAgent 类移入 AppCallerRegistry 内部，使反射扫描能发现它 |
