| fix | prd-api | 未在 GW 登记、或 MAP 绑定已悬空的 appCaller 回落到该类型的 GW 默认模型池，且排在 legacy 直连之前 |
| fix | prd-api | 该回落是硬边界：expectedModel 的全量池搜索、LLMModels 直连、池内全不可用后的 legacy 退路三个出口全部关闭；embedding/asr/video-gen 三类悬空绑定继续失败关闭 |
| fix | prd-api | 转录整理失败不再静默降级：笔记里新开「整理未生成」小节写清原因（不写进「摘要」，否则前端会误判纪要已就绪），原文照旧完整保存；重整成功会清掉该节 |
| fix | prd-api | 上游流正常结束却零输出（内容过滤/空补全）同样算降级，不再退回静默 |
| test | prd-api | 补 Mongo 实测用例：未登记回落、悬空绑定压过 legacy、兜底不扩搜索范围、embedding 仍 fail closed、登记但绑的池不存在仍 fail closed |
| docs | prd-api | 台账记下摘要静默为空的真因、当日生产配置动作与仍欠的三笔 |
