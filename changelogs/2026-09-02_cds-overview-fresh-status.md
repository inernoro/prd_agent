| fix | cds | 总览的服务状态改取 /metrics 每 5 秒返回的那一份，不再用抽屉打开时的 branch.services 快照。快照不随 SSE / 轮询更新，会两头出错：刚启动完的服务有实时读数却被标「停止」并排除出合计；被外部停掉的服务还挂着停机前的旧值 |
| test | cds | 新增 2 条守卫（status 取自新鲜来源 / 该来源是 metricsState），做过红绿闭环 |
