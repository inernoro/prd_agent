| docs | cds | 新增发布失败诊断改版 demo（cds/web/demo/release-failure-redesign.html）：复刻现状文字墙、给出四层信息结构改版稿与改动清单，双主题可切换 |
| polish | cds | demo 按克制原则重做：首屏只留结论/影响/下一步，判据与日志收进详情抽屉，根因与工单改为默认收起的渐进披露 |
| feat | cds | demo 新增「交给智能体」与「复制改造工单」：把失败诊断与重构需求整理成可直接粘贴执行的任务文本，一键复制 |
| polish | cds | demo 加入克制动效：进场按信息优先级错峰、失败步骤点亮后闪一次、抽屉 0fr→1fr 生长并接力面板高度、分段控件滑块、浮层进退场、复制按钮就地确认；全部走 prefers-reduced-motion 兜底 |
| fix | cds | demo 复制加 500ms 兜底：剪贴板 API 不 resolve 也不 reject 时改走 execCommand，再失败明确提示手动选中，杜绝点了没反馈 |
| fix | cds | 发布失败诊断结论位不再装整段日志：condenseHeadline 切掉 stderr/stdout 尾巴只留第一句并限长 96 字，UI 加 line-clamp-2 兜底，完整原文仍在 error 行区块 |
| fix | cds | 「生产未受影响」从元信息行末尾的灰色小字提升为独立状态条，仍只在目标当前版本 ≠ 本次版本时出现 |
| fix | cds | 重复日志按「只有数字不同」归并并显示计数与归并组数，替换只认完全相等的去重；组内不同原文照常展示，不压缩差异 |
| fix | cds | 修掉噪音误判：多行复合消息与 error 级日志不再进「顺带发现的噪音」栏——此前含 curl 重试措辞的复合 error 会被整条标成「不是失败原因」 |
