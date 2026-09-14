| feat | llmgw | 模型页新增「调用全貌」：六步推演现在发一个请求会落到谁，含只给 appCallerCode 不点名那条路 |
| feat | llmgw | 新增 GET /gw/logical-models/{id}/call-trace：目录闸、不点名去向、候选线路逐条、协议、近 30 天账本 |
| fix | llmgw | 前端不再自己判「哪条线路在扛流量」，改用服务端下发的排队名次——旧判据比运行时严，把降级但仍在承接的线路显示成「没有主」 |
| refactor | prd-api | 挑选判据抽成 GatewayRouteSelection 纯函数，ModelResolver 调它；停用与熔断不再写在 Mongo 查询条件里 |
| test | prd-api | 新增判据行为对照：同一组输入喂运行时与控制台镜像，逐条断言结果一致，红绿闭环跑通 |
| docs | doc | 新增 design.platform.llm-gateway.model-architecture：四层架构、一次调用七步、异构上游三个槽 |
| fix | llmgw | 调用全貌的默认模型查询补 Enabled 与排序，与运行时逐条对齐；「会落到它」增加「真有一条线路能接」这一条 |
| fix | llmgw | 跳过判据补「目标模型或所属上游被停用」这一档——线上队首指向的物理模型是停用的，面板照样指着它 |
| polish | llmgw | 模型行按钮列放宽，「调用全貌」「展开」不再挤成一列每行一个字；协议未显式配时说「跟着目标模型走」而不是拼一个假适配器名 |
| test | e2e | 新增调用全貌真人路径验收脚本；双主题判据改为「两张图真的不一样」，此前只断言「不是深色底」而默认本就是浅色 |
