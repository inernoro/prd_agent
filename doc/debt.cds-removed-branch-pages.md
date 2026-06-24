# CDS 过期分支预览页 · 债务台账

> **日期**：2026-06-24 | **状态**：维护中
> 关联：`cds/src/index.ts`（buildBranchMergedPageHtml / buildBranchAbandonedPageHtml / serveBranchGonePage）、`cds/src/services/state.ts`（recordRemovedBranch）、`cds/src/routes/github-webhook.ts`

## 背景

PR 合并/关闭后分支被删，原先一律落「启动失败」错误页。现按分支墓碑（`BranchTombstone.reason`）分流：

- `merged` → 「已合并到主分支」中间页 + 主按钮切换到主分支预览（已完成，本次重点）
- `abandoned` → 「分支已放弃」页 + 跳 PR（基础版已完成）

两页沿用 transit/waiting 页同款 `shapeGridBg` 动效网格背景 + 暖色双主题 token。

## 已知边界 / 后续可补

| # | 项 | 说明 | 优先级 |
|---|----|------|--------|
| 1 | commit 直链 | 放弃页目前只跳 PR；可补「查看最后一次 commit」直链（墓碑已存 `mergeCommitSha`，但 abandoned 通常无合并提交，需另取 head sha） | 低 |
| 2 | 放弃页推荐可用分支 | 复用 `liveBranchesForGonePage` 的模糊匹配，给放弃页也列出最匹配的在跑分支 | 低 |
| 3 | 墓碑来源仅 PR closed | 直接 `git push --delete`（无 PR）触发的 GitHub `delete` 事件目前不写墓碑 → 仍落「启动失败」页。可在 handleDelete 也写一条 reason='abandoned' 的墓碑 | 中 |
| 4 | 合并页无自动跳转 | 按需求「希望用户点击切换」，刻意不做自动跳转（避免预期失控）。若后续想加兜底，需带可见倒计时 + 可取消 | 低 |
| 5 | 墓碑容量上限 200 | 超出按 removedAt 淘汰最旧；大流量多项目实例可能淘汰过快，可改为按项目分桶或调大上限 | 低 |
| 6 | previewSlug 口径依赖 | 墓碑 key = `computePreviewSlug(branch, projectSlug)`，若未来预览 slug 公式再变（v4），历史墓碑 key 会对不上（与现有预览链接同此风险） | 低 |

## 验证状态

- 单测：`tests/services/github-webhook-dispatcher.test.ts`（merged/abandoned 的 tombstoneRequest）、`tests/services/state.test.ts`（record/get/cap/persist）全绿
- `pnpm tsc --noEmit` 零错误
- 真机视觉验收（双主题截图合并页/放弃页）：待 CDS 部署后补
