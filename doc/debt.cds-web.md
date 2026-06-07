# debt.cds-web — CDS Web 前端工程债务台账

> 状态：active | 维护：随 PR 增补。记录已知边界 / 后续可补 / 暂不修的低优项,避免下次 session 重新发现。

## 已知边界 / 暂缓项

| # | 严重度 | 位置 | 描述 | 处置 |
|---|--------|------|------|------|
| 1 | P2 (低) | `cds/web/src/pages/LoginPage.tsx` 登录提交 `navigate(target)` | basic-auth 用户若从 legacy 地址(如 `/settings.html?project=foo`)被重定向,登录后 SPA `navigate` 不经服务端 legacy→新路由重写,React Router 视 `/settings.html` 为未知路由 → 落到 `/project-list` 而非目标项目设置页。SPA 跳转早于本 PR(本 PR 仅加 viewTransition),且仅影响 legacy URL 登录回跳这一窄场景。 | 暂缓(PR#741 评审 Codex P2)。后续可补:`redirectTarget()` 归一化 legacy 路径(`/settings.html?project=X`→`/settings/X`、`/index.html?project=X`→`/branches/X`)后再 SPA 跳,或对未知 legacy 后缀走 `window.location.assign` 硬跳。 |
