---
type: debt
module: daily-tips
status: open
owner: 待认领
last_review: 2026-06-04
---

# 小技巧与首页提醒过时机制 · 债务台账

记录 2026-05-26「小技巧 + 缺陷/首页提醒统一加 1 周过时机制」交付后的已知边界。
用户反馈：很多用户觉得小技巧/缺陷提醒是讨厌的常驻弹窗，希望 1 周后自动过时、不再显示到首页。

## 历史背景

| 时间 | 事件 |
|---|---|
| 2026-05-26 | 用户要求：① 新功能做成小技巧、挑 2 项默认推给所有用户；② 小技巧 1 周过时；③ 缺陷等提醒 1 周过期后不显示首页 |
| 2026-05-26 | 落地：feature-release/bug-fix 类 tip 默认 7 天过期；defect-fix 提醒 14→7 天；AdminNotification 默认 7 天过期；修复 seed/reset 克隆丢失 EndAt；新增 2 条 feature-release tip 入 BuildDefaultTips |

## 已知边界（留尾）

1. **历史提醒数据不回填**：`AdminNotification.ExpiresAt` 的 7 天默认仅对**新创建**的通知生效。
   Mongo 反序列化会保留旧文档里 `ExpiresAt=null` 的值，所以改动前已存在、且 `ExpiresAt=null`
   的历史通知仍会永久显示在首页。如需让存量提醒也过期，需要一次性迁移脚本
   （`db.admin_notifications.updateMany({expiresAt:null, status:"open"}, {$set:{expiresAt: <createdAt+7d>}})`），
   本次未做（避免无确认的批量数据变更）。

2. **2 条新功能 tip 在存量环境需手动 seed 一次**：新增的 `feature-2026w21-report-editor`
   / `feature-2026w21-knowledge-browser` 写在 `BuildDefaultTips`。空/新环境会通过 `/visible`
   兜底自动展示；但**已有数据的生产环境**（DailyTips 集合非空）需管理员在「系统设置 → 小技巧」
   点一次「一键植入(seed)」才会把这 2 条写库（幂等，按 SourceId 跳过已存在）。植入后 7 天自动过期。
   它们是全局可见 tip（不 auto-pop 弹窗），符合用户「不要讨厌的弹窗」诉求。

3. **feature-release seed 是时效内容**：`BuildDefaultTips` 里这 2 条带日期语义（2026-W20/W21），
   下线时间锚定固定常量 `FeatureTip2026W21ExpireAt`（2026-06-02），过此日期全平台（含 /visible 兜底）
   自动消失，但源码仍残留。下一批新功能上线时应替换这两条 + 更新常量，避免源码堆积过时公告。

4. **存量 14 天 defect-fix tip 不回填**：改动前已生成、EndAt=14 天的 defect-fix tip 仍按 14 天过期，
   只有新生成的按 7 天。影响极小（最多多挂 7 天），不做回填。

## 已修复（PR #673 review 反馈，2026-05-26）

- ~~Reset 端点克隆丢失 EndAt~~：已补 `StartAt`/`EndAt`（Bugbot Medium，原 replace 因缩进只命中 Seed 漏了 Reset）。
- ~~兜底 tip 用 now.AddDays(7) 每次请求重算、永不过期~~：改用固定常量 `FeatureTip2026W21ExpireAt` +
  `/visible` 兜底路径补发布窗口过滤，DB 与兜底两条路径口径一致（Bugbot Medium + Codex P2）。
- ~~AdminNotification 7 天默认会让未恢复的运营告警静默消失~~：模型池故障转移告警（`PoolFailoverNotifier`，
  唯一就地更新 + 自关闭的持续型告警）显式 `ExpiresAt = null` 豁免（Codex P1）。其余一次性提醒仍走 7 天默认。

## 2026-06-04 教程系统重构留尾（完整列表 / 难度经验 / 下线小技巧管理 / 升导航+首页承接卡）

用户验收反馈四点改造落地后的已知边界：

1. **AdminDailyTipsController 已整体删除**：「系统设置→小技巧管理」页 + `AdminDailyTipsController`
   （create/update/delete/push/seed/reset）全删，教程统一为代码内置 seed（`BuildDefaultTips`，
   `/visible` `/progress` 自动并入，无需手动 seed）。**本文上方「相关文件」里对该 Controller 的引用即此次删除的对象**。连带：
   - **定向推送下线**：不再有 `/{id}/push`，无法给指定用户/角色临时推送 tip；历史 `Deliveries` 仍按用户侧逻辑展示但不能新增。
   - **`createzzdemo` / `tutorial-daily-maintain` 两技能写入路径失效**：它们 `POST /api/admin/daily-tips`，端点已删 → 404。恢复「临时活动 tip / 自动更新提醒」需改为往 `BuildDefaultTips` 追加代码 seed 或重建最小写入端点。两 SKILL.md 本次未改（`.claude` 元数据）。
   - **DB 残留清理无 UI**：`/reset` 已删，脏行需 DBA 手动清；`RetiredSeedSourceIds` 运行时过滤仍在。
2. **两个 daily-tips 权限悬空**：`AdminPermissionCatalog` 仍留 `daily-tips.read` / `daily-tips.write`（行 125/130/419/420），已无端点消费。未删以避免 enum-ripple（角色 seed / 前端权限类型），后续权限清理时一并移除。
3. **难度=步数启发式 + 可选显式覆盖**：`DailyTip.Difficulty` 为空时按步数推断（≤4 初/5-8 中/≥9 高）。尚无 seed 显式标注；个别「步少但难」的页面需显式写 `Difficulty="advanced"` 上调。
4. **经验为派生量，乐观更新不含经验**：累计经验 = `progress` 对所有已完成教程 `xpReward` 求和（不单独落库）；`markLearned` 乐观只 +1 掌握度，经验/等级随后 `loadProgress(force)` 校正（短暂「学会了但经验没跳」窗口可接受）。
5. **等级阈值/经验权重为初版常量**：`LevelTable`(0/50/120/250/450/700/1000→新手…宗师) 与 `XpForDifficulty`(初10/中20/高40) 拍定，未配置化。
6. **首页承接卡与「更新中心/AI大事件」是视觉相邻+承接入口**：`LearningCenterTeaser` 挂在 Hero 后、Quick Links（含更新中心卡）之上，未把教程内容真正嵌进更新中心卡内部；如需「合并进更新中心卡」可再迭代。

## 相关文件

- `prd-api/src/PrdAgent.Core/Models/AdminNotification.cs` — ExpiresAt 默认 7 天
- ~~`prd-api/src/PrdAgent.Api/Controllers/Api/AdminDailyTipsController.cs`~~ — **已于 2026-06-04 删除**（教程改代码 seed）
- `prd-api/src/PrdAgent.Api/Controllers/Api/DailyTipsController.cs` — BuildDefaultTips 2 条 feature tip + /visible EndAt 过滤
- `prd-api/src/PrdAgent.Api/Controllers/Api/DefectAgentController.cs` — defect-fix tip 14→7 天
- `prd-api/src/PrdAgent.Api/Controllers/Api/NotificationsController.cs` — /dashboard/notifications 的 ExpiresAt 过滤（已存在）
