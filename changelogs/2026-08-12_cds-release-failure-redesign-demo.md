| docs | cds | 新增发布失败诊断改版 demo（cds/web/demo/release-failure-redesign.html）：复刻现状文字墙、给出四层信息结构改版稿与改动清单，双主题可切换 |
| polish | cds | demo 按克制原则重做：首屏只留结论/影响/下一步，判据与日志收进详情抽屉，根因与工单改为默认收起的渐进披露 |
| feat | cds | demo 新增「交给智能体」与「复制改造工单」：把失败诊断与重构需求整理成可直接粘贴执行的任务文本，一键复制 |
| polish | cds | demo 加入克制动效：进场按信息优先级错峰、失败步骤点亮后闪一次、抽屉 0fr→1fr 生长并接力面板高度、分段控件滑块、浮层进退场、复制按钮就地确认；全部走 prefers-reduced-motion 兜底 |
| fix | cds | demo 复制加 500ms 兜底：剪贴板 API 不 resolve 也不 reject 时改走 execCommand，再失败明确提示手动选中，杜绝点了没反馈 |
