| feat | prd-api | OpenDesign 新增直连设计执行服务（map-design-executor-v1）的执行器：查能力、提交、SSE 读事件断线续读、忙时排队重试并显示排队提示、取消时通知服务 |
| feat | prd-api | 新增 DesignRuntime:OpenDesign:Transport 开关（service / cds-session）：地址与密钥齐全时默认直连，否则照旧经 CDS 会话；显式直连缺配置时如实报不可用、不静默回退 |
| feat | prd-api | 设计运行时模型代理从网关响应读出实际使用的模型，值变化时写入任务并推送 model 事件，OpenDesign 任务面板可显示真实模型 |
| refactor | prd-api | OpenDesign 事件翻译收成一处，经 CDS 会话与直连服务两条传输面共用；进度映射补上服务接单阶段 task_accepted |
| docs | platform | 设计执行服务迁移表标注第 2、3 阶段现状；OpenDesign 台账补记本次未做项与协议文档出入 |
