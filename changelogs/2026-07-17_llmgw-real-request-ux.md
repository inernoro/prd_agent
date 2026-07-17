| fix | llmgw | Quickstart 区分安全连通与真实模型请求，并在同页预览模型池、Provider 和实际模型 |
| fix | llmgw-serving | 修复外部 scoped key 路由预览被错误强制识别为 MAP 来源的问题 |
| fix | llmgw-web | 兼容 Gateway 路由预览的 PascalCase wire contract，避免真实路由被误报为不可识别 |
| polish | llmgw-web | appCaller 改为摘要列表与渐进配置，请求详情按核心指标、上游响应和高级审计分层，并统一控制台字体密度 |
| polish | llmgw-web | appCaller 在手机端改为完整摘要卡片并保留路由治理配置，避免横向表格遮断信息 |
| polish | llmgw-web | 生成详情按概览、请求与响应、路由和审计四类重组，补齐加载失败反馈并让核心指标优先可见 |
| fix | llmgw-web | 上游响应改为三列纵向信息卡，修复长 Provider、模型和模型池文本在详情抽屉中粘连重叠 |
| fix | llmgw-web | 请求记录的 requestId 深链在唯一命中后自动打开生成详情，避免移动端还要点击拥挤表格 |
| test | llmgw | 更新生成详情数据域保护断言，覆盖四类页签与加载失败兜底 |
| docs | llmgw | 更正 CDS Quickstart 真实请求证据并沉淀 OpenRouter 微观体验基线 |
| docs | llmgw | 更新模型网关权威教程的 Generation details 四页签、requestId 自动打开和会话边界说明，并增加四张实测图 |
| security | llmgw | Quickstart 真实模式与复制片段绑定当前 Gateway 地址的路由预检，地址变化后自动退回安全模式 |
| fix | llmgw | GW Native cURL 的请求头和正文复用同一个动态 requestId，避免日志串号与重复审计标识 |
| fix | llmgw | appCaller 模型池深链筛选加入可见筛选条件及服务端批量治理过滤，防止越池更新 |
| fix | llmgw-serving | resolve 路由预览支持 header-only 来源校验且不再写入 appCaller 活跃度 |
