| feat | prd-api | 新增准星智能体可开发版后端骨架（知识文档/条款管理、员工问答接口、一键 bootstrap） |
| docs | doc | 同步补充准星 appKey、SRS 模块说明与数据字典集合定义 |
| fix | prd-api | 修复 ZhunxingKnowledgeService 缺失 ILogger 命名空间导致的 CS0246 编译失败 |
| fix | prd-admin | 修复 public/thirdparty/ref 跨目录软链在 CDS 容器中失效导致的 Vite 构建 ENOENT |
| fix | prd-api | 兼容 ASSETS_PROVIDER=cloudflareR2/cloudflare-r2 并归一为 tencentCos，避免 API 启动崩溃 |
| feat | prd-admin | 在智能体首页新增“准星”卡片与问答页，接入 /zhunxing/ask 最小可用闭环 |
| fix | prd-admin/prd-api | 修复准星问答路径为 /api/zhunxing/ask，并补管理端 ask 接口以适配 CDS 网关转发 |
| feat | prd-api/prd-admin | 准星问答新增置信度与风险等级、条款全文展开、未命中一键反馈（含 feedback 持久化） |
| feat | prd-api/prd-admin | 新增准星管理员反馈看板（高频未命中问题聚类、反馈筛选分页列表） |
