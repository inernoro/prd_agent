| fix | prd-admin | 修复视觉创作首页整页刷新时输入框塌成窄条：JSX spread 覆盖 className 导致包裹层丢掉 w-full |
| fix | prd-admin | 输入框宽度回到原来的 880：先前误把塌陷当成宽度值太小，两轮越改越宽 |
| test | prd-admin | 唤醒守卫补「rise() 的 className 不许被覆盖」，并修正延迟正则漏匹配带第二参数的调用 |
| test | prd-admin | 补守卫：输入台与预设行必须同宽且只有一个宽度值 |
