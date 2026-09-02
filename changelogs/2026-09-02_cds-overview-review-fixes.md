| fix | cds | 同名重建不再跨生命周期做速率差分：docker stats format 末尾加 {{.ID}}，容器短 ID 变了就切断差分。只靠「累计值变小」判重建是漏的——部署复用容器名，新容器若在首次采样前已比旧容器最后读数跑得更多，差值仍为正，会记出巨大的假速率尖峰（实测 99800 B/s） |
| fix | cds | docker stats 解析宽容到 7 段：ID 是新加的末段，缺了退回旧行为。硬要求 8 段的话任何一次拿不到 ID 都会让整批指标静默消失，比漏判一次重建严重得多 |
| fix | cds | 补上 GET /branches/:id/metrics/series 的 Activity Monitor 中文 label。已有的 /metrics pattern 用 $ 收尾接不住子路径，缺了只显示裸 URL，启动时 auditApiLabels 也会告警（cds/CLAUDE.md §0.1） |
| chore | cds | 删除无人调用的 forgetContainer 导出（形状 2 死接线）：容器身份改由 ID 判定，单点且能覆盖 CDS 之外的销毁，比在七八处销毁点逐个挂钩子稳；内存已由 MAX_CONTAINERS 兜底 |
| test | cds | 新增 5 条（ID 变了不做差 / ID 没变照常差分 / 没给 ID 时降级 / 老格式仍可解析 / metrics 与 metrics/series 各有 label），均做过红绿闭环 |
