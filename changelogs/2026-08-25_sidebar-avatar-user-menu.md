| feat | prd-admin | 侧栏底部移除「···」按钮，用户菜单改由点击头像打开；头像因此落到侧栏最底部（同时去掉尾部 1px 占位间距） |
| feat | prd-admin | 头像点击语义改为两段：菜单关着时点头像开用户菜单，菜单开着时再点一次头像才进「修改我的头像」；菜单头部加一行提示让这条交互可见 |
| refactor | prd-admin | 用户菜单改受控（modal={false}）：点击判定落在 pointerdown 并 preventDefault，绕开 Radix Trigger 自带的 toggle；展开态用户名按钮退回普通 toggle 按钮，一个 Root 只保留头像这一个锚点 |
| test | prd-admin | 新增 accountAvatarAction 判定源与守卫用例（4 例）：两段点击语义各一例，另加「AppShell 走唯一判定源」「头像是菜单触发器且侧栏不再有 MoreHorizontal」两条源码守卫，已跑红绿闭环 |
