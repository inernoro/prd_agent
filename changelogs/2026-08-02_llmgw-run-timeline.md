| feat | llmgw | 新增任务诊断时间线：按 RunId 或 LogicalRequestId 把一次业务任务的全部上游调用按时间排成一条链，直接给出卡在哪一步、重试几次、总共等了多久 |
| feat | llmgw | 控制台新增 /logs/runs/:runId 页面，请求记录页运行 ID 筛选框旁与请求详情路由过程内各加一个「查看任务时间线」入口，深链可直接发给同事 |
| refactor | llmgw | 操作类型中文标签注册表从 LogsView 提到 logsHelpers，日志列表与时间线共用同一份判定源 |
| test | llmgw | 新增时间线判据脱库单测（任务键宽度 / 不吞掉轮询与下载步骤 / 重试按逻辑请求分组 / 卡点定位）与端到入口的接线守卫 |
| ci | llmgw | server-build 路径过滤补登 llmgw/console-api，只改 console-api 的 PR 不再跳过网关守卫 |
