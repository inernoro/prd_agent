| fix | prd-admin | 海报编辑页 76% 缩放预览下标题溢出修复：把 PosterAdPageView / PosterRichTextPageView / WeeklyPosterPageView 的字号从 vw 改成 cqw（容器查询单位），字号跟随容器宽度自适应而非 viewport，缩放预览不再溢出 |
| fix | prd-admin | 9:16 竖屏首页弹窗也加大到 540px（+17.4%），4:3/16:9/ad-4-3 视口预算从 80px 缩到 40px 让 cap 在 1080p 屏上能用满 |
