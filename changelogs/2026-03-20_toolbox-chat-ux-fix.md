| fix | prd-admin | 修复百宝箱聊天消息气泡分裂问题（时间戳和内容分开显示为两个气泡） |
| feat | prd-admin | 百宝箱聊天支持 Markdown 渲染（代码块、表格、列表、引用等） |
| fix | prd-api | 修复附件上传 application/octet-stream MIME 类型推断（根据文件扩展名自动识别） |
| fix | prd-admin | 百宝箱文件上传失败时显示 toast 错误提示（替代静默失败） |
| fix | prd-admin | 修复智能体编辑器不回填已有配置（欢迎语、引导问题、温度、知识库等） |
| fix | prd-admin | 智能体保存时传递所有配置字段（welcomeMessage/conversationStarters/temperature/knowledgeBaseIds/enableMemory） |
| fix | prd-admin | 错误消息使用红色样式 + AlertCircle 图标显示 |
| feat | prd-admin | 百宝箱聊天新增停止生成按钮（流式响应时显示 Stop 按钮替代 Send） |
| feat | prd-admin | 百宝箱助手消息新增一键复制按钮（hover 显示，复制后 2 秒绿色勾确认） |
| feat | prd-admin | 百宝箱错误消息新增重试按钮（重新发送上一条用户消息） |
| feat | prd-admin | 百宝箱助手消息新增重新生成按钮（hover 显示 RefreshCw，替换旧回复重新调用） |
| feat | prd-admin | 百宝箱对话导出为 Markdown 文件（含角色、时间戳、分隔线） |
| feat | prd-admin | 百宝箱新增清空当前会话按钮（确认后清空消息） |
| feat | prd-admin | 输入区显示字符计数 + 快捷键提示（Enter 发送/Shift+Enter 换行） |
| fix | prd-api | 百宝箱图片附件支持 Vision 多模态（image_url content parts + ModelTypes.Vision） |
| fix | prd-api | 多轮对话历史保留图片上下文（ChatHistoryMessage 新增 AttachmentIds，后端批量查询附件并构建 image_url 多模态消息） |
| fix | prd-admin | 切换会话时还原 attachmentIds（历史消息重新发送时能带上图片） |
| fix | prd-admin | 重新生成/重试时保留原消息附件（handleSend 支持 overrideAttachmentIds） |
| fix | prd-admin | 修复重新生成闭包问题（handleSend 接受 messagesSnapshot 避免 React 批量更新导致历史包含已删除消息） |
| feat | prd-admin | 代码块语法高亮（react-syntax-highlighter + oneDark 主题 + 语言标签 + 复制按钮） |
| feat | prd-admin | LaTeX 数学公式渲染（remark-math + rehype-katex） |
| fix | prd-admin | XSS 防护（rehype-sanitize 配合 rehype-raw 过滤危险 HTML 属性） |
| feat | prd-admin | 助手消息反馈按钮（👍👎 点赞/踩，高亮切换） |
| feat | prd-admin | 用户消息编辑功能（Pencil 图标触发，编辑后截断后续消息并重新发送） |
| fix | prd-api | 修复图片对话 APP_CALLER_INVALID 错误（新增 Vision AppCallerCode，Vision 请求使用独立的 ai-toolbox.orchestration::vision） |
| fix | prd-admin | 修复历史图片不显示（切换会话时批量获取附件 URL 并渲染缩略图） |
| fix | prd-admin | 发送消息立即显示助手占位（附件上传改为并行，上传期间显示进度提示，符合 2 秒反馈原则） |
