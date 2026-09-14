| feat | cds | 验收报告首页放大态换成与紧凑态同一套视觉语言（判断句 + 总览条 + 逐项目明细），删除厂房剖面 |
| feat | cds | 已验完那段的点阵按通过 / 原则性 / 未通过三档着色，主体不再是一片灰阶 |
| refactor | cds | PipelinePanel 收敛为编排层（1400 行降到 270 行），图形迁入 CompactStrip |
| fix | cds | CountText 改用 PlayCtx 取播放信号并渲染为 span，此前写死 true 且用了 SVG 的 text 标签 |
| test | cds | 尺寸 / 动效 / 提示三份厂房时代守卫按新结构重写，新增结论三档与两态同源的守卫
