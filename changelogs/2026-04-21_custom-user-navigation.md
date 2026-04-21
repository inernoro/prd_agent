| feat | prd-api | UserPreferences 新增 NavHidden 字段 + PUT /api/dashboard/user-preferences/nav-hidden 与 PUT /api/dashboard/user-preferences/nav-layout 端点（布局一次性保存，减少往返） |
| feat | prd-admin | 设置页"导航顺序"改版为横向双区拖拽 UI：上方"我的导航"长条 + 下方"可添加"候选池，支持拖拽重排、隐藏、添加分隔横杆（"---"哨兵），右上角"恢复如初"按钮清空自定义。分组横杆仅作视觉分隔，不绑定业务语义 |
| fix | prd-admin | 修复跨用户导航污染：logout 显式重置 navOrderStore + agentSwitcherStore 内存态，避免同一浏览器切换账号后旧用户布局残留 |
| refactor | prd-admin | navOrderStore 抽出 NAV_DIVIDER_KEY 常量与 reset 方法；AppShell 在存在自定义顺序时按"---"切段渲染，兜底追加新上线菜单防止"消失" |
| fix | prd-admin | 设置页首次进入已显示默认分隔横杆（currentOrder 默认在 NAV_GROUPS 切换处注入 NAV_DIVIDER_KEY），不再需要用户点击"恢复如初"才出现分段；"恢复如初"对未自定义过的用户视觉无变化 |
| feat | prd-admin | 设置页候选池从仅 menuCatalog 扩展到完整 Cmd+K 启动目录（Agent / 百宝箱 / 实用工具），按分组显示；AppShell 侧边栏同步支持 launcher id 形式的 navOrder token（agent:/toolbox:/utility:）回退解析，从候选池拖入的条目可正常渲染 |
