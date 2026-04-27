| fix | prd-admin | 视频 Agent「+ 创作」下拉菜单 portal 到 body，避免被父 GlassCard 层级遮挡，第二项「大模型直出」不再被下方面板盖住 |
| feat | prd-admin | 高级创作弹窗改为零摩擦上传：拖拽/点击上传 .md/.txt 文档，「或粘贴文本」可选回退；移除手填标题输入框（标题由 AI 自动从内容取） |
| feat | prd-admin | 高级创作弹窗风格改为 8 个预设胶囊（电影级光影/3D 卡通/写实纪录片/像素风/水墨国风/赛博朋克/极简插画/复古胶片）+ 「AI 自动选」默认项，禁止用户瞎填 |
| feat | prd-api | storyboard 拆分镜 LLM prompt 改为返回 `{title, scenes}` 包装对象，AI 自动给整段视频取中文标题（≤14 字）写回 ArticleTitle；解析器兼容旧的纯数组格式 |
