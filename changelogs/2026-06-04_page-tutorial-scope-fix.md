| fix | prd-admin | 修复「本页教程」打开却弹出别页教程:教程抽屉改为按当前路由作用域过滤,移除随机兜底,无本页教程时给空态+「浏览全部」入口 |
| fix | prd-admin | 修复多步引导连续找不到锚点时旧光圈滞留导致「每步都指向同一元素」的错觉(SpotlightOverlay 切步时若目标不在 DOM 先清光圈改显「正在定位」) |
| fix | prd-admin | 本页没有任何教程时不再显示「本页教程」入口按钮;按钮显隐与抽屉作用域共用 filterPageTips 单一过滤逻辑(SSOT) |
| fix | prd-admin | 移除「本日首访自动展开教程抽屉」兜底:不再在用户未点按钮时自动弹出残留公告类教程,教程入口统一走页头常驻按钮(仅管理员定向推送 + 未走完 page-guide 的 Spotlight 仍自动) |
| feat | prd-admin | 学会的本页教程(*-page-guide)按钮保留可随时重看:学会后停止自动开讲/入口脉冲,抽屉显示「已学会」标签,入口仍在 |
| fix | prd-api | /visible 对 *-page-guide 学会后不再过滤(仍返回并带 learned=true),供前端保留重看入口;非 page-guide 学会仍隐藏 |
| fix | prd-admin | 引导气泡「下一步/完成」按钮始终钳进视口:按实测气泡高度限制 bubbleTop + 气泡 maxHeight 自滚,修复高亮元素过高/贴底时完成按钮跑到屏幕外点不到 |
