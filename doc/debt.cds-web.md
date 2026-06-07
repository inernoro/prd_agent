# debt.cds-web — CDS Web 前端工程债务台账

> 状态：active | 维护：随 PR 增补。记录已知边界 / 后续可补 / 暂不修的低优项,避免下次 session 重新发现。

## 已知边界 / 暂缓项

| # | 严重度 | 位置 | 描述 | 处置 |
|---|--------|------|------|------|
| 1 | P2 (低) | `cds/web/src/components/layout/AppShell.tsx` TopBar ⋮ sheet | sheet/backdrop portal 到 body 后 z-index 1000/1001;手机端从 ⋮ 选中「会打开 Radix Dialog 的动作」(如项目列表「一键部署」→ 创建项目)时,Dialog(z-50)被 sheet 盖住,看似打不开,需先关 sheet。根因:sheet 抬到 1000+ 高于全局 Dialog。 | 暂缓(PR#741 评审 Codex P2,自引入回归)。修复需二选一:(a) sheet 内动作触发后关闭 `actionsOpen`(但嵌套 Radix dropdown 的 item portal 到 body,sheet onClick 捕获不到,需跨组件信号/context);(b) 全局 z-index 统一收敛(Dialog 50 / 主题切换 60 / 抽屉 80 / sheet 当前 1001 纠缠,需一次性重排,让 sheet 落在「高于页面、低于 Dialog」)。建议走 (a):TopBar 暴露 close 回调或用 context,页面打开 Dialog 前先关 sheet。 |
