| feat | prd-api | 新增 `GET /api/my/shares`：跨 4 类 ShareLink（web_page / report / document_store / workflow）聚合当前用户的全部分享，关联 ShortLink 索引补齐数字 Seq，按 createdAt 倒序输出统一形态 + 按类型分组统计 |
| feat | prd-admin | 新增「我的分享」页面 `/my/shares`：按类型分类筛选 / 含已撤销切换 / 每条 3 种 URL 形态可一键复制 + 新标签打开 / 已撤销 / 已过期视觉降级 / 空状态引导文案 |
| feat | prd-admin | 注册百宝箱条目 `builtin-my-shares` + 短标签 `'shares' → '我的分享'` |
