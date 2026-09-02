| feat | cds | 分支详情「总览」重排：八个等重方块（其中四个常年显示 0）+ 每服务一张大卡，换成分段健康环、CPU 堆叠面积图、内存横向构成条、吞吐双向图（网络一行 + 磁盘一行）、部署耗时柱状图、入口卡组 |
| feat | cds | 新增容器指标历史存储：45s 常驻采样器与抽屉 5s 端点两路采集统一落一处，抽屉关掉不再丢历史，窗口从 5 分钟拉到 30 分钟 |
| feat | cds | 新增 GET /api/branches/:id/metrics/series，查询契约与渲染约定都照 Netdata 的做法：after / before / points / group；没采到的桶给 null 且不进几何（缺口就是缺口，不画成 0）；桶边界钉在绝对时间网格上，时间往前走只在右边追加新桶 |
| feat | cds | 图的分辨率不细于采集节奏（桶宽 ≥ 观测节奏的 1.5 倍），避免整图变成一片「画的是采集节奏而不是 CPU」的均匀锯齿 |
| feat | cds | 补采磁盘 I/O：docker stats 一直在返回 BlockIO、ContainerStats 一直在解析，只有历史存储没收。并入吞吐卡，不新增卡片 |
| feat | cds | 新增系列色 token --series-1..5 与 --series-net（双主题同值，过 dataviz 六项校验）；语义四色 ok/warn/bad/info 保持状态专用，不参与系列配色 |
| feat | cds | 出图前是图形骨架 + 诚实进度（已有 N 帧 · 约还需 X 秒），不再是虚线空框「正在读取指标历史…」；曲线还没攒够时先端出已有的实时读数 |
| feat | cds | 数据更新走数值补间（easeOutCubic 420ms），形状变化时直接切，尊重 prefers-reduced-motion |
| fix | cds | 指标存内存绝对字节而非百分比：没配 mem_limit 时 Docker 报的限额是宿主机总量，百分比四舍五入恒为 0，读不出信息 |
| fix | cds | 速率由累计值差分算出，并处理计数器回绕、采样断档、同名容器重建（按容器短 ID 切断跨生命周期差分）与两个写入方毫秒级撞车 |
| fix | cds | 总览的服务成员集合与状态整份取自 /metrics 的这一帧，不再用抽屉打开时的快照；一次轮询失败保留上一次成功响应，不让健康环随网络抖动跳一下再跳回来 |
| fix | cds | 一屏之内不许自相矛盾：判断句、色调、入口卡绿灯同走一个判据；分支没在跑时 CPU / 内存 / 吞吐都不报「当前值」，历史几何照留 |
| fix | cds | 「当前值」一律取最后一个真有样本的桶（实时快照优先），不取被零填充的末格；实时快照与桶末值不再在同一屏上差 30-70 秒 |
| fix | cds | 「打开正在跑的预览」拆出独立的 open 操作类型，且部署去重把 preview / deploy / rebuild 三种构建叫法归一——前者防没发生的构建被算成失败，后者防同一次部署算两遍 |
| fix | cds | 部署耗时柱状图改吃含操作日志的合并来源：原来那份按分支 id 作键、一个分支最多一条，柱状图要 3 条才画，这张卡从落地起就没渲染出来过 |
| fix | cds | 补上 GET /branches/:id/metrics/series 的 Activity Monitor 中文 label（已有的 /metrics pattern 用 $ 收尾接不住子路径） |
| test | cds | 新增 container-metrics-history 48 例与 branch-overview-panel 82 例，覆盖速率差分与回绕、时间等宽分桶与网格稳定性、缺口几何、当前值口径、kind 别名归一、模块顶层副作用等；新增判据均做过红绿闭环 |
