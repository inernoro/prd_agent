| feat | cds | 新增容器指标历史存储 container-metrics-history：45s 常驻采样器与抽屉 5s 端点两路采集统一写入，抽屉关掉不再丢历史，窗口从 5 分钟拉到 30 分钟 |
| feat | cds | 新增 GET /api/branches/:id/metrics/series，查询契约借 Netdata 形状（after / before / points / group），降采样在服务端按时间等宽分桶完成 |
| fix | cds | resource-usage-sampler 此前拿到完整 docker stats 却只留最新一帧、只按项目汇总，net 与 limit 直接丢弃；现在整帧喂给历史存储 |
| fix | cds | 网络速率改由服务端按累计差分计算：容器重建导致计数器回绕时记 0 不出负数，采样断档超过 5 分钟不编造平均速率 |
| perf | cds | 总览图表进抽屉即由服务端历史铺底，不再空图等 10 秒攒点 |
| test | cds | 新增 container-metrics-history 测试 18 例（速率差分 / 回绕 / 断档 / 有界 / 时间等宽分桶 / 两路接线），两条关键判据做过红绿闭环 |
