# spec.submission-gallery — 作品投稿与画廊展示 · 规格

> **状态**: 已实现（部分修正中） | **日期**: 2026-03-23
> **涉及模块**: prd-api (SubmissionsController), prd-admin (showcase/, literary-agent/)

---

## 1. 概述

作品投稿系统允许用户将视觉创作和文学创作的作品发布到公共画廊（作品广场）。不同创作类型有不同的投稿粒度和展示策略。

## 2. 投稿类型与粒度

### 2.1 视觉创作投稿（contentType: "visual"）

| 属性 | 说明 |
|------|------|
| **投稿粒度** | 单图（每张 ImageAsset 一个 Submission） |
| **封面** | 静态，取投稿时的图片 URL |
| **首页展示** | 每张图独立卡片 |
| **详情页** | 左侧展示当前图 + 同 Workspace 所有图片（"同项目作品"轮播） |
| **自动投稿** | 生图完成后自动调用 `auto-submit`（受开关控制） |
| **手动投稿** | 画布右上角按钮，批量提交当前画布所有已生成图片 |

```
视觉创作投稿数据流：
ImageAsset₁ → Submission₁ (visual, cover=图片₁)
ImageAsset₂ → Submission₂ (visual, cover=图片₂)
ImageAsset₃ → Submission₃ (visual, cover=图片₃)
首页显示：3 个独立卡片
```

### 2.2 文学创作投稿（contentType: "literary"）

| 属性 | 说明 |
|------|------|
| **投稿粒度** | Space（每个 Workspace 一个 Submission） |
| **封面** | 动态，取 Workspace 最新 ImageAsset 作为封面 |
| **首页展示** | 一个 Space 卡片，点击展开查看所有内容 |
| **详情页** | 左侧展示当前版本配图（按 ArticleWorkflow 过滤）+ 右侧文章正文 + 4 Tab 配方 |
| **自动投稿** | 首次生图成功后自动创建 literary Submission（受开关控制） |
| **手动投稿** | 编辑器右上角按钮，创建一个 Workspace 级别的 literary 投稿 |

```
文学创作投稿数据流：
Workspace (含 ImageAsset₁~₁₀) → Submission₁ (literary, cover=最新配图)
首页显示：1 个 Space 卡片
点击进入：看到所有当前版本配图 + 文章正文
```

### 2.3 对比总结

| 维度 | 视觉创作 | 文学创作 |
|------|----------|----------|
| 投稿单位 | 单张图片 | 整个 Workspace |
| 首页占位 | N 个卡片（N = 图片数） | 1 个卡片 |
| 封面策略 | 静态（投稿时快照） | 动态（最新配图） |
| 关联内容 | 同 Workspace 图片（轮播） | 文章正文 + 当前版本配图 |
| ContentType | `"visual"` | `"literary"` |
| 查重键 | `ImageAssetId` | `WorkspaceId + ContentType` |

## 3. 禁止行为

1. **文学创作投稿不得创建 visual 类型子投稿** — 文章配图属于 Space 的一部分，不应独立出现在首页
2. **同一 Workspace 不得创建多个 literary 投稿** — 后端按 `WorkspaceId + ContentType` 查重
3. **投稿不得跨用户** — OwnerUserId 必须匹配

## 4. API 端点

| 方法 | 端点 | 用途 | 适用场景 |
|------|------|------|----------|
| POST | `/api/submissions` | 创建投稿 | visual（单图）或 literary（workspace） |
| POST | `/api/submissions/auto-submit` | 批量自动投稿 | **仅用于视觉创作**，按 ImageAssetId 批量创建 visual 投稿 |
| GET | `/api/submissions/public` | 公开列表 | 首页画廊，支持 contentType 过滤 |
| GET | `/api/submissions/{id}` | 详情 | 含关联资产、文章正文、生成快照 |
| GET | `/api/submissions/check` | 查重 | 检查 imageAssetId 或 workspaceId 是否已投稿 |

## 5. 首页画廊展示

- 瀑布流布局（CSS columns，响应式 2-4 列）
- 3 个 Tab：全部 / 视觉创作 / 文学创作
- 排序：点赞数降序 → 创建时间降序
- 分页：每页 20 条，点击加载更多
- 卡片：封面图 + 作者头像 + 用户名 + 浏览数 + 点赞数

## 6. 详情弹窗

- 3 列布局：缩略图列 | 主图 | 右侧面板
- 右侧 4 Tab：正文 / 提示词 / 参考图 / 水印（数据来自 GenerationSnapshot）
- 底部：同项目作品轮播
- 键盘导航：← → Esc
