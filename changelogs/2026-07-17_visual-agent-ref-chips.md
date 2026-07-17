| fix | prd-admin | 视觉创作消息引用图片改为视觉chip显示,展示层剥离【引用图片】文字块/生图前缀/文件名,历史污染消息同样干净展示 |
| fix | prd-admin | 视觉创作发送消息不再回退存储模型层请求文本,display为空时以@imgN标记+清洗正文兜底 |
| fix | prd-api | 生图run缺少UserMessageContent时不再落库原始模型prompt,改为清洗兜底(剥前缀+引用块,引用以@imgN标记补回) |
| test | prd-admin | 新增visualMessageDisplay展示层清洗与chip标签清洗单测(17例) |
