| fix | prd-admin | 视觉创作预设行 MAP Pro 接上线，点击清空输入回到自由描述；选完预设把光标送进输入框 |
| polish | prd-admin | 顶栏「创作」从只有一项的分段控件降级为纯标签 |
| polish | prd-admin | 撤掉左侧浮动工具栏（新建项目的第三个入口），新建文件夹挪进最近项目标题行并带文字 |
| refactor | prd-admin | 删除 DarkroomPlate 与 LatentField 两层程序美术，背景只留真图 + 压暗罩 + 一层非重复渐晕 |
| polish | prd-admin | 输入框 820x180 放大到 880x约250，参考图从 30px chip 改为落在打字区内的 56px 缩略图，空态给虚线拖放槽 |
| polish | prd-admin | 背景面板缩略图改两列并显示名字与说明，不再只挂在原生 title 里 |
| fix | prd-admin | 没有封面的项目卡给项目名首字 + 「还没有图」，不再是与加载失败同形的纯色空框 |
| test | prd-admin | 新增死控件守卫（预设格全可点 / 不摆单项分段控件 / 入口不重复 / 空态可辨），背景守卫改为禁止重复图案 |
| fix | prd-admin | 守卫的剥注释正则钉住行首，修复 accept="image/*" 把通配符当注释开头吞掉五千余字符导致判据对空串断言 |
