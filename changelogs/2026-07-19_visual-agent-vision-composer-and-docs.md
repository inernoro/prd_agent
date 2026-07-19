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
| fix | prd-admin | 视觉创作重试内容变异根修：GEN_DONE/GEN_ERROR 的 prompt 一律存用户 display 原文（不再存模型层 reqText/英文澄清稿），重试不再叠引用块、气泡不再变异 |
| feat | prd-admin | 视觉创作用户消息新增「复制」：图片引用序列化为 [@image:#N:key:src] token 文本（与输入框复制粘贴同 SSOT），粘回输入框即还原 chip |
| fix | prd-api | stub-vision 补出图闭环：vision 模式非流式响应带 message.images[]（优先以请求内联图为底+提示词水印），dev/灰度多图生图不再必然「无图片数据」失败 |
| docs | doc | 视觉创作优化清单新增「根因分析」章：双层文本未分离/重试以渲染文本为源/stub 缺 vision 闭环 三大结构性根因与治法 |
| fix | prd-admin | 用户消息复制改走 copyToClipboard SSOT 工具（非安全上下文 execCommand 兜底，失败不假成功） |
| polish | prd-admin | 用户消息「复制」升级为明显按钮态（图标 + 边框 chip，token 双皮肤），治「认不出是按钮」 |
