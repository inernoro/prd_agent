| fix | prd-admin | 知识库访客记录抽屉：登录访客渲染真实头像（原永远显示通用占位图标）、暗色面板改不透明避免页面头部穿透、补 createPortal + ESC 关闭、停留时长为 0（leave 信标未送达）显示「—」而非误导性「< 1 秒」 |
| fix | prd-admin | 知识库访客记录列表行紧凑化：缩小行内边距/头像、时间+停留靠右填充原本空荡的右侧 |
| fix | prd-admin | 修复 DocBrowser 文档列表前导图标大小不一：图标外包 flex-shrink-0 容器，避免长标题时 SVG 被 flexbox 压缩 |
| fix | prd-admin | 移除 DocBrowser 订阅条目的状态小圆点（出错红点等），不再为单个小点占用整行徽章行 |
