# 统一短链系统 · 规格

> **版本**: 1.0.0
> **最后更新**: 2026-05-14
> **状态**: 已落地（PR #613）

## 概述

把 web hosting / workflow / defect / report / document_store / toolbox 等多套分享系统的随机长 token 统一收敛到一个全局自增数字短码 `/s/{seq}`，URL 从 15+ 字符压缩到 3-5 字符。

## 接口

| 方法 | 路径 | 用途 | 鉴权 |
|------|------|------|------|
| `POST` | `/api/web-pages/share` | 创建网页托管分享，响应同时返回 `shareUrl=/s/{seq}` + `legacyShareUrl=/s/wp/{token}` | 登录 |
| `GET` | `/api/short-links/{seq:long}` | 公开解析，返回 `{seq, targetType, token, createdAt}` | 匿名 |
| `GET` | `/api/admin/short-links` | 管理员列表，支持按 targetType / seq / token 筛选 | `short-links.manage` |
| `POST` | `/api/admin/short-links/{seq}/revoke` | 强制吊销（同步让 `/s/{seq}` 和 `/s/wp/{token}` 失效） | `short-links.manage` |
| `POST` | `/api/admin/short-links/repair-counter` | 把全局 counter 同步到 max(seq)，运维误删/误改后恢复 | `short-links.manage` |

## 设计决策

### 1. Seq 可枚举是有意为之

**决策**：`/api/short-links/{seq}` 公开匿名访问，不做 rate limit，攻击者可遍历 `/s/1..N` 拿到所有短链的 token。

**为什么不修复**：
- 公开分享 = 内容本就该任意人可见，URL 短而易传播比不可猜测更重要（这是产品场景的核心需求）
- 密码保护分享：枚举到 token 后调 view 端点仍 401，内容不泄露
- 解析端点**不返回**任何敏感字段（不返回标题、不返回作者、不返回站点 URL），仅返回 `(seq, targetType, token, createdAt)`
- 仍想要不可猜测 capability URL 的用户继续用旧版 `/s/wp/{随机12字符 token}`，该路径完全保留

**威胁建模**：
| 资源类型 | 枚举后可看到什么 | 是否问题 |
|---|---|---|
| 公开 web_page 分享 | token + 整个站点内容 | ✗ 设计意图：公开 = 公开 |
| 密码 web_page 分享 | token + "需要密码"提示 + 不可看内容/作者 | ✗ 内容仍受保护 |
| 已吊销分享 | token + "已失效"提示 | ✗ 无敏感泄露 |
| 不存在的 seq | 404 | ✗ 无敏感泄露 |

**审查反馈记录**：codex (P1) 与 cursor bugbot (Medium) 各提了一次"sequential enumerable"。两条都按本决策维持现状，不修代码。本规格作为今后类似 review 的标准答复。

### 2. 一资源 → 一 Seq（幂等）

`(TargetType, TargetId)` Mongo 唯一索引兜底。`AllocateAsync` 先查再插：
- 命中已有：直接返回旧 Seq
- 未命中但插入撞 Seq 唯一索引（counter 落后）：最多 16 次重试 `$inc + insert`
- 仍失败：调 `RepairCounterAsync` 同步 counter = max(seq) 后最终再插一次
- 最终 insert 仍要 catch DuplicateKey（并发场景两个 caller 同时走 repair 路径，先到的赢）

### 3. 老链接 100% 兼容

`/s/wp/{token}` 路由完全保留，view 端点未改。新创建的分享 `WebPageShareLink.ShortSeq` 字段可选（旧记录 `=0`），UI 自动退回长链显示。

## 关联

- 实现：`prd-api/src/PrdAgent.Core/Models/ShortLink.cs`、`ShortLinkService.cs`、`ShortLinksController.cs`、`AdminShortLinksController.cs`
- 前端：`prd-admin/src/pages/ShortLinkRouter.tsx`、`prd-admin/src/pages/settings/ShortLinksAdminSettings.tsx`
- 索引手册：`doc/guide.platform.mongodb-indexes.md` → `short_links` 段
- PR：[#613](https://github.com/inernoro/prd_agent/pull/613)
