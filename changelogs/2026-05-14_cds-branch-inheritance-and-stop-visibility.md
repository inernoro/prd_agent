| fix | cds | 「项目默认运行模式」语义明确为"仅建分支时拷贝一次"（保留旧 UI 承诺「不改已有分支」）：applyProjectDefaultDeployModes 建分支时把项目默认写进 branch.profileOverrides，resolveEffectiveProfile 运行期只认分支 override + baseline，不做实时回退。原方案的实时回退层因会回溯改已有分支、与 UI/类型注释承诺矛盾（Codex P1）按用户决策回退 |
| feat | cds | BranchEntry 新增 lastStoppedAt / lastStopReason / lastStopSource 字段，用户主动停止、调度器空闲降温/容量驱逐、远端执行器停止三类路径均写入；分支抽屉与详情页展示"上次停止时间 + 原因 + 来源"以解释"分支变灰"现象 |
| feat | cds | 项目环境变量待补全横幅新增「我知道了」按钮，弹窗提示去「项目设置 → 环境变量」补填，sessionStorage 按 pendingEnvKeys 指纹关闭，新增缺失变量时横幅自动复活 |
| feat | cds | 分支卡片标题行徽章从来源（Webhook/手动/待配置）切换为运行模式（发布版/源码/混合），与抽屉「本分支运行模式」视觉对齐；原来源徽章降级到正文 chip 行 |
