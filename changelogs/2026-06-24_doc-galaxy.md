| feat | prd-admin | 知识库文档星系：新增关系识别业务逻辑核心 buildDocGalaxy（点分命名→文件夹/parentId 兜底→叠加双链，与可视化解耦的纯函数 SSOT）+ canonical appname 四大类分类器 + 10 项单测 |
| feat | prd-admin | 知识库「关系图谱」页新增 宇宙图/星系 切换：DocumentGalaxyView（R3F 3D 放射星系，按 docType 七色上色，点文档星复用 MarkdownViewer 全文阅读面板），消费 buildDocGalaxy，懒加载、宇宙图功能零改动 |
| fix | prd-admin | 星系视图分页取全 entries（跟 total 翻页，修 >200 文档库丢文档/双链）+ 切到星系时停掉宇宙图 RAF 力导向循环（修后台空转抢主线程）|
| fix | prd-admin | 星系分类器容旧扁平名：最长 canonical 前缀去扁平化（cds-project-migration → cds 下钻），真数据 346 篇悬空 79%→36%、cds-* 收进单一 cds 节点 |
