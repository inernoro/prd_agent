| feat | prd-admin | 网页生成工作台新增「产出形式：网页 / 网页 PPT」，选网页 PPT 时带着知识库稿子与要求交接给 HTML PPT 智能体，并列出带不过去的资料 |
| feat | prd-admin | 知识启动契约支持可选的要求预填，HTML PPT 智能体打开时把工作台里写好的要求填进输入框（不自动发送） |
| fix | prd-admin | 从团队空间交接到 HTML PPT 智能体时带上目标团队，发布前显示「发布到」哪个空间，发布请求携带 teamIds |
| fix | prd-admin | 网页 PPT 交接没写要求时带默认要求过去；「不带资料，直接打开」开空白会话，不再恢复上一次 |
| fix | prd-admin | 团队空间里点「不带资料，直接打开」开的空白 PPT 会话仍带着团队，发布落进同一团队 |
| refactor | prd-admin | 工作台发送分派收成纯函数 sendRoute，网页 PPT 只交接不建设计任务由行为测试守住 |
| fix | prd-admin | 网页 PPT 的发布落点在打开工作台时冻结，切换空间不再改变交接与空白入口的落点 |
