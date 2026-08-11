| fix | prd-admin | 修复浅色主题下 Toast 深底深字不可读：底层改走新增的 --toast-bg-base 主题 token（暗/浅/素色三处双写），不再写死 rgba(8,10,16,0.82) |
| fix | prd-admin | 提高 Toast 底层不透明度（0.82 → 0.94/0.97），修复下层工具栏文字透过提示条的穿透问题 |
| test | prd-admin | 双皮肤硬编码棘轮补三处判据缺口：扫描范围加 .ts（此前只扫 .tsx，导致配色 SSOT glassStyles.ts 从未被扫过）、新增「深色 rgba 当背景」计数、新增 Toast 底层双写接线守卫 |
