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
