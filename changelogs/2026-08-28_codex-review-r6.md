| fix | prd-api | 站点访客数补上存量单站点分享（只有 SiteId 没有 SiteIds 的那类），此前这类分享的访问被整条漏掉、卡片仍显示 0 访客 |
| refactor | prd-api | 「一条分享指向哪几个站点」收敛成 WebPageShareLink.TargetSiteIds()，此前在读路径上被各写了一遍 |
| fix | prd-api | 开场问题落库没匹配上时不再报成已生成，新增 Superseded 结局并给出实话 |
