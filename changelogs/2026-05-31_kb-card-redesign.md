| feat | prd-admin | 知识库列表卡片改版:多彩渐变图标(按库取色) + 文章迷你目录(序号+标题+标签+相对时间,露前3篇+「还有N篇」) + 浏览/点赞 meta + 右下角(相对修改时间+贡献者头像),移除底部「打开」蓝条,整卡可点 |
| feat | prd-api | 知识库列表预览接口 recentEntries 增加 tags 字段(每篇文章前几个标签),供卡片文章行展示 |
| feat | prd-admin | 知识库页头:视图切换(我的空间/收藏/点赞)上移到标题行,与作用域控件同排,移除独立第二行 |
| fix | prd-admin | 知识库卡片 RelativeTime 列表场景关闭每实例刷新定时器(refreshIntervalMs=0),避免大列表累积 N 个 setInterval |
| fix | cds | 教程04(及同源 fullstack-infra-smoke)init.sql 列名 name 改 label,与后端健康检查 INSERT/SELECT label 对齐,修复 /api/health 误报 MySQL down |
