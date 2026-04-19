| feat | prd-admin | Cmd/Ctrl+K 命令面板重构：从只能切 5 个 Agent 升级为统一命令面板，收录 Agent / 百宝箱 / 实用工具，支持搜索、分组（置顶/最近/Agent/百宝箱/实用工具）、键盘导航、点击星标置顶 |
| feat | prd-admin | 新增「设置 → 我的空间」页：私人使用数据看板，展示置顶工具、最近使用、常用工具 Top 10（按启动次数排序），支持一键取消置顶 / 清空最近 / 重置统计 |
| feat | prd-admin | 用户下拉菜单新增「我的空间」入口，快速跳转到 /settings?tab=user-space |
| refactor | prd-admin | 新增 lib/launcherCatalog.ts 作为 Agent + 百宝箱 + 实用工具的统一目录（命令面板与我的空间共享），按权限自动过滤 |
| refactor | prd-admin | agentSwitcherStore 扩展：recentVisits 新增 id/icon 字段 + 新增 usageCounts / pinnedIds，版本迁移至 v2 兼容老数据 |
| refactor | prd-admin | 命令面板卡片改为紧凑方形（5 列网格，高度 96px，2 行描述），面板最大宽度 1080px，键盘上下移动按列数 5 对齐 |
| fix | prd-admin | 命令面板卡片取消固定高度与截断：描述文字自然换行，卡片按内容增高；同行卡片通过 grid items-stretch 对齐 |
