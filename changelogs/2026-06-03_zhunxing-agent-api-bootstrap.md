| feat | prd-api | 新增准星智能体可开发版后端骨架（知识文档/条款管理、员工问答接口、一键 bootstrap） |
| docs | doc | 同步补充准星 appKey、SRS 模块说明与数据字典集合定义 |
| fix | prd-api | 修复 ZhunxingKnowledgeService 缺失 ILogger 命名空间导致的 CS0246 编译失败 |
| fix | prd-admin | 修复 public/thirdparty/ref 跨目录软链在 CDS 容器中失效导致的 Vite 构建 ENOENT |
| fix | prd-api | 兼容 ASSETS_PROVIDER=cloudflareR2/cloudflare-r2 并归一为 tencentCos，避免 API 启动崩溃 |
| feat | prd-admin | 在智能体首页新增“准星”卡片与问答页，接入 /zhunxing/ask 最小可用闭环 |
| fix | prd-admin/prd-api | 修复准星问答路径为 /api/zhunxing/ask，并补管理端 ask 接口以适配 CDS 网关转发 |
| feat | prd-api/prd-admin | 准星问答新增置信度与风险等级、条款全文展开、未命中一键反馈（含 feedback 持久化） |
| feat | prd-api/prd-admin | 新增准星管理员反馈看板（高频未命中问题聚类、反馈筛选分页列表） |
| feat | prd-api/prd-admin | 修复准星页面与接口权限错位，新增反馈工单状态流（受理/处理/解决/关闭）、历史问题回放验证与回访闭环 |
| feat | prd-api/prd-admin | 准星问答新增角色化输出（员工/主管/HR）、流程化决策树与条款冲突提示，提升执行可用性与风险控制 |
| feat | prd-api/prd-admin | 新增准星主题订阅与条款更新提醒、知识热力图（按反馈聚合热点与待处理风险） |
| feat | prd-admin | 重构准星问答页为 Knowledge OS 工作台风格，新增能力矩阵与未来能力预告区块，提前占位后续产品演进口子 |
| feat | prd-admin/prd-api | 统一准星对外描述为“企业AI知识中枢，覆盖问答、流程决策与风险预警。”，对齐入口卡片与App注册文案 |
| feat | prd-admin | 准星页面新增三档视觉风格切换（曙光蓝/雾银灰/深空黑），默认降低黑暗感并统一顶栏副标题口径 |
| feat | prd-admin | 准星页面升级为明亮呼吸感风格：默认晨曦白主题、漂浮光斑动效与卡片呼吸动画，并兼容降低动态效果设置 |
| feat | prd-admin/prd-api | 重构准星页面信息层级（可用入口/规划中/提示分区），新增文件库维护入口与部门级写权限隔离（跨部门上传/删除拦截） |
| fix | prd-admin | 关闭准星页面文字容器的呼吸位移动画，确保文字静止显示，减轻眩晕感 |
| feat | prd-admin | 进一步重构准星工作台布局：主功能入口高亮、规划与提示区压缩；默认紫蓝配色并新增数据光影流动背景动效（仅背景层） |
| feat | prd-api/prd-admin | 治理增强包 v2：新增分类树与标签字典、版本链路与文档Diff、到期自动失效巡检、部门权限组织树继承与文件库治理入口 |
