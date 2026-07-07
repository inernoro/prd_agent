| feat | prd-api | 知识库新增一键生成双链任务(autolink Run/Worker):标题精确匹配,把正文中其他文档标题的首次出现改写为 [[标题]],跳过代码块/链接/frontmatter,幂等可重跑,SSE 推送逐篇进度 |
| refactor | prd-api | 从 DocumentStoreController 抽取 EntryContentWriteService 共享正文写入路径(ParsedPrd 内容寻址+摘要索引+重锚评论+重算双链+双版本快照),在线编辑/版本恢复/自动补链三方共用 |
| test | prd-api | 新增 WikiLinkAutoLinker 单元测试 17 例(长标题优先/保护区间/幂等/ASCII 边界/候选过滤) |
| feat | prd-admin | Obsidian 双链图页右上角新增「生成双链」按钮:SSE 实时显示 N/总数 扫描进度,完成后展示扫描/改写/新增链接统计并自动刷新图谱 |
| feat | prd-admin | 知识星球 3D 页顶栏新增「折叠 2D / 展开 3D」切换:星点/光路/流光整组沿 Z 轴动画压平成平面图,相机同步飞到正视机位;折叠态锁旋转、两指滑动改平移 |
