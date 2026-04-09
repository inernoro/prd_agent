| feat | prd-admin | 知识库卡片支持重命名：hover 时在标题右侧显示铅笔按钮，弹窗内编辑即可保存（复用 PUT /api/document-store/stores/{id}） |
| feat | prd-admin | 知识库页新增「我的空间 / 我的收藏 / 我的点赞」标签切换；收藏/点赞 tab 下点击卡片跳转 /library/{id} 公开详情页（若收藏的是自己创建的空间则进入编辑视图） |
| feat | prd-api | DocumentStoreController 新增 GET /api/document-store/likes/mine；同步增强 GET /api/document-store/favorites/mine 返回最近 3 个文档预览、店主信息及 isOwner 标记，与 stores/with-preview 卡片结构对齐 |
