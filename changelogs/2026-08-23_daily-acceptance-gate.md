| feat | ops | 新增每日关键功能验收脚本 scripts/smoke/daily-acceptance.mjs：断言分享页 iframe 里真的有正文、勾选框在真实指针下可点，失败非零退出 |
| fix | prd-admin | CDN 注入的 cloudflareinsights beacon 是 type=module，导致每个托管站点都被踢出 srcDoc、落到会白屏的直链路径；预览前剥掉该遥测脚本 |
