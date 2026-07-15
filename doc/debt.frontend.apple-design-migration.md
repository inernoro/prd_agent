# debt.frontend.apple-design-migration

> Apple 设计系统迁移(PR #1133)交付时主动声明的工程债务台账。
> 进度看板(SSOT)在 `doc/plan.frontend.apple-design-migration.md`;本台账只记「已知边界 / 后续可补 / 刻意取舍」,不重复进度。

| 状态 | 项 | 说明 | 优先级 |
|---|---|---|---|
| open | 手机轨剩余页面 | MobileToolboxView 字号/色魔数收敛(S)、MobileVisualAgentEditor 双皮肤迁移(M)、chrome 收尾(MobileFab/OverflowMenu/CompatGate/Segmented/SafeBoundary 补双皮肤) | P1 |
| open | PC 底座轨整条未开 | tokens.css 增 --ios-* 语义层、--font-body 改 SF-first、focus/accent/canvas 状态色对齐 iOS、design/* 原语色与圆角统一、硬编码清扫 hit-list。三项品牌决策已拍板(统一 iOS 蓝 / 后台内页 SF / 移动暗底纯黑),无阻塞 | P1 |
| open | AppStorePill 与 AppStorePillLabel 孪生 | 两者样式手写两份易漂移,底座0 审计已提出合并(统一走一份样式、button/span 只差外壳),本次未做 | P2 |
| open | AS_TYPE「严格 9 档」注释失真 | 实际档数已随 groupTitle(20px)扩档,appStoreTokens.ts:76 注释待订正为真实档数并收敛 | P3 |
| open | 首页近7日后端内存分桶 | /api/mobile/stats 的按日序列在内存分桶,单用户 7 日量级安全;重度用户 LLM 日志量大时可换 Mongo 聚合管道 + 索引评估(遵守 no-auto-index,索引走 DBA) | P3 |
| open | 未消费的原语 | AppStoreFeaturedCarousel/TipCard/Chips 已建但「摘要」版首页不再消费(商店范式弃用),保留给其他页(如百宝箱/发现页);若长期无消费方按 code-hygiene 清理 | P3 |
| by-design | 米多早报宫格色 #C05B3C | 非 iOS 色板,是刊系(report-design-system)赭红身份色,刻意保留不归一 | - |
| by-design | DailyPostPage 不迁移 | 纸墨刊系钉死 data-theme=light + 衬线,admin-dual-theme 明列 grandfather 例外,勿误改 | - |
| by-design | 进度条仅缺陷有 | recent-work 的 progress 只映射带状态机的实体(缺陷十态);工作区/知识库等无进度概念返回 null 不画,不造假(no-rootless-tree) | - |
| by-design | 七日柱 sqrt 缩放 | 迷你趋势柱对偏态数据用 sqrt 高度缩放(小值可见),是 sparkline 视觉选择非线性刻度;数值以旁边大数为准 | - |
