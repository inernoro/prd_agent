| feat | prd-api | 新增统一短链基础设施（short_links 集合 + ShortLinkService + GET /api/short-links/{seq}），所有分享系统将共用 /s/{seq} 数字短链 |
| feat | prd-api | 网页托管分享接入统一短链：CreateShare 自动分配 Seq，POST /api/web-pages/share 返回 shareUrl=/s/{seq}（兼容字段 legacyShareUrl=/s/wp/{token}） |
| feat | prd-admin | 新增 /s/:slug 统一短链路由 + ShortLinkRouter 组件，数字 slug 解析后渲染对应分享视图；老链接 /s/wp/:token 继续兼容 |
| feat | prd-admin | 网页托管分享 UI 改为优先展示短链 /s/{seq}（分享创建、复制、预览、快速分享弹窗），无短链时退回老 /s/wp/{token} |
