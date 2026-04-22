| fix | prd-api | 放宽 5 处所有权闸门 — GetItem/RunItem/CreateSession/TriggerWorkflow/DirectChat 允许自己创建的或 IsPublic=true 的条目（抽取 FindVisibleItemAsync helper）；编辑/删除/发布依然严格仅限创建者。用户公开发布后，别人从此能真正运行原版而不是被迫 Fork |
| fix | prd-admin | 点别人公开的卡片不再偷偷创建副本 — ToolCard/ToolDetail 都把 marketplace 卡片点击改为打开详情抽屉；「创建副本」必须在详情页或右下角按钮显式点击并二次 confirm 才会触发，彻底消除"反复误复制"的反人类流程 |
| feat | prd-admin | 百宝箱首页从 5 tab 改为 3 权属筛选（全部 / 我的 / 别人的）+ 收藏；loadItems 一次性合并 BUILTIN + /items + /marketplace，按 ownership 字段区分；公开发布的智能体立即出现在所有用户的「全部 / 别人的」里 |
| feat | prd-admin | 别人 7 天内发布的公开条目卡片左上角加红底脉动 NEW 徽章（基于 createdAt 计算，窗口期常量 NEW_BADGE_WINDOW_MS = 7 天）；详情抽屉顶部新增「来自社区」蓝色 chip，带解释 tooltip |
| chore | prd-admin | ToolboxItem 类型声明补上 createdByUserId（与后端 camelCase 对齐）和 ownership 字段；旧的 createdBy 保留仅为兼容历史调用点 |
