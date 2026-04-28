| feat | prd-admin | 应用搜索框扩大匹配范围 — 现在除了 appName / appCode 外，也会扫描每个 appCallerKey 和 displayName，让用户能直接搜 `visual-agent.image.text2img` 这类完整 code 定位到对应分组 |
| fix | prd-admin | 补全 appCaller 中文显示名映射表 — 新增 channel-adapter / system / transcript-agent / review-agent / pr-review / document-store / emergence-explorer / skill-agent / prd-agent 的中文标签。同步在表头加 TODO 注释，标记其违反 frontend-architecture.md SSOT 原则的架构债（同样问题存在于 getFeatureDisplayName） |
| fix | prd-api | AppCallerRegistry.cs 补全 System 和 SkillAgent partial class 的 `AppName` 常量（其他 partial class 都有，只有这两个漏了） |
| feat | prd-admin | 模型池管理页左侧栏顶部加 ModelTypeFilterBar — 用户可按 13 种模型类型 (chat/intent/vision/generation/...) 快速过滤池列表 |
| refactor | prd-admin | 模型池管理页右侧操作区重构 — 删除「预测调度」按钮（用户认为多余），新增显眼的「+ 添加模型」主按钮直接跳过编辑表单弹模型 picker，confirm 后直接 PATCH 池。复制/编辑/删除保持小图标但置于主按钮右侧。删除 PoolPredictionDialog / handlePredict / Radar / predictNextDispatch 在本页的所有引用 |
