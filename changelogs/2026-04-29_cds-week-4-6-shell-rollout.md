| refactor | cds | BranchListPage / BranchDetailPage / BranchTopologyPage / ProjectSettingsPage / CdsSettingsPage 全部切到统一的 AppShell + TopBar + Workspace 共享布局；左侧导航条、顶部面包屑、刷新/返回按钮、内联统计样式不再各页各搞一套 |
| refactor | cds | 删除 5 个页面里重复的"自建 56px nav + cds-breadcrumb + cds-page-title 块"代码；改用 `<Crumb items=[...]>` 与 `<TopBar left={...} right={...} />` 显式声明 |
| refactor | cds | 统一移除每个页面顶部的"小图标按钮 / 项目设置 / 刷新"长按钮排，改成 ghost icon 按钮 + tooltip，避免次要操作压过主链路视觉权重 |
| refactor | cds | 项目设置 + CDS 系统设置的 TabsList 与内容区改用 `cds-surface-raised cds-hairline` 替代 `border border-border bg-card/75 shadow-sm` 灰底灰边堆叠 |
| refactor | cds | Toast 提示统一用 surface-raised + hairline 边框，与新视觉语言一致 |
