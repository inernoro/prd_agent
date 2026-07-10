| fix | cds | 验收报告页文件夹树随项目筛选联动，修复全局页切项目后仍渲染其它项目文件夹的跨项目串扰；「移动到文件夹」菜单只列与报告同项目的文件夹 |
| feat | cds | 报告列表顶栏重排：最左项目筛选、右侧筛选、最右「全部折叠/展开」一键按钮，移除「共 N 份报告」计数文案 |
| feat | skills | 验收归档 archive_report.py 新增 --folder-path 参数，文件夹归类三级解析（--folder-path > config.cdsFolder > --module 自动归类），验收报告默认按模块进文件夹、不再散落项目根 |
| feat | cds | 验收报告列表新增标题搜索框（搜索时平铺命中项）与「30 天前」系统视图（给巡检/日报类报告批量清理入口） |
| feat | cds | 「全部项目」视图报告树按项目一级分组（CDS 自身 + 各项目各成一组，可折叠），全部折叠/展开按钮同时作用于分组行 |
| polish | cds | 报告与文件夹删除确认从原生 window.confirm 统一为 Dialog 风格 |
| rule | skills | 每日验收 SOP 固化归档必须带 --folder-path「每日验收/YYYY-MM」按月分桶；新增 doc/debt.cds.reports.md 记录存量迁移/保留策略/批量操作等剩余债务 |
