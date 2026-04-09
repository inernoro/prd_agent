| feat | prd-admin | 新增「智识殿堂」公共知识库浏览页 (/library)，支持热门/最新/高赞/高阅排序 |
| feat | prd-admin | 新增公开知识库详情页 (/library/:storeId)，宏伟的图书馆主题（径向光晕 + 浮动星辰背景） |
| feat | prd-admin | 知识库详情页右上角新增「发布到智识殿堂」开关，一键切换公开/私有 |
| feat | prd-admin | 知识库新增分享对话框：公开直链 + 自定义短链（永不/1/7/30/90 天过期 + 撤销 + 复制 + 浏览统计） |
| feat | prd-admin | 公共知识库支持点赞/收藏/复制链接互动 |
| feat | prd-admin | 首页新增 LibrarySection 板块，展示最热的 6 个公共知识库（替代原 TutorialSection） |
| feat | prd-admin | AgentLauncher 入口替换：「使用教程」→「智识殿堂」 |
| refactor | prd-admin | 删除 TutorialsPage / TutorialDetailPage / tutorialData / TutorialSection 及 /tutorials 路由（注意：tutorial-email 系统未受影响） |
| feat | prd-api | DocumentStore 新增 LikeCount/ViewCount/FavoriteCount/CoverImageUrl 字段 |
| feat | prd-api | 新增 DocumentStoreLike / DocumentStoreFavorite / DocumentStoreShareLink 模型 + 3 个 MongoDB 集合 |
| feat | prd-api | 新增公开端点：GET /api/document-store/public/stores、/public/stores/{id}、/public/stores/{id}/entries、/public/entries/{id}/content（[AllowAnonymous]）|
| feat | prd-api | 新增互动端点：POST/DELETE /stores/{id}/like、POST/DELETE /stores/{id}/favorite、GET /favorites/mine |
| feat | prd-api | 新增分享链接端点：POST/GET /stores/{id}/share-links、DELETE /share-links/{id}、GET /public/share/{token} |
| feat | prd-api | GET /public/stores/{id} 自动累加 ViewCount 浏览数 |
