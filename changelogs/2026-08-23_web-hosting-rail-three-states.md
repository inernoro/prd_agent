| fix | prd-admin | 卡片 hover 条 hover 时以整条宽度接管指针，盖死左下角批量勾选框——真人点不动（程序化 click 却能过）；容器改为恒 pointer-events-none，只有按钮自己可点，补真实指针契约守卫 |
| feat | prd-admin | 网页托管右栏补齐设计稿三态：未选中=站点上下文·最近动过 / 选中 1 个=选中的站点 / 选中多个=批量操作；批量操作从列表上方横条收进右栏（窄屏仍保留横条） |
| fix | prd-admin | 右栏「最近动过」改为取真正 updatedAt 最大的站点，不再是当前排序下的第一张卡 |
| fix | prd-admin | buildShareLedger 排序读真实时钟、结论句读注入时钟，两处判据不同源导致用例随日期漂红；now 统一注入 |
