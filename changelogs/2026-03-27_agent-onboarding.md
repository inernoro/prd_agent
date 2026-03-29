| feat | doc | 新增 Agent 开发入门指南 (guide.agent-onboarding.md)，面向产品经理的 30 分钟全景阅读 |
| feat | .claude/skills | 新增 agent-guide 引导技能 (/help)，支持阶段式新手教程和跨会话进度跟踪 |
| feat | .agent-workspace | 新增 Agent 开发工作区目录，每个 Agent 独立文件夹管理进度 |
| feat | .claude/skills | 新增 scope-check 技能 (/scope-check)，提交前分支受控检查，检测越界修改 |
| feat | prd-api | 新增 transcript-agent 后端骨架（Controller/Models/权限/菜单/AppCaller/MongoDB） |
| feat | prd-admin | 新增 transcript-agent 前端页面（工作区/素材/转写/模板文案/导出） |
| fix | prd-admin | 修复登录跳转（hash URL 兼容 + returnUrl 回跳） |
| fix | prd-admin | 修复上传响应解析、JSON 双重序列化、res.ok→res.success 等前端问题 |
| refactor | prd-admin | 转录工作台 UI 重设计（三栏→导航式渐进深入） |
