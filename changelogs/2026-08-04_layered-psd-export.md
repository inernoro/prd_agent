| feat | prd-admin | 视觉创作支持将生成图片语义分层并导出 PSD |
| feat | prd-admin | 语义图层可持久化到画布 Frame，支持单层编辑、重复使用与免重算导出 PSD |
| fix | prd-admin | 约束图片快捷工具条在可见画布内，避免 AI 分层入口被右侧面板遮挡 |
| feat | prd-api | 新增 fal.ai Qwen Image Layered 网关转换器与配置模板 |
| feat | llmgw | 模型网关控制台支持图片分层转换器配置 |
| feat | llmgw | 支持一次录入 fal.ai Key 自动安装图片分层 Exchange、通用逻辑能力和上游供给 |
| refactor | prd-api | MAP 图片分层改为单向依赖 LLMGW 的 image-layering 公开能力，不再感知上游平台和模型 |
| fix | llmgw | 重排图片分层安装区与 Exchange 单列列表，修复宽屏双列信息拥挤和层级混乱 |
| fix | prd-admin | PSD 默认显示 AI 图层合成结果并将原图降为隐藏参考层 |
| ops | cds | 显式登记 LLMGW 控制台用户入口，适配路由与预览入口分离的新契约 |
| fix | prd-api | 修复分层模型配置触发生图尺寸守卫误报：该类模型输出继承输入画布、本就无尺寸可选，判据改为按用途收窄并对"声明不适用却配了尺寸"反向判红 |
| fix | prd-api | 修复 GatewayRawRequest 跨进程时新字段被静默丢弃：MAP 过线拷贝与 serving 重建拷贝各补一处，并加守卫测试对账两处初始化器与类型公开属性集合 |
