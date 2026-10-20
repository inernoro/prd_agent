| feat | design-runtime | 为网页与网页 PPT 接入统一 OpenDesign 多轮执行、冻结输入、进度恢复和浏览器质量闭环 |
| feat | prd-api | 统一网页与网页 PPT 的设计任务、工作区、多文件产物、编辑、发布和失败诊断合同 |
| feat | prd-admin | 统一网页生成、修改与网页 PPT 的 OpenDesign 交互、预览、恢复及移动端入口 |
| fix | llmgw | 补齐 Responses 用量末帧、推理与缓存 token 计费语义，并明确实际与估算金额标签 |
| test | platform | 增加生成、编辑、恢复、质量门、多文件产物、计费和移动端行为的代表性回归 |
| fix | design-runtime | 固定可获得的 Alpine Chromium 版本，并在镜像构建时以降权用户验证桌面与移动双视口 |
| fix | design-runtime | 浏览器质量门以当前演示页作为主内容检测对象，避免无 main 标签的 Reveal 成品被误拒，同时继续拦截真实移动端小字与固定控件遮挡 |
| fix | prd-api | 持久化并输出 OpenDesign 演示稿真实阶段、预览与短期网关累计调用次数 |
| fix | prd-admin | 生成中展示真实演示稿初稿，区分页数与总进度并阻止未通过质量检查的草稿发布 |
| fix | prd-admin | 修复手机窄屏下演示稿精修建议挤出下载与发布操作的问题 |
| fix | design-runtime | 修复 SemVer 次版本标签被数量事实门误判为次数声明的问题 |
| feat | prd-api | 冻结网页 PPT 附件与知识来源，按资料容量自动扩展页数并在质量检查前物化完整来源 |
| feat | prd-admin | 分离网页 PPT 用户要求与附件资料传输，保留显式页数并由服务端决定自动页数 |
| test | design-runtime | 覆盖来源槽完整性、手动编辑覆盖和多文件工作区的正反合同 |
| fix | design-runtime | 将演示稿来源槽缺失或重复接入有界质量修复并保留脱敏终态诊断 |
| feat | llmgw | 为单次受权演示任务增加物理发送前原子额度预占、分档估算、未知用量保留和显式关闭合同 |
| feat | prd-api | 将新大纲按冻结来源认领任务额度并让转换与手动保存继承同一预算作用域 |
| test | platform | 覆盖任务额度不足零发送、并发共享、路由收紧、长上下文分档、重试、关闭与未绑定业务兼容 |
| fix | prd-api | 任务额度按冻结来源稳定指纹认领并贯穿转换与手动保存，同时保留 catalog、bound 与编辑 overlay 文档哈希完整性校验 |
| ci | platform | 固定服务端测试兼容 runner，并回执 Mongo 8.0 与内核版本，保留完整 sln 和 xUnit 门禁 |
| fix | design-runtime | 区分来源中的命名空间状态标签与真正未完成占位符，并在浏览器质量门拒绝挤入装饰槽的不可读冻结正文 |
| fix | design-runtime | 由冻结来源计划预置非最终演示稿内容骨架，再交由 OpenDesign 原位设计并保留全部质量门 |
| fix | prd-admin | 在网页 PPT 生成期间展示 OpenDesign 已产出的只读初稿，并明确标注尚未通过质量检查 |
