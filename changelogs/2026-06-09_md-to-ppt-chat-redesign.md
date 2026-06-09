| feat | prd-admin | MD转PPT智能体页面重构为对话+预览双栏布局（大纲先行确认流程、左侧聊天面板、右侧 reveal.js iframe 实时预览） |
| feat | prd-api | 新增 POST /api/md-to-ppt/outline 大纲规划端点（JSON，非 SSE，支持附件/知识库上下文/历史对话） |
| fix | prd-admin | P1 安全漏洞：iframe sandbox 移除 allow-same-origin，注入内存存储 shim，消除 LLM 生成脚本访问主应用鉴权 Token 的风险 |
| feat | prd-admin | 新增知识库引用选择器（KbPicker）和大纲确认气泡（OutlineBubble）组件 |
| feat | prd-admin | 新增 "+" 菜单支持文件上传和知识库引用，对话历史通过 sessionStorage 持久化跨刷新恢复 |
| feat | prd-api | AppCallerRegistry 新增 md-to-ppt-agent.outline::chat 和 md-to-ppt-agent.chat-refine::chat 两个注册常量 |
