| feat | llmgw | 模型池/逻辑模型/appCaller/交换所/模型新增删除端点，删除前查引用并分类报阻挡原因 |
| feat | llmgw | 控制台补齐五处删除入口，团队 chip 补上重命名入口（后端端点一直在，前端此前无入口） |
| fix | llmgw | 逻辑模型删除的审计动作名从 logical_model.delete 对齐为 logical-model.delete |
| test | prd-api | 新增删除链路四段接线守卫与 api.ts 反断头守卫，后者当场抓出 deleteModel 无调用点 |
