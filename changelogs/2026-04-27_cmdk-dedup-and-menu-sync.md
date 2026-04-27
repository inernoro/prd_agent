| fix | prd-admin | 「/executive」短标签从「执行」改为「统计」（页面实际是总裁面板/统计看板，icon 也是柱状图） |
| fix | prd-admin | Cmd+K 命令面板（AgentSwitcher）智能体/百宝箱去重：launcherCatalog 在 dedup 阶段加 route 维度，buildAgentItems 早于 buildToolboxItems，相同 route 的视觉/文学/缺陷/视频不再在两个分组重复 |
| feat | prd-admin | Cmd+K 命令面板新增「其他菜单」分组：launcherCatalog 接收可选 menuCatalog，把 launcher 没注册的后端菜单项（海报/技能/执行等）作为 group='menu' 并入；同 route 用 menu.appKey 改写 id 兼容历史 navOrder |
