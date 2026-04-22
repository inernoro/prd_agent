| refactor | prd-api | 删除 `shortcut-cmd-k` / `shortcut-cmd-b` 两条 seed。键盘快捷键是 Figma/VSCode 式"任意页面可用"的全局能力,强制跳到首页演示反直觉;Ctrl+B/K 应走静态 key-hint(UI 挂 `⌘+K` 提示)而非多步 Tour |
| fix | prd-admin | `changelog-latest` 锚点 bug:原实现 `releaseIdx === 0` 在第一个 release 被 matchFilter 过滤为 null 时锚点跟着消失,导致更新中心演示 6s 超时。改用闭包 `firstVisibleAssigned` 标志,确保锚点落在**第一个实际渲染的 release** |
| fix | prd-admin | SpotlightOverlay 超时阈值 6s → 10s(250ms × 40),给慢服务器 + 慢网络 + 懒加载页面余地;用户实测线上服务器慢会触发 changelog 假超时 |
| feat | prd-api | 用户永久 dismiss 按 **SourceId + Id 双维度存**,`/visible` 按双维度过滤。管理员「清空并重建」后 tip.Id 变但 SourceId 不变,用户点完过的 seed 重建后不再骚扰;解决「重建打扰已完成用户」问题。`seed-{x}` 式 id 自动 extract x 一并存入 |
| feat | .claude/skills | `createzzdemo` 技能升级为**两阶段工作流**:(1) 枚举 A-F 6 类候选步骤让用户挑组合,(2) 按选中输出 JSON。新增**角色智能推荐表**(PM/DEV/QA/ADMIN 各自刚需的教程清单),支持 `targetRoles` 定向;明确标注"键盘快捷键不适合本技能" |
| docs | doc | `design.daily-tips.md` §11 补键盘快捷键 / SourceId dismiss 约束;§12 新增跨版本更新通知策略(待实现)。`plan.daily-tips-scenarios-and-staleness.md` 增加**阶段 C**:Version 机制(DailyTip.Version + User.DismissedTipKeys 结构化)+ §9 已落地/未完成清单,工时 1.5 → 2 人天 |
