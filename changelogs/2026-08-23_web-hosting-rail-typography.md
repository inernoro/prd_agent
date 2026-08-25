| fix | prd-admin | 全站正文字族落到 var(--font-body)：Inter 早已加载、token 早已存在，但从未落到 body，正文一直吃 Tailwind 的 ui-sans-serif 兜底 |
| feat | prd-admin | tokens.css 新增字距阶梯（眉标/徽标/meta/标题/display/数字六档）与结论块 info callout 双主题 token |
| feat | prd-admin | 网页托管右栏按设计稿屏 1 重做：站点卡合并缩略图与标题、info 结论块、链接行内续期/数据、描边「再建一条链接」、新增「本周分享动态」 |
| fix | prd-admin | 站点结论句补访客数口径（累计 N 次访问来自 M 位访客），到期改说「其中 N 条 X 天后过期」 |
| refactor | prd-admin | fmtSize / relativeTime 抽进 siteFormat.ts，SiteCard 与 SiteContextPanel 不再各存一份 |
