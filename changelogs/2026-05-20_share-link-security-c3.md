| feat | prd-api | P1 URL 统一：4 处分享创建端点全部走 `/s/{token}` 字母长链；不再使用 `/s/wp/`、`/s/report-team/` 等分类前缀 |
| feat | prd-api | 周报 / 知识库 / 工作流分享创建时同步注册到 ShortLink 全局索引（之前只有网页托管在用），同时返回 `shareUrl=/s/{token}` 和可选 `shortShareUrl=/s/{seq}` |
| feat | prd-api | `IShortLinkService.ResolveByTokenAsync` + `GET /api/short-links/resolve/{slug}` 接受任意 slug（纯数字 → Seq，字母 → Token），统一调度入口 |
| feat | prd-admin | `ShortLinkRouter` 放开"slug 必须纯数字"限制，字母 token 也能命中；网页托管直接 mount 子组件（URL bar 不变），周报/知识库/工作流暂用 Navigate 跳转兼容 ViewPage（待 P1.next 接 tokenOverride prop） |
| fix | prd-admin | WebPagesPage ShareDialog 默认 URL 从 `legacyShareUrl=/s/wp/{token}` 切换到 `shareUrl=/s/{token}`（P1 统一格式），短链选项走 `shortShareUrl` |
| docs | doc | 更新 `doc/debt.share-link-security.md` 加入 P1.next 待办：周报/知识库/工作流 ViewPage 接 tokenOverride 让 URL bar 始终保持 /s/{token}；分享测试器实验室页 |
