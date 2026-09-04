| fix | prd-admin | 视觉创作首页去掉重复的返回钮，留下的那颗补上无历史时的兜底 |
| fix | prd-admin | 换分辨率档不再把 16:9 悄悄改成 1:1：比例判定先认后端目录再退静态表 |
| refactor | prd-admin | 「尺寸→比例」判定收敛成 resolveAspectRatio 一份，去掉散落的第三份拷贝 |
| test | prd-admin | 补两组守卫：列表页只有一颗返回钮、比例判定目录优先 |
| fix | prd-admin | 修正教程 pill 守卫的取值口径（锚在 pill 自己身上，不锚在渲染条件上） |
