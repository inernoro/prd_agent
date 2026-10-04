| fix | prd-admin | 修复首页参考图因 data URL 被消息标记过滤而静默退化为文生图的问题 |
| test | prd-admin | 增加参考图交接包在桌面端与手机端的真实数据回归测试 |
| fix | prd-api | 消除图片尺寸解析在 .NET 8 下的 Split 重载歧义，恢复正式构建 |
| rule | platform | 固化参考图结构化交接、模型目录权威与逻辑模型删除审计规则 |
| fix | prd-admin | 修复桌面与手机重试、多图和局部编辑链路丢参考图后静默降级的问题 |
| fix | prd-api | 新增参考图期望数量跨层契约，Controller 与 Worker 双重拒绝不完整图生图请求 |
| test | prd-api | 增加参考图数量契约及 image2、2.5 等逻辑模型通用引用审计矩阵 |
| refactor | platform | 删除已停用的 Cursor 规则镜像、同步脚本与宿主安装分支，收敛到 Claude 和通用 Agent 两套目录 |
| test | cds | 更新技能安装跨端契约，防止重新生成或分发 Cursor 目录 |
