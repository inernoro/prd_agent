| fix | prd-api | 网页托管分享数字短链改为按需懒分配，默认创建只发不可枚举的 /s/wp/{token} 长链，不再无脑写入 short_links 集合 |
| feat | prd-api | 新增 POST /api/web-pages/shares/{shareId}/short-link 端点，支持事后为已存在分享按需生成数字短链（幂等） |
| fix | prd-admin | 分享管理面板主链接/复制/预览默认走字母长链，修复「用户没选数字短链却总拿到 /s/{seq} 数字链」问题；数字短链改为单独「生成/复制」按钮主动获取 |
