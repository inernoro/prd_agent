| fix | prd-api | 新增 LLM Gateway 上游故障与恢复通知，按平台和模型去重并提供日志深链 |
| fix | prd-admin | 模型目录加载失败时展示网关错误与请求编号，不再误报为空模型配置 |
| feat | llmgw | AppCaller 支持允许模型池集合、默认模型池与默认关闭的跨池回退开关 |
| feat | llmgw | 增加真实流量原子半开恢复、人工恢复候选入口与池级近期指标 |
| fix | prd-api | 严格模型池契约阻止逻辑模型越权并将跨池候选限制在显式授权范围 |
| feat | prd-admin | 视觉创作按模型池展示业务模型身份、近期成功率与平均耗时，并允许用户坚持选择不健康池 |
| fix | prd-admin | 补齐移动端故障站内信到 LLMGW 日志的安全深链 |
| fix | prd-admin | 模型目录加载失败时提供手动重载入口并保留已有模型目录 |
| docs | platform | 沉淀 MAP 与 LLMGW 职责边界、故障恢复计划、操作手册和验收矩阵 |
| fix | prd-api | 跨进程严格模型池请求保留已选池身份，避免图片生成二次解析失败 |
| fix | prd-api | 生图任务二次解析继续使用模型池身份，避免 Provider 模型名被误当作池选择 |
| fix | prd-api | 模型池近期成功率只统计已结束请求，避免运行中请求拉低指标 |
| fix | llmgw | 删除模型池前同时阻挡默认池和允许池集合引用 |
| fix | prd-admin | LLM Gateway 站内信跳转成功后才标记已处理，失败可重试 |
| fix | prd-api | 管理员网关告警仅对管理员可见可处理，并修正日志 requestId 深链 |
| fix | llmgw | 严格 AppCaller 模型池只允许已认领的 LLMGW 池，避免保存后运行时失效 |
| fix | prd-api | 显式模型池保持池内 Provider 重试，不再误把池选择当成单模型钉死 |
| fix | llmgw | 运行态与权威配置门禁要求所有允许模型池引用都存在，避免任一缺失项误报可发布 |
| fix | prd-api | 跨池回退为重试序列预留尝试位，并优先发送半开恢复候选 |
| fix | prd-admin | 模型池尺寸适配查询改用实际上游模型，恢复尺寸与比例选项 |
| fix | prd-api | 严格模型池请求校验 Provider pin 不得越过用户选定的模型池 |
