| polish | prd-admin | 产品管理智能体卡片 hover 交互统一：grid 可点击卡片复用 pa-card（上浮+青色辉光+错峰入场），列表行/看板卡/紧凑项新增 pa-row（描边提亮+辉光，不上浮） |
| polish | prd-admin | 产品智能体工作台/报表/追溯矩阵/概览图表/活动时间线卡片补齐统一 hover 动效，与产品卡一致 |
| fix | prd-api | 修复产品知识库"文档空间不存在"：DocumentStore 读写判定补齐全局产品管理权限（Super/ProductAgentAdmin/ProductAgentManage），与产品访问口径对齐 |
| refactor | prd-admin | 产品知识库重构 P0：新增 4-Tab 知识模块（知识列表/分类管理/文件夹管理/标签管理），知识列表支持筛选/搜索/分页/增删改/重新上传，新增独立知识详情页路由 |
| feat | prd-api | DocumentEntry 新增 VersionIds 字段（知识关联版本 N:N），条目列表支持 category/tag/versionId/excludeFolders 过滤，更新端点支持 versionIds |
