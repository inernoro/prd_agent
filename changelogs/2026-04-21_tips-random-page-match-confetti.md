| feat | prd-admin | TipsDrawer 抽屉**每次打开随机选一条 tip** 展示,避免用户停留在固定 index 看同一条;若当前页面 URL 匹配某条 tip 的 actionUrl(完整匹配 / 路径前缀),优先选它 |
| feat | prd-admin | 当前页面有匹配 tip 时,右下角小书图标**红色脉冲**(`tipsBookPulse` 2s 呼吸 + 红色 drop-shadow),提示用户「这页有教程」 |
| feat | prd-admin | 新增 `components/daily-tips/fireConfetti.ts` 轻量撒花工具:emoji + CSS animation,~80 行,无第三方库,尊重 `prefers-reduced-motion` |
| feat | prd-admin | SpotlightOverlay 多步 Tour 走到最后一步,点「完成 🎉」按钮:撒花 + 调用 `dismissTipForever(tip.id)` 永久不再提示;单步模式仅显示「知道了」不撒花。`SpotlightActionPayload` 新增 `id` 字段透传,seed-* id 自动跳过 |
| docs | doc | 新增 `doc/plan.daily-tips-scenarios-and-staleness.md`(交接文档,1.5 人天):**阶段 A** 三场景统一(SourceType 规范化 + 缺陷修复闭环回执 + 管理界面分类)、**阶段 B** 过时检测自动化(锚点扫描 + 90 天低参与度 + 后台 IHostedService 每天扫描 + 管理界面批量清理);同步 `doc/index.yml` |
