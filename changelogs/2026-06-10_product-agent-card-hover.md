| polish | prd-admin | 产品管理智能体卡片 hover 交互统一：grid 可点击卡片复用 pa-card（上浮+青色辉光+错峰入场），列表行/看板卡/紧凑项新增 pa-row（描边提亮+辉光，不上浮） |
| polish | prd-admin | 产品智能体工作台/报表/追溯矩阵/概览图表/活动时间线卡片补齐统一 hover 动效，与产品卡一致 |
| fix | prd-api | 修复产品知识库"文档空间不存在"：DocumentStore 读写判定补齐全局产品管理权限（Super/ProductAgentAdmin/ProductAgentManage），与产品访问口径对齐 |
| refactor | prd-admin | 产品知识库重构 P0：新增 4-Tab 知识模块（知识列表/分类管理/文件夹管理/标签管理），知识列表支持筛选/搜索/分页/增删改/重新上传，新增独立知识详情页路由 |
| feat | prd-api | DocumentEntry 新增 VersionIds 字段（知识关联版本 N:N），条目列表支持 category/tag/versionId/excludeFolders 过滤，更新端点支持 versionIds |
| feat | prd-admin | 产品知识库重构 P1：版本详情「本版本知识」调取卡（从产品库按版本筛选+关联知识对话框），总览知识库改为跨产品聚合列表（搜索/产品筛选/分页/进详情页） |
| refactor | prd-api | 版本独立知识库下线：懒迁移旧版本库条目进产品库（VersionIds 标记归属，幂等），新增总览聚合知识端点 /overview/knowledge/entries |
| chore | prd-admin | 清理死代码：VersionRelationModal / KnowledgeStoreModal / ProductKnowledgePanel 下线 |
| feat | prd-admin | 知识详情页重写：左侧文件夹目录快速切换、HTML 直接预览+代码模式切换、富文本编辑器（图片上传/粘贴/拖拽 + 附件上传），新建文档默认富文本 |
| feat | prd-api | DocumentStore 内容更新端点支持可选 contentType（富文本编辑后置为 text/html） |
| fix | prd-admin | 知识详情 HTML 预览改为沙箱 iframe 真实网页渲染（保留自带样式/布局/脚本视觉，预览容器放宽至 1400px），富文本片段仍走主题内联渲染 |
| polish | prd-admin | 知识详情：预览/代码切换仅对完整 HTML 网页显示（md/富文本片段不再显示）；显示卡片与富文本编辑器宽度/样式统一；列表点标题快捷改名；详情目录双击标题改名 |
| fix | prd-admin | 富文本工具栏逐项修复：execCommand 前确保光标在编辑器内（修「点了没反应」），标题/引用/代码块改为可切回正文的块级切换，styleWithCSS=false 输出语义标签 |
| fix | prd-admin | 富文本工具栏根治：新增 knowledge-rich 作用域 CSS（Tailwind preflight 重置了 h2/blockquote/ul/pre 默认样式导致 formatBlock 生效但视觉无变化），编辑器与片段渲染同 class 所见即所得 |
| fix | prd-admin | 知识格式纠错：contentType 误标 html 但正文无标签的按 Markdown 渲染与编辑（保存自动纠正类型），详情页新增「格式」手动切换（Markdown/富文本）；md 预览/编辑宽度与 HTML 统一为 1400 |
| feat | prd-api | UpdateEntry 支持可选 contentType（格式纠错 Markdown 与 HTML 互转） |
| fix | prd-admin | md 格式显示 HTML 裸标签乱码根治：新增 HTML↔Markdown 轻量互转；格式切换真正转换正文、markdown 模式遇 HTML 正文兜底按 HTML 渲染、进编辑自动 HTML→干净 Markdown |
