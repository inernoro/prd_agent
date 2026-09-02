| fix | cds | 同名重建不再跨生命周期做速率差分：docker stats format 末尾加 {{.ID}}，容器短 ID 变了就切断差分。只靠「累计值变小」判重建是漏的——部署复用容器名，新容器若在首次采样前已比旧容器最后读数跑得更多，差值仍为正，会记出巨大的假速率尖峰（实测 99800 B/s） |
| fix | cds | docker stats 解析宽容到 7 段：ID 是新加的末段，缺了退回旧行为。硬要求 8 段的话任何一次拿不到 ID 都会让整批指标静默消失，比漏判一次重建严重得多 |
| fix | cds | 补上 GET /branches/:id/metrics/series 的 Activity Monitor 中文 label。已有的 /metrics pattern 用 $ 收尾接不住子路径，缺了只显示裸 URL，启动时 auditApiLabels 也会告警（cds/CLAUDE.md §0.1） |
| chore | cds | 删除无人调用的 forgetContainer 导出（形状 2 死接线）：容器身份改由 ID 判定，单点且能覆盖 CDS 之外的销毁，比在七八处销毁点逐个挂钩子稳；内存已由 MAX_CONTAINERS 兜底 |
| test | cds | 新增 5 条（ID 变了不做差 / ID 没变照常差分 / 没给 ID 时降级 / 老格式仍可解析 / metrics 与 metrics/series 各有 label），均做过红绿闭环 |
| fix | cds | 合计与构成条宽度改走 nowValue（实时优先），与旁边每服务的数字同一口径。此前图例走实时、合计走桶末值，同屏上大数比它旁边的数字慢 30-70 秒 |
| fix | cds | 历史端点失败不再被 catch 静默吞掉：新增 seriesError，持续失败时明说「曲线来不了，不是还没攒够」并端出实时读数。此前骨架屏会永远承诺一条不会出现的曲线 |
| fix | cds | 实时采样失败不再藏掉历史图：docker stats 挂了只在图上方加一条提示条，历史照画。两个数据源两个错误面，互不牵连 |
| test | cds | 新增 3 条守卫；并把两条被本次重构打红的既有守卫改成按意图断言——一条把闸门挂在错误文案上（文案一改就找不着），一条锁死了 `s.values.at(-1)` 字面量（形状 4a） |
