| fix | prd-api | 修复知识库分享链接打不开：分享 URL 统一为 /s/lib/{token}，新增 token 门禁的匿名端点（列条目 + 取正文）支持分享私有库，AccessShareLink 返回 entryId 支持单篇文档分享 |
| fix | prd-admin | 知识库分享链接从失效的 /library/share/{token} 改为统一的 /s/lib/{token}，新增全屏公开展示页 LibraryShareViewPage（复用 LibraryDocReader），接入 ShortLinkRouter |
| feat | prd-admin | 知识库支持单篇文档分享：文件树右键新增「分享」入口，分享弹窗区分整库/单篇 |
| feat | prd-admin | 知识库空状态同时提供「新建文档」+「上传文档」双入口；新建文档后默认进入编辑态，无需再点一次编辑 |
| fix | prd-api | MySharesController 知识库分享 PrimaryPath 修正为 /s/lib/{token} 并标记 Viewable，「我的分享」聚合页链接可正常打开 |
