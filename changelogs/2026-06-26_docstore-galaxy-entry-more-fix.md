| feat | prd-admin | 知识库详情工具栏加「星系」直达按钮（Orbit 图标），3D 文档星系 1 下进入；「更多」菜单也补一项「3D 文档星系」 |
| fix | prd-admin | 修复知识库「更多」下拉点不开：PageHeader 根 overflow-hidden 裁掉了原地 absolute 菜单，改 createPortal 到 body + getBoundingClientRect 定位 + 外点关闭兼顾按钮与菜单两个 ref |
