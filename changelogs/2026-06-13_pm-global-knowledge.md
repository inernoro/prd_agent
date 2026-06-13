| fix | prd-admin | 修复项目知识库预览全屏不展开（DocBrowser 阅读区改用 createPortal 全屏覆盖层，替代原生 Fullscreen API） |
| feat | prd-api | 项目管理智能体新增全局知识库只读端点（knowledge/overview + entries + entry content，仅 pm-agent.dashboard，绕过项目成员鉴权） |
| feat | prd-admin | 项目管理智能体工作台新增「全局知识库」菜单：管理员只读洞察全部项目知识库，多维筛选 + 默认展开分组 + DocBrowser 正文预览 |
| fix | prd-admin | 修复知识库全屏覆盖层背景误用半透明 token 导致整页穿透（改用不透明 --bg-base）；修复上传 PDF 等文件后标题回退显示文件名（放开提取正文类型参与正文标题推导，仅排除 HTML/XML 源码） |
| refactor | prd-admin | 全局知识库改为列表→详情两段式（列表全宽、点文档进该项目全宽 DocBrowser），解决多列嵌套挤压正文；Agent 全屏左导航支持收起/展开；DocBrowser 阅读区右侧本页章节/批注栏支持收起 |
| fix | prd-admin | 修复全局知识库详情阅读区高度截断（DocBrowser wrapper 补 flex flex-col 使 flex-1 生效）；列表改扁平表格行+服务端分页（应对文档多）+ 新增项目筛选；去除"只读/掌控全局"等冗余文案；DocBrowser「+」新建按钮仅在有写操作时显示（只读态不再露占位项） |
