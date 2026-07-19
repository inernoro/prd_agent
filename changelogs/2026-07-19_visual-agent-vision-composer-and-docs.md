| fix | prd-admin | 视觉创作消息引用图片改为视觉chip显示,展示层剥离【引用图片】文字块/生图前缀/文件名,历史污染消息同样干净展示 |
| fix | prd-admin | 视觉创作发送消息不再回退存储模型层请求文本,display为空时以@imgN标记+清洗正文兜底 |
| fix | prd-api | 生图run缺少UserMessageContent时不再落库原始模型prompt,改为清洗兜底(剥前缀+引用块,引用以@imgN标记补回) |
| test | prd-admin | 新增visualMessageDisplay展示层清洗与chip标签清洗单测(17例) |
| fix | prd-api | 多图生图修复:通用Vision分支响应解析兼容message.images[]数组与多模态content数组,消除「Vision API 响应格式不支持」误报 |
| test | prd-api | 新增VisionResponseImageExtractionTests覆盖images[]/字符串content/多模态content数组/纯文本/空choices等全部响应形态 |
| fix | prd-admin | 视觉创作编辑器右上角本页教程入口在桌面端左移至对话面板左侧，不再遮挡面板头部控件 |
| docs | doc | 新增视觉创作画布与对话输入原理设计文档（迁移考古 SSOT）与优化清单计划（14 项 backlog） |
| fix | prd-admin | 视觉创作历史消息展示层：元数据 token 之后的生图英文前缀现在也会被剥离（Codex P2） |
| fix | prd-admin | 视觉创作用户气泡开头残留 ")" ——模型池名自带括号时 (@model:...) 剥离在首个右括号截断；三处解析正则改为容忍一层嵌套括号（展示清洗/标题清洗/模型徽标） |
| feat | prd-admin | 视觉创作输入框 chip 支持 Lovart 式复制粘贴：复制/剪切序列化为 [@image:#N:key:src] 混合文本，粘贴命中当前画布集合时还原就绪 chip，未命中保持纯文本 |
| fix | prd-admin | 引用行剥离收窄到【引用图片】块内：用户手写 "- @imgN: 指令" 普通列表行整行保留（Codex P2） |
| fix | prd-api | UserMessageContent 兜底清洗同步收窄：引用行只在【引用图片】块内剥离，集成方 prompt 里的用户手写 "- @imgN: 指令" 行整行保留（Codex P2） |
