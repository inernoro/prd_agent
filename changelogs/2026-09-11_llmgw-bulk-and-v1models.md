| feat | llmgw | 批量导入上游模型时一步登上白名单：同时建公开模型名与上游线路，同名只加线路 |
| feat | llmgw | serving 补 GET /v1/models 与 /v1/models/{id}，OpenAI 标准清单，按 key 过滤白名单 |
| feat | llmgw | 对外清单按线路逐条报价，非美金整条不报，一条算不出价时 pricing 写 null |
| fix | llmgw | 公开模型名剥掉供应商前缀，官网与中转导入的同一模型不再变成两个条目 |
| feat | llmgw | 白名单页补「从上游批量登记」直达入口，导入结果如实回显登记了几个 |
| test | prd-api | 新增批量登记与对外清单守卫五条，测试项目引用 console-api 以做行为断言 |
