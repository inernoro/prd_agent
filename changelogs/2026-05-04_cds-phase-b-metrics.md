| feat | cds | `ContainerService.getServiceStats(names[])` 批量取一组容器的 docker stats —— 单次 `docker stats --no-stream --format "..."` 调用,parseDockerSize 解析 GiB/MiB/KiB/B 单位,容器不存在 / 已停时缺席不抛错。新增 `ContainerStats` interface 暴露 cpu/mem/net/blockIO/pids 字段 |
| feat | cds | 新增 `GET /api/branches/:id/metrics` —— 仅对 status=running 的 service 调 docker stats(避免拉所有容器),返回 `{ ts, services[], runningCount, totalCount }`,前端按 ts 算两次响应间 delta 得 rx/tx 速率 |
| feat | cds-web | 分支详情抽屉「指标」tab 落地(Phase B)—— MetricsPanel:5s 自动轮询 + 立即刷新按钮;每个 service 一张卡(状态 chip + container name + CPU/Mem 双进度条带颜色梯度<65%绿/<85%橙/>=85%红 + Net rx/tx 瞬时速率 + CPU 5min SVG sparkline);零 chart 库依赖(纯 SVG polyline ~30 行)关抽屉自动停 polling |
| test | cds | 新增 `tests/services/container-stats-parser.test.ts`(5 tests):空数组短路、单容器解析、批量 2 容器、docker fail 静默返空、GiB/kB/B 多单位混合。**全 tests: 1132 passed (1127 → 1132)** |
| chore | cds | `server.ts` 补 `[/^GET \/branches\/[^/]+\/metrics$/, '查看分支指标']` API label |
