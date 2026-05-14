| fix | cds | 分支抽屉「本分支运行模式」修复"继承默认显示发布版"问题：resolveEffectiveProfile 增加项目默认（Project.defaultDeployModes）回退层，分支级 override 缺失时优先继承项目设置而非 baseline；UI chip 区分「继承项目默认」「继承构建配置默认」「本分支覆盖」 |
| feat | cds | BranchEntry 新增 lastStoppedAt / lastStopReason / lastStopSource 字段，用户主动停止、调度器空闲降温/容量驱逐、远端执行器停止三类路径均写入；分支抽屉与详情页展示"上次停止时间 + 原因 + 来源"以解释"分支变灰"现象 |
| feat | cds | 项目环境变量待补全横幅新增「我知道了」按钮，弹窗提示去「项目设置 → 环境变量」补填，sessionStorage 按 pendingEnvKeys 指纹关闭，新增缺失变量时横幅自动复活 |
| feat | cds | 分支卡片标题行徽章从来源（Webhook/手动/待配置）切换为运行模式（发布版/源码/混合），与抽屉「本分支运行模式」视觉对齐；原来源徽章降级到正文 chip 行 |
