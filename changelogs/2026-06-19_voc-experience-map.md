| feat | prd-api | 团队动态新增体验全景热力图端点 GET /api/team-activity/experience-map（按模块聚合端点访问量/报错率/慢请求率，与 insights 同源 apirequestlogs，target 同口径供下钻联动） |
| feat | prd-admin | 行为洞察 tab 顶部新增体验全景热力图（squarified treemap）：每块=端点、面积=访问量、颜色=健康，痛点带发光描边，点击下钻联动到下方痛点榜对应行 |
| fix | prd-admin | CDS 静态部署修复：serve 改为本地 devDependency + pnpm exec serve 启动，避免受限网络下运行时拉包失败(Command serve not found) |
| polish | prd-api | 体验全景热力图模块/端点名改中文示意名(SegmentLabels+LeafLabel)，原始路径保留在悬浮提示，分区上限放宽到 24 |
