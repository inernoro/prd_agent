# debt.daily-tips.onboarding

| 字段 | 内容 |
|---|---|
| 模块 | 页面教程(小技巧)系统 |
| 状态 | open(2026-06-04 统一升级后剩余尾巴) |
| 关联 | `.claude/rules/onboarding-tips.md`、`doc/report.tutorial-coverage.md`、`DailyTipsController.BuildDefaultTips` |
| 提出 | 2026-06-04 教程系统统一(picker/镂空/返回动画/进度/学习中心/定时技能)交付时主动声明的已知边界 |

---

## 已知边界 / 待补

1. **video-agent 完整教程未做**:用户本次未勾选「核心 Agent 新建完整教程」。video-agent 现 0 锚点 0 seed。补法:加 6-10 个 `data-tour-id` + 一条 `video-agent-page-guide` seed。

2. **薄教程加厚(pr-review / emergence / workflow,各 4 步)**:这三条偏「断头」。加厚需先在页面补常驻 `data-tour-id`(pr-review 现 3 锚、workflow 现 3 锚、emergence 现 4 锚),再扩 seed 到 ≥6 步完整生命周期。加厚时严守 onboarding-tips §2 锚点常驻 + 对账,且别为凑步数加「一眼看懂」的填充步。

3. **编辑器子页教程(defect/workflow 编辑器)**:视觉/文学已有 `*-editor-page-guide`;defect/workflow 编辑器子路由暂无。按需补,锚点用 `*-editor-*` 前缀,从列表页「贯通」进编辑器。

4. **跨页串联大任务教程**:如「文学创作 → 为段落配图 → 视觉生成 → 插回」。机制已支持(`step.NavigateTo` 跨页 + 根挂载 overlay 不卸载),待补一条 seed,锚点需跨页常驻。

5. **进度掌握度分母未按权限过滤**:`GET /api/daily-tips/progress` 的 onboarding 总数是全部官方本页教程,未按用户对各页的访问权限过滤 → 无某页权限的用户进度环可能到不了 100%。v1 接受;后续可按 permission 过滤目录。

6. **移动端头像进度环**:本次只给桌面侧栏头像加了 `AvatarProgressRing`;移动端头部头像未加,待补。

## 偿还触发

- 用户明确要求补 video-agent / 某条薄教程加厚时。
- `tutorial-daily-maintain` 巡检报告里 onboarding 覆盖率长期偏低、或反复出现某页锚点漂移时。
