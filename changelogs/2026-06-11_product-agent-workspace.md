| feat | prd-admin | 产品管理智能体工作台改版：AI助手内嵌主区（70%）+ 右栏我的待办/快捷操作（30%），移除右上角抽屉入口 |
| feat | prd-admin | 工作台新增「快捷操作」卡片：注册表模式收录 13 个系统操作，支持勾选/排序配置，默认创建需求/创建缺陷 |
| feat | prd-api | 新增产品管理智能体用户偏好端点（GET /api/product/preferences、PUT /api/product/preferences/quick-actions），配置用户级跨产品共用 |
| refactor | prd-admin | 工作台数据展示区（KPI/需求分级/缺陷状态/版本生命周期）并入报表 tab，报表重构为 KPI/进度/分布/版本四分区并去重 |
| refactor | prd-api | 产品 analytics 接口扩展返回 counts 与需求分级/缺陷状态/版本生命周期分布，前端不再拉列表自算 |
| polish | prd-admin | AI助手输入框增高为 Codex 桌面端风格大输入框（3 行起步 + 框内操作行），新增浏览器语音输入（Web Speech API，不支持自动隐藏） |
| polish | prd-admin | 工作台右栏「我的待办 / 快捷操作」按 7:3 固定分高，各自内部滚动 |
