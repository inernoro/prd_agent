| polish | prd-api | 强化 MD 转 PPT 页级生成审美闸门，拒绝泛化标题和纯 bullet 低级版式，并升级失败兜底页为结构化设计块 |
| fix | prd-api | 修复 MD 转 PPT 大纲页数漂移，后端识别显式页数并裁剪模型多输出页面 |
| polish | prd-api | 控制台/操作面板类 PPT 自动避开海报书法模板，强制使用 SaaS dashboard 结构约束 |
| fix | prd-api | 增加控制台视觉失配闸门，模型生成书法/海报风时自动改用结构化 dashboard 兜底页 |
| fix | prd-api | 控制台/操作面板类 PPT 页级生成改为确定性 dashboard 渲染，避免模型把面板需求画成终端海报 |
| fix | prd-admin | MD 转 PPT 前端优先识别用户显式页数，避免长提示词被估算成更多页 |
| fix | prd-admin | 修复 MD 转 PPT 控制台移动端和浮层硬编码深色背景，避免浅色主题下出现暗块并通过双皮肤棘轮 |
| test | prd-api | 增加 MD 转 PPT HTML 质量闸门和兜底页结构回归测试 |
| test | prd-admin | 增加 MD 转 PPT 显式页数解析回归测试 |
