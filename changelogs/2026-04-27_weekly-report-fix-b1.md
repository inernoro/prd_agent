| fix | prd-admin | 周报主页默认 Tab 由旧 key `my-reports` 改为 `report`,初次进入直接落在「周报」(原本依赖 useEffect 旧→新映射,现去掉一层间接) |
| fix | prd-admin | 周报详情页审阅/退回成功后通过 store 事件总线 `lastReportMutation` 通知 TeamDashboard,后者监听并局部 mutate `reportsView.items / members` 与 per-week 缓存,返回团队列表立即看到状态翻面,无需手动刷新 |
