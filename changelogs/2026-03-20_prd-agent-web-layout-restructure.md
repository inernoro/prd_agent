| feat | prd-admin | PRD Agent 页面重构为 Desktop 风格布局（侧边栏 + 会话标题栏 + 主区域），取消原 3-Tab 设计 |
| feat | prd-admin | 新增 PrdAgentSidebar 组件：会话列表、知识库（文档列表）、缺陷管理入口，对标 Desktop Sidebar |
| feat | prd-admin | 新增 prdAgentStore 共享状态库，桥接 AiChatPage 与 Sidebar 的会话/角色状态 |
| feat | prd-admin | AiChatPage 新增 Desktop 风格会话标题栏（标题 + 角色切换 + 功能按钮） |
| refactor | prd-admin | AiChatPage 会话选择从内联下拉改为侧边栏驱动（CustomEvent 通信） |
| fix | prd-admin | PrdAgentSidebar 像素级对齐 Desktop Sidebar（字号/按钮尺寸/hover 状态/SVG 图标/追加资料按钮） |
| fix | prd-admin | AiChatPage 标题栏新增连接状态指示器（绿点 + 已连接）和"..."信息按钮，对标 Desktop ChatContainer |
