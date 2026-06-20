| feat | prd-api | 团队动态新增体验全景热力图端点 GET /api/team-activity/experience-map（按模块聚合端点访问量/报错率/慢请求率，与 insights 同源 apirequestlogs，target 同口径供下钻联动） |
| feat | prd-admin | 行为洞察 tab 顶部新增体验全景热力图（squarified treemap）：每块=端点、面积=访问量、颜色=健康，痛点带发光描边，点击下钻联动到下方痛点榜对应行 |
| fix | prd-admin | CDS 静态部署修复：serve 改为本地 devDependency + pnpm exec serve 启动，避免受限网络下运行时拉包失败(Command serve not found) |
| polish | prd-api | 体验全景热力图模块/端点名改中文示意名(SegmentLabels+LeafLabel)，原始路径保留在悬浮提示，分区上限放宽到 24 |
| feat | prd-admin | 体验全景热力图入场动画(react-bits 交错揭示)+ 实时扫描光带 + 醒目"实时扫描中"徽章；右侧新增可折叠"体验痛点指数"仪表盘 + 痛点声道占比(从痛点榜现算) |
| docs | doc | 新增 design.team-activity-voc 设计文档(VOC 设计思想/数据流/波次规划)，同步 index.yml 与 guide.list |
| polish | prd-admin | 热力图入场动画重做为两遍「写字→点睛」：块随扫描笔尖经过(按x位置)依次写出全部→写完后痛点才点睛(扩散环ping+脉冲描边+辉光)；扫描笔与块写出严格同步且一次画完即隐(不空转)，绑定真实数据刷新重放 |
| feat | prd-admin | 热力图换时间窗时块「生长」morph：几何尺寸/位置 CSS 过渡平滑补间(谁访问多谁长大可见)；入场写字+点睛用 isEntrance 闸门仅首屏放一次，之后只 morph 不重演 |
| fix | prd-admin | 修复热力图左上角文字糊块：CSS x/y 几何属性对 <text> 无效导致所有标签掉回原点(0,0)堆叠，文字位置改回属性(rect 尺寸仍走 style 过渡做生长) |
