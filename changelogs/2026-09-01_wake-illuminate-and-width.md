| fix | prd-admin | 唤醒从「一道窄光带扫过」改为「幕从左上退到右下」，整张壁纸被逐渐点亮而不是闪一下 |
| fix | prd-admin | 修复幕的几何：inset 与 translate 的百分比基准不同，原参数让幕滑出画面，t=0 就漏出大半张图 |
| fix | prd-admin | 输入框宽高改为跟随视口 clamp，此前写死 880px 在宽屏上只占 45%，比下面的项目栅格还窄 |
| test | prd-admin | 新增几何参数守卫与 scripts/wake-veil-probe.mjs 像素探针（t=0 全盖住 / t=末全露出 / 中途有前沿） |
