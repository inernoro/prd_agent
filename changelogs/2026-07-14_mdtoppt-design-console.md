| fix | prd-api | 修复 MD 转 PPT openai-compatible 运行配置误走 CDS Agent 会话导致正式环境整本降级的问题 |
| fix | prd-api | 将生产默认 claude-sdk/anthropic 运行配置纳入 LLM Gateway 直出路径，CDS Agent 仅保留兼容模式 |
| polish | prd-api | 强化 MD 转 PPT 逐页生成的风格一致性、用户创意转译和 HTML 片段可运行校验 |
| polish | prd-admin | 优化 MD 转 PPT 控制台运行路径、HTML 校验和创意约束的首屏状态展示 |
| fix | prd-admin | 修复 MD 转 PPT 移动端底部导航遮挡输入区和发送按钮的问题 |
| polish | prd-admin | 将 MD 转 PPT 移动端改为单列精致创作工作台，避免桌面双栏压缩到手机 |
| feat | prd-api | 新增知识库条目一键生成海报、教程、文案 HTML 并发布到网页托管的接口 |
| feat | prd-admin | 知识详情页新增一键创作并自动发布到网页托管的操作入口 |
| polish | prd-api | MD 转 PPT 并行逐页生成新增 page_start 诊断事件，首批页面返回前也能看到任务进展 |
| polish | prd-admin | MD 转 PPT 移动端和聊天气泡展示正在生成的页码、完成页数和当前阶段 |
| polish | prd-api | MD 转 PPT 生成提示词接入 GitHub html-ppt 官方技能契约，强化模板化布局、主题 token、data-title 与隐藏 notes 规则 |
| fix | prd-api | 修复知识库创意发布兜底 HTML 模板的 C# raw string 花括号编译错误 |
| fix | prd-api | 修复 MD 转 PPT 锚定模式误拒绝官方 html-ppt 的 section slide 根节点导致整本降级的问题 |
