| feat | prd-admin | 知识库详情工具栏加「星系」直达按钮（Orbit 图标），3D 文档星系 1 下进入；「更多」菜单也补一项「3D 文档星系」 |
| fix | prd-admin | 修复知识库「更多」下拉点不开：PageHeader 根 overflow-hidden 裁掉了原地 absolute 菜单，改 createPortal 到 body + getBoundingClientRect 定位 + 外点关闭兼顾按钮与菜单两个 ref |
| fix | prd-admin | 文档星系返回按钮按来源决定目的地：从宇宙图进来回宇宙图，从知识库详情「星系」直达/深链进来回库详情（不默认回可能 403 的宇宙图）（Codex P2）|
| polish | prd-admin | 知识库列表顶栏不再用不透明 var(--bg-base) 整块铺底（用户反馈「黑黑的一坨」），改半透明 color-mix 55% + 加重磨砂模糊，保留 sticky 玻璃感但更轻 |
