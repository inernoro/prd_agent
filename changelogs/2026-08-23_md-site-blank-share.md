| fix | prd-api | 站点正文代理不再一刀切拒绝包装站：Markdown 包装站的壳子就是服务端渲染好的完整正文，放行给 srcDoc；PDF/视频壳仍拒绝 |
| fix | prd-admin | hasFetchableHtml 改 default-deny 白名单，Markdown 包装站走 srcDoc；修掉 MD 站分享页标题栏下一片白 |
