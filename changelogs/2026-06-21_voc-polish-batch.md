| fix | prd-api | VOC 洞察聚合自排除 /api/team-activity + /api/behavior(慢/错聚合及兜底,与热力图/趋势同口径),杜绝仪表盘自身慢请求回流成关于 VOC 页的洞察反馈回路;转需求初始化 StateEnteredAt,产品看板 SLA 首次流转前正常显示 |
| fix | prd-admin | 趋势爆点标记画在当前桶主导的那条线(慢主导=黄/报错主导=红),slow-only 突增不再误画到红色报错线基线;用户之声不传 filter 取全员缺陷全局列表(filter:all 会被后端限定为"我相关",漏掉他人提交) |
