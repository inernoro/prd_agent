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
