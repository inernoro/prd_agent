| feat | prd-admin | ShareDock 投放面板上传区改为 1:1 方形，支持「点击选择 / 拖拽」两种上传方式 |
| feat | prd-admin | 网页托管：拖入或点击上传文件后，ShareDock 内联二选一「无密码分享 / 有密码分享」，点选后才创建分享并自动复制链接（有密码自动生成6位）+ 展示访问密码，无需再开上传弹窗 |
| feat | prd-admin | 网页托管：已分享站点在卡片/列表名字前加「已分享」琥珀标签且名字变琥珀黄；分享按钮转为「取消分享」（卡片走 inline 轻确认，只撤该站点单站点分享） |
| feat | prd-admin | ShareDock 投放槽新增「读心」能力：拖已分享站点到分享槽变「取消分享」、拖已公开站点到公开槽变「取消公开」 |
| fix | prd-admin | ShareDock 上传区方框在面板内水平居中（原 aspectRatio + maxHeight 致方框靠左） |
| fix | prd-admin | ShareDock 面板收窄（288→236）、上传区限高 168px、底色加实，修正「太大太透明」 |
| feat | prd-admin | 网页托管右上角新增「按时间 / 按文件夹」分组方式（参考文学创作），与排序并存互不冲突，分节标题展示时间桶（今天/昨天/M月D日）或文件夹名；选择经 sessionStorage 持久化 |
