| fix | cds | 调整预览分支静态资源缓存策略，避免最新提交页脚与旧前端 chunk 混用 |
| fix | prd-admin | 为生产静态服务补充资源缓存配置，避免预览页继续使用旧构建 chunk |
| fix | prd-admin | 前端构建产物文件名加入构建 ID，避免同名 chunk 被浏览器或边缘缓存复用 |
| fix | prd-admin | 远端构建显式注入构建 ID，避免无 git 环境下退回固定资源名 |
| feat | prd-api | 为 CDS Agent 会话新增消息列表 API，支持对话页恢复用户与 Agent 消息 |
| feat | prd-admin | CDS Agent 独立页新增对话 transcript 区，区分多轮消息与事件时间线 |
| feat | prd-api | 新增远程仓库 PR 创建工具，允许 CDS Agent 在审批后提交分支并创建 GitHub PR |
| fix | prd-admin | CDS Agent 会话按钮按状态显示启动、重试和继续，避免失败会话直接发送到旧 runtime |
