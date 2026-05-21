| fix | prd-api | P1 反转（用户反馈方向调整）：4 处分享创建端点默认 URL 恢复带分类前缀长链（`/s/wp/`、`/s/report-team/`、`/public/share/`），不再统一到 `/s/{token}`。原因：分类前缀有语义、利于分享总管理面板按类型分类 |
| fix | prd-api | 同时返回 `unifiedShareUrl=/s/{token}` 字母统一长链作为高级选项；`shortShareUrl=/s/{seq}` 数字超短链保留作为可选；ShortLink 全局索引继续注册（这是"分享总管理"的数据基础） |
| fix | prd-admin | WebPagesPage ShareDialog 同步：默认 `shareUrl`（带前缀长链），用户主动切换才用 `shortShareUrl`；types 更新 `legacyShareUrl` → `unifiedShareUrl` |
