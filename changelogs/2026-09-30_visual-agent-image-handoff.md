| fix | prd-admin | 修复首页参考图因 data URL 被消息标记过滤而静默退化为文生图的问题 |
| test | prd-admin | 增加参考图交接包在桌面端与手机端的真实数据回归测试 |
| fix | prd-api | 消除图片尺寸解析在 .NET 8 下的 Split 重载歧义，恢复正式构建 |
| rule | platform | 固化参考图结构化交接、模型目录权威与逻辑模型删除审计规则 |
| fix | prd-admin | 修复桌面与手机重试、多图和局部编辑链路丢参考图后静默降级的问题 |
| fix | prd-api | 新增参考图期望数量跨层契约，Controller 与 Worker 双重拒绝不完整图生图请求 |
| test | prd-api | 使用虚构未来模型验证逻辑模型同步、默认失效与引用审计不依赖具体型号 |
| refactor | platform | 删除已停用的 Cursor 规则镜像、同步脚本与宿主安装分支，收敛到 Claude 和通用 Agent 两套目录 |
| test | cds | 更新技能安装跨端契约，防止重新生成或分发 Cursor 目录 |
| docs | visual-agent | 记录 image2.5 正式上游单线路超时的验收证据与恢复条件 |
| fix | visual-agent | 将模型选择 ID 归一与参考图预期数量升级为桌面端、手机端和后端入口的强契约 |
| rule | platform | 禁止通用模型策略按产品型号写分支，并要求用未配置的未来模型做回归验收 |
| test | visual-agent | 将参考图数量强契约同步到稳定冒烟，并永久覆盖缺失声明、不一致声明与单图多图真实调用 |
| fix | prd-api | 生图任务详情回传参考图期望数量，支持前端与验收直接核对图生图契约 |
