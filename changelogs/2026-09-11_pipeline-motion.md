| feat | cds | 验收首页厂房剖面加入场动效：货堆按行摞起、未部署那只真的往下掉、过闸的条落进料仓、项目垛逐根长起、场外点阵散开，滚轮常驻慢转；大数字从 0 涨到真值 |
| feat | cds | 动效整体关在 prefers-reduced-motion: no-preference 内，基础样式即终态，动画没跑/reduce 用户看到的都是完整静态图 |
| test | cds | 新增动效接线守卫（keyframes 两头对齐、animation 不许逸出媒体块、基础样式不许写 opacity:0、类名两头都挂上、计数初值必须是真值） |
