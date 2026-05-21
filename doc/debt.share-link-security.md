---
type: debt
module: share-link-security
status: open
owner: 待认领
last_review: 2026-05-20
---

# 分享链接安全债务台账

记录"快速分享"链接体系（网页托管 / 周报 / 知识库 / 工作流）尚未完成的安全加固项。
2026-05-20 用户安全审计触发，分两波完成（C1 前端引导、C2 网页+周报后端 Hash + 速率限制），
本文件留尾剩下的工作。

## 历史背景

| 时间 | 事件 |
|---|---|
| 2026-05-20 | 用户提出 4 个分享场景中"快速分享"按钮存在 5 类问题：默认数字短链 /s/{seq} 可枚举、短链无强密码要求、取消密码无警告、明文密码存储、无在线暴破防护 |
| 2026-05-20 C1 | 前端 ShareDialog 改造：默认长链、短链强 12 位密码、取消密码 10s 倒计时（网页托管 + 周报） |
| 2026-05-20 C2 | 后端 `SharePasswordService`（PBKDF2-SHA256 + FixedTimeEquals + per-shareLink 滑动窗口 1 分钟 10 次限速）落地网页/周报；DB 字段 `PasswordHash/PasswordSalt/RecentAttempts` 新增 |

## 已知边界 / 待补项

### 0. P1.next：周报 / 知识库 / 工作流 ShareView 接 `tokenOverride` prop

**位置**：`prd-admin/src/pages/ReportTeamShareViewPage.tsx`、`prd-admin/src/pages/DocumentStoreShareView*.tsx`、`prd-admin/src/pages/WorkflowShareView*.tsx`、`prd-admin/src/pages/ShortLinkRouter.tsx::renderTarget`

**现状**：P1 把 4 处分享 URL 统一到 `/s/{token}`，但只有 `ShareViewPage`（网页托管）支持通过 prop 接收 token；其它 3 个 ViewPage 还在用 `useParams().token`，因此 `ShortLinkRouter` 拿到 (type=report/docstore/workflow, token) 后只能 `<Navigate to="/s/report-team/..." />` 跳转到旧专用路径。结果：**用户从字母 URL `/s/{token}` 打开周报分享时，URL bar 会闪一下变成 `/s/report-team/{token}`**。

**待办**：
- 3 个 ViewPage 各加 `tokenOverride?: string` prop（参考 `ShareViewPage`），优先 prop 后 fallback `useParams`
- `ShortLinkRouter.renderTarget` 把这 3 个 case 从 `<Navigate>` 改为直接 `<XxxShareViewPage tokenOverride={token} />`
- 验证：用 `/s/{字母 token}` 打开周报分享时 URL bar 始终保持 `/s/{token}` 不变

### 1. 分享链接体检 / 测试器实验室页

**位置**：拟新增 `prd-admin/src/pages/labs/ShareLinkTesterPage.tsx`

**现状**：用户希望"做成功能，然后在实验室点击测试"。目前测试分享链接只能去具体页面（网页托管/周报/知识库/工作流）创建，且无法对比 3 种 URL 形态（`/s/{token}` / `/s/{seq}` / 旧 `/s/wp/{token}`）的行为差异。

**待办**：
- 实验室新建页面"分享链接体检"
- 输入：粘贴任意 slug（数字或字母）
- 调 `/api/short-links/resolve/{slug}` 解析得 (targetType, token, seq)
- 展示：3 种 URL（统一长链 / 超短链 / 旧版前缀链）+ 每条带"在新标签页打开测试"按钮
- 额外：列出当前用户最近 N 条分享，每条都能一键三种 URL 互转测试

### 2. 知识库分享尚未支持密码保护

**位置**：`prd-api/src/PrdAgent.Core/Models/DocumentStoreShareLink.cs`、`prd-api/src/PrdAgent.Api/Controllers/Api/DocumentStoreController.cs::AccessShareLink`

**现状**：知识库分享链接是"匿名公开访问"，Model 没有 `AccessLevel` / `Password` 字段，端点也没有密码校验逻辑。本次 C2 没有触碰，因为"加密码"是新功能（需前后端联动 UI 改造）而非纯安全修复。

**待办**：
- Model 加 `AccessLevel`（public / password）+ `Password` + `PasswordHash` + `PasswordSalt` + `RecentAttempts`
- 创建端点接受 `password` 参数；访问端点接入 `ISharePasswordService.CheckRateLimit` + `Verify`
- 前端弹窗（DocumentStorePage）接入 C1 同款 ShareDialog（默认勾选密码、强密码、警告）

### 2. 工作流分享 ShareLink.Password 是 dead code

**位置**：`prd-api/src/PrdAgent.Core/Models/WorkflowModels.cs::ShareLink`、`prd-api/src/PrdAgent.Api/Controllers/Api/WorkflowAgentController.cs::ViewShare`（line ~1167）

**现状**：Model 有 `Password` 字段但 `ViewShare` 端点仅校验 `AccessLevel ∈ { public, authenticated }`，根本没引用 `Password`。前端 ExecutionDetailPanel 用 `window.prompt` + `alert` 完成分享（不是 Dialog 组件）。

**待办**：
- 工作流目前实质上不支持密码保护功能 —— 要么删除 Password 字段（保留向后兼容字段），要么补全校验逻辑
- 前端 alert 升级为 ShareDialog 组件（接入 C1 同款）
- 工作流的 ShareLink Model 也加 `PasswordHash/Salt/RecentAttempts`（与其他三个同步）

### 3. 数字短链端点速率限制

**位置**：`prd-api/src/PrdAgent.Api/Controllers/Api/ShortLinksController.cs`（或类似）

**现状**：`/s/{seq}` 端点根据 seq 直接解析 token 重定向；如果攻击者枚举 seq，每个不存在的 seq 也会消耗一次 DB 查询。本次 C2 没有为 `/s/{seq}` 入口加 IP-level 限流（前面提到 IP 不可靠，但对 `/s/{seq}` 这种枚举攻击只能按 IP 限流 —— 因为不绑定具体 shareLink）。

**待办**：评估是否需要在反向代理（nginx / CF）层做 `/s/{seq}` 的速率限制（如 100 req/min/IP），与应用层失败锁互补。

### 4. 明文密码字段保留在 DB

**位置**：所有 ShareLink Model 的 `Password` 字段

**现状**：C2 同时存明文 + Hash，明文用于"展示给分享者"（让用户能看到他设的密码）和"复用去重"（同密码复用同 ShareLink）。如果 DB 被打爆，明文密码会泄露。

**待办**：评估是否值得移除明文 —— 移除后"展示给分享者"功能消失（用户必须自己记），"复用去重"逻辑也要改（按 Hash 比对而非明文）。安全收益 vs 体验损失需要产品决策。

### 5. 已分配的数字短链历史链接

**位置**：现存 `web_page_share_links.ShortSeq != 0` 的所有记录、`short_links` 集合

**现状**：C1 改了"默认显示长链"，但**历史已经分享出去的数字短链 URL 仍然有效**。任何已经持有 `/s/123` 链接的人继续可访问（旧分享没密码 → 任何获得该数字的人都可访问）。

**待办**：评估是否需要批量"为旧链接补默认强密码 + 通知 owner 重新分享"，或者"批量删除无密码的数字短链"。需要产品决策（影响存量用户）。

## 验收点（已完成项）

供后续手工验证：

1. **网页托管 ShareDialog**：登录 → 网页托管页 → 站点卡片右上"分享"按钮
   - 默认弹窗：密码已勾选 + 默认长链
   - 展开"高级选项"勾选数字短链：密码 checkbox 自动锁定 + 自动填 12 位强密码 + 编辑成弱密码时按钮 disabled
   - 短链 + 取消密码：弹出 10s 倒计时风险确认模态
2. **周报 ShareDialog**：登录 → 周报页 → 团队周视图右上"分享"按钮
   - 默认弹窗：密码已勾选（8 位）+ 显示长链 `/s/report-team/xxx`
3. **后端 Hash 校验**：
   - 创建新分享后查 DB `web_page_share_links` 或 `report_share_links`：应同时有 `Password`（明文）+ `PasswordHash`（base64）+ `PasswordSalt`（base64）
   - 旧分享 PasswordHash 为空，访问时走明文恒时比对（不报错）
4. **滑动窗口速率限制**：
   - 用错误密码访问同一分享链接 10 次（1 分钟内）：第 11 次应得 HTTP 429 + `Retry-After` header
   - 等 1 分钟后再试：恢复
   - 输错 5 次 + 输对 1 次：清空窗口（输错记录不残留拖累下次）

## 关联文件

- `prd-api/src/PrdAgent.Infrastructure/Services/SharePasswordService.cs`（SSOT）
- `prd-admin/src/pages/WebPagesPage.tsx::ShareDialog`
- `prd-admin/src/pages/report-agent/components/ShareTeamWeekDialog.tsx`
- `.claude/rules/no-rootless-tree.md`（无根之木禁令：本债务台账即"暴露未实现的能力"实践）
