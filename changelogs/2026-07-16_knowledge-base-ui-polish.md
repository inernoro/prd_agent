| feat | prd-admin | 知识库卡片支持右键菜单（与三点「更多」同源，另含打开/置顶） |
| feat | prd-admin | 今天有更新的知识库卡片右上角显示 NEW 徽标 |
| polish | prd-admin | 知识库卡片右上角降噪：状态（已分享/同步）改为安静小图标常显，置顶/更多动作 hover 才显现（触屏常显） |
| feat | prd-admin | 打开知识库默认选中第一篇文档（无主文档时按当前排序兜底，桌面端），右侧不再空白 |
| feat | prd-admin | 知识库书籍顺序下支持拖拽文档自定义排序（插入位置指示线，写入 SortOrder 服务端持久化） |
| polish | prd-admin | 知识库列表/库内排序、标签、置顶、更多等按钮补齐 hover 反馈；卡片 hover 改为克制的描边提亮（双主题） |
| fix | prd-api | 文档条目纯排序写入不再 bump UpdatedAt/团队动态，拖拽排序不会误点亮 NEW 或打乱「最近更新」 |
| style | prd-admin | 知识库卡片改素色实底面板（去玻璃 blur/棱光/噪点，双主题 token），hover 零位移只提亮描边 |
| feat | prd-admin | 置顶/取消置顶带 FLIP 位移动画 + 落点琥珀描边渐隐 + 平滑跟随滚动，库多时一眼看到卡片挪去了哪 |
| feat | prd-admin | 有置顶时列表分「已置顶 / 其他」两个小节，置顶卡片滑入分区落点明确 |
| polish | prd-admin | 知识库搜索框支持 ESC 一键清空 |
| feat | prd-admin | 知识库文件夹（章节）支持拖拽同级换位（书籍顺序下，插入指示线 + SortOrder 持久化），文件夹行补 hover 反馈 |
| polish | prd-admin | 知识库目录行重排（拖拽/置顶/切排序）带 FLIP 位移动画，行滑到新位置而非瞬移 |
| feat | prd-admin | 团队空间卡片标注归属团队（首个团队名 +N，tooltip 列全量），「全部」聚合视图不再分不清来源 |
