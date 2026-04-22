| fix | prd-api | 放宽 5 处所有权闸门 — GetItem/RunItem/CreateSession/TriggerWorkflow/DirectChat 允许自己创建的或 IsPublic=true 的条目（抽取 FindVisibleItemAsync helper）；编辑/删除/发布依然严格仅限创建者。用户公开发布后，别人从此能真正运行原版而不是被迫 Fork |
| fix | prd-api | 新增 EnrichCreatorInfoAsync helper — GetItem / ListItems / ListPublicItems 返回前按 Users 集合批量回填 CreatedByName / CreatedByAvatarFileName（只填缺失字段）。老数据从此不再显示"匿名用户"，作者名和头像正常可见 |
| fix | prd-admin | 点别人公开的卡片不再偷偷创建副本 — ToolCard/ToolDetail 都把 marketplace 卡片点击改为打开详情抽屉；「创建副本」必须在详情页或右下角按钮显式点击并二次 confirm 才会触发，彻底消除"反复误复制"的反人类流程 |
| fix | prd-admin | BUILTIN 官方工具误挂「施工中」徽章 — isOwnCustomCard / isCustom 两处判定收紧，硬排除 type='builtin'，不再用 createdByName 兜底（因为 BUILTIN普通版硬编码 createdByName='官方'，之前所有用户都看到「施工中」标记） |
| fix | prd-admin | BUILTIN 官方工具用 MAP 品牌徽标代替首字母圆形块 — 之前容易被误认为"某个用户的头像"；同时 authorAvatarUrl 对 BUILTIN 强制返回 null，杜绝意外展示当前登录用户头像 |
| fix | prd-admin | 详情顶部「来自社区」chip 改为显示真实作者名 `由 {name} 发布`；meta 信息行对 isOthersPublic 强制渲染作者字段（即使没有 createdByName 也显示 `用户 #xxxxxx`）；卡片上"匿名用户"fallback 同步替换为 `用户 #xxxxxx` |
| feat | prd-admin | 百宝箱首页从 5 tab 改为 3 权属筛选（全部 / 我的 / 别人的）+ 收藏；loadItems 一次性合并 BUILTIN + /items + /marketplace，按 ownership 字段区分；公开发布的智能体立即出现在所有用户的「全部 / 别人的」里 |
| feat | prd-admin | 别人 7 天内发布的公开条目卡片左上角加红底脉动 NEW 徽章（基于 createdAt 计算，窗口期常量 NEW_BADGE_WINDOW_MS = 7 天） |
| refactor | prd-admin | ToolCard/ToolDetail 4 处 window.confirm 与 confirm 全部替换为 systemDialog.confirm（含 tone='danger'/confirmText/cancelText）；与项目统一的模态风格一致，不再出现浏览器原生弹框 |
| chore | prd-admin | ToolboxItem 类型声明补上 createdByUserId（与后端 camelCase 对齐）和 ownership 字段；旧的 createdBy 保留仅为兼容历史调用点 |
| refactor | prd-admin | 百宝箱卡片从 3:4 竖板改 4:3 横板，网格最小宽度 180→240px，对齐首页 AgentGrid 视觉语言；删除"定制版"徽章；BUILTIN 卡片底部不再显示 MAP/官方/作者等特殊标记，仅保留使用次数 + 收藏星，保持"默认智能体样子" |
