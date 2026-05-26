---
type: debt
module: daily-tips
status: open
owner: 待认领
last_review: 2026-05-26
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

## 相关文件

- `prd-api/src/PrdAgent.Core/Models/AdminNotification.cs` — ExpiresAt 默认 7 天
- `prd-api/src/PrdAgent.Api/Controllers/Api/AdminDailyTipsController.cs` — Create 默认过期 + seed/reset 克隆 EndAt
- `prd-api/src/PrdAgent.Api/Controllers/Api/DailyTipsController.cs` — BuildDefaultTips 2 条 feature tip + /visible EndAt 过滤
- `prd-api/src/PrdAgent.Api/Controllers/Api/DefectAgentController.cs` — defect-fix tip 14→7 天
- `prd-api/src/PrdAgent.Api/Controllers/Api/NotificationsController.cs` — /dashboard/notifications 的 ExpiresAt 过滤（已存在）
