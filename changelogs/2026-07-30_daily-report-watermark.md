| fix | .claude | 日报采集口径从「按日历日」改为「按上期水位线续采」，根治定时任务清晨运行导致当天晚些时候提交永久漏报（实测 07-28/07-29 两天漏 8 个主干条目、36 次真实提交） |
| feat | .claude | 新增 daily-report-summary/reference/coverage_window.py：从知识库读上期 metadata.lastCommit 解析采集窗口，三级兜底 sha/since/today，中断自动续上 |
| feat | .claude | publish.py 新增 --last-commit/--cover-from/--cover-to 回写水位线，新增 --replace-same-date 同日重跑替换旧条目（先建新并校验落库、再删旧） |
| docs | doc | debt.report-agent.daily.md 记录漏报事故根因、已落地修法与遗留边界（历史空洞在提交图上不连续，需显式枚举补齐；水位线断链自检未做） |
