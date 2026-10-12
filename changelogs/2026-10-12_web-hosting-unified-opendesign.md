| feat | prd-admin | 网页生成与修改入口移除执行器选择，统一展示 OpenDesign 流程 |
| feat | prd-api | 新网页生成与修改任务由服务端强制使用 OpenDesign 并收口旧客户端直连参数 |
| test | prd-admin | 补充网页运行时单一路径与入口回归测试 |
| test | prd-api | 补充旧客户端兼容改写和 OpenDesign 不可用负面路径测试 |
| fix | cds | 让 MAP API 与设计服务从同一份 LLMGW 基址派生模型出口，避免部署配置漂移 |
| test | cds | 补充 API 与设计服务 LLMGW 地址同源的部署契约测试 |
| test | prd-api | 对齐 LLMGW 基址同源派生的跨服务部署合同守卫 |
| fix | prd-admin | 补齐移动端网页托管的生成网页主入口，同时保留可发现的上传操作 |
