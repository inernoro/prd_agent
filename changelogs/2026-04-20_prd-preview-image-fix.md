| fix | prd-desktop | 修复 PRD 预览中 Word 转换产生的 base64 图片不显示的问题（react-markdown 默认 urlTransform 会剥离 data:image 协议）；空 src 与加载失败时降级为可见占位提示 |
| feat | prd-api | 新增 PATCH /api/v1/documents/{id}/title 重命名接口（复用 groupId/sessionId 双通道鉴权） |
| feat | prd-desktop | 知识库文档支持重命名：侧边栏主文档/资料文档右键触发 prompt 改名，知识库管理页资料行新增铅笔按钮 + 双击改名 |
