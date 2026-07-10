| fix | cds | 验收报告页文件夹树随项目筛选联动，修复全局页切项目后仍渲染其它项目文件夹的跨项目串扰；「移动到文件夹」菜单只列与报告同项目的文件夹 |
| feat | cds | 报告列表顶栏重排：最左项目筛选、右侧筛选、最右「全部折叠/展开」一键按钮，移除「共 N 份报告」计数文案 |
| feat | skills | 验收归档 archive_report.py 新增 --folder-path 参数，文件夹归类三级解析（--folder-path > config.cdsFolder > --module 自动归类），验收报告默认按模块进文件夹、不再散落项目根 |
