# report.tutorial-coverage

| 字段 | 内容 |
|---|---|
| 主题 | 页面教程(小技巧)全量路由覆盖审计 |
| 日期 | 2026-06-04 |
| 范围 | prd-admin 全部 43 条用户路由 vs 教程入口(pill) + `data-tour-id` 锚点 + `*-page-guide` seed |
| 关联 | `.claude/rules/onboarding-tips.md`、`DailyTipsController.BuildDefaultTips` |

---

## 结论

- 共 43 条路由。**入口机制**:`PageHeader`/`TabBar` 在有 `title`/`items`/`actions` 时自动注入 `<TipsEntryButton/>`,pill 在「本页无教程」时自隐。⇒ 凡有教程的路由都已自动出现 pill,**诉求 #1(右上角是否含教程)对全部 14 个教程路由已满足**。
- 14 条 `*-page-guide` seed 覆盖核心页;周报(`/report-agent`)按用户要求不做本页教程(有 `weekly-report-first` 快捷任务)。

## 分类

| 类 | 页面 | 现状 | 处置 |
|----|------|------|------|
| A 已完整 | visual-agent、literary-agent(+编辑器)、marketplace、library、showcase、pr-review、emergence、web-pages、document-store、defect-agent、workflow-agent、open-platform、changelog | pill(自动注入或手嵌)+ 锚点 + seed 齐 | 维护即可 |
| B 薄教程(断头,待加厚) | pr-review(4)、emergence(4)、workflow(4) | 步数偏少 | 见 `debt.onboarding-tips` 加厚 |
| C 核心 Agent 缺教程 | video-agent(0 锚 0 seed) | 无教程 | 本次不做(用户未勾选),登记债务 |
| D 编辑器子页 | defect/workflow 编辑器 | 无独立教程 | 见 debt(本次纳入计划,按需补) |
| E 豁免(一眼看懂/管理/WIP) | users、mds、assets、my-assets、admin-web-pages、settings、executive、infra-services、data-transfers、weekly-poster、labs/*、my/shares + WIP(pa-agent、product-agent、project-route-agent、ccas-agent、arena、task-tree、cds-agent) | CRUD/管理/未成形 | 登记豁免,不做教程(符合「明显看得到的不算复杂」) |

## 本次统一升级落地(2026-06-04)

- 三类 tip(onboarding/task/update)+ `GET /api/daily-tips/progress` 进度端点。
- 选择面板(多套教程)+ 单套直接开讲;镂空可点;完成飞回 pill 动画。
- 头像掌握度进度环 + 学习中心页(`/learning-center`)+ 头像下拉入口。
- `tutorial-daily-maintain` 技能:定时维护更新提醒 + 锚点漂移检测 + 验收归档。

## 已知边界

见 `doc/debt.onboarding-tips.md`。
