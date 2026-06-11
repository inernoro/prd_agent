| feat | prd-admin | 项目管理智能体全屏改版：两层信息架构（工作台层左侧一级导航 + 项目层独立全屏路由，项目内 9 大模块迁移到项目层左侧导航，URL 持久化） |
| feat | prd-admin | 项目管理智能体新增首页 AI 工作台：70% 跨项目 AI 助手（SSE 流式 + 对话创建项目/目标/里程碑/任务）+ 30% 我的待办 / 可配置便捷操作 |
| feat | prd-admin | 项目管理智能体新增一级「报表」页：跨项目执行数据（生命周期/任务/里程碑/风险四区，纯 CSS 可视化） |
| feat | prd-api | PmAgentController 新增首页工作台端点：POST /api/pm/assistant/ask（SSE 动作协议）、GET /api/pm/my-todos、GET /api/pm/reports/summary、便捷操作偏好读写；AppCallerRegistry 注册 pm-agent.assistant::chat |
| refactor | prd-admin | 抽取 AgentFullscreenLayout 与 agent-cards.css 为跨智能体共享件（product-agent 原文件转发兼容），项目卡片对齐 pa-card 动效（蓝色强调） |
| polish | prd-admin | 项目头部精简：AI 健康诊断 / AI 结案报告 / 结案评价收进「更多操作」下拉，层次更清晰 |
