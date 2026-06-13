| fix | prd-admin | 修复项目知识库预览全屏不展开（DocBrowser 阅读区改用 createPortal 全屏覆盖层，替代原生 Fullscreen API） |
| feat | prd-api | 项目管理智能体新增全局知识库只读端点（knowledge/overview + entries + entry content，仅 pm-agent.dashboard，绕过项目成员鉴权） |
| feat | prd-admin | 项目管理智能体工作台新增「全局知识库」菜单：管理员只读洞察全部项目知识库，多维筛选 + 默认展开分组 + DocBrowser 正文预览 |
| fix | prd-admin | 修复知识库全屏覆盖层背景误用半透明 token 导致整页穿透（改用不透明 --bg-base）；修复上传 PDF 等文件后标题回退显示文件名（放开提取正文类型参与正文标题推导，仅排除 HTML/XML 源码） |
