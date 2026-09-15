| fix | cds | 合并主干后修复主域默认站选取：根路径声明与按名兜底都在分支声明过的全部服务里选，主入口不可路由时不发默认路由，避免主域滑到兄弟网关 |
| security | cds | OpenDesign 会话必须由已验证的 MAP 连接来源发起，workspaceTransfer 的下载与回写地址逐一钉在该来源上，堵住项目级 Key／全局 Key／仪表盘 cookie 三条路径下的 SSRF |
| fix | prd-api | 原生 Responses 非流式响应改为先读完校验再交付，上游 200 却缺终态或内容类型不符时如实返回 502，不再让调用方读到一次干净的 200 加残缺输出 |
| fix | llmgw | 流式原生响应在终态缺失时可观测地终止（补 error 事件并中断连接），不再干净收尾冒充完整成功流 |
| fix | prd-api | 完整版本预览的可嵌入来源跟随已声明的 Cors:AllowedOrigins，跨源部署下 iframe 不再被 frame-ancestors 'self' 挡成空白；跨站嵌入时预览票据 cookie 降到 SameSite=None，同源部署维持 Strict |
| fix | prd-admin | 知识条目选择弹窗不再在容器上叠整体内边距（会和分区内边距叠起来），并把钉死共享弹窗实现的那条断言收回本组件自己的契约 |
| fix | prd-api | OpenDesign 运行时数据面放行清单补上 llm/v1/responses（Codex 运行时用的正是 responses 协议），并加反射守卫防止新增端点再漏登记 |
| fix | cds | 连接凭据放行 MAP 的单条会话回读（instance:read），停止返回不可判定错误时才分得清「已经没了」与「真失败」；会话列表仍不开放 |
| fix | prd-api | 设计运行时模型代理不再吞掉上游刻意造出的中断：已发头就同样中断下游，未发头返回 502 说明被上游中断，调用方断开仍保持安静 |
