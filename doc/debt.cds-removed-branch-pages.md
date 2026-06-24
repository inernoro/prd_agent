# CDS 过期分支预览页 · 债务台账

> **版本**：v1.0 | **日期**：2026-06-24 | **状态**：已落地
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
| 3 | ~~墓碑来源仅 PR closed~~（完成 2026-06-24） | `handleDelete` 现在也返 `tombstoneRequest`（reason='abandoned'），`recordRemovedBranch` 加 merged 粘性防降级。直接 `git push --delete` 也落「已放弃」页 | 完成 |
| 4 | 合并页无自动跳转 | 按需求「希望用户点击切换」，刻意不做自动跳转（避免预期失控）。若后续想加兜底，需带可见倒计时 + 可取消 | 低 |
| 5 | 墓碑容量上限 200 | 超出按 removedAt 淘汰最旧；大流量多项目实例可能淘汰过快，可改为按项目分桶或调大上限 | 低 |
| 6 | previewSlug 口径依赖 | 墓碑 key = `computePreviewSlug(branch, projectSlug)`，若未来预览 slug 公式再变（v4），历史墓碑 key 会对不上（与现有预览链接同此风险） | 低 |
| 10 | ~~停止但未删除的 PR 分支不走分流页~~（完成 2026-06-24） | PR closed 后分支**未被自动删除**时 `BranchEntry` 仍在、`stopped`，原先 `proxy.routeToBranch` 命中现存 entry 服务泛化停止页、走不到 `serveBranchGonePage`（Codex P2）。已修：`routeToBranch` 在 stopped 分支分支兜底前先查墓碑（`findRemovedBranchByIdentifier(branch.id)`），命中且为真实 HTML 导航则走新增 `onBranchGone` 回调 → `serveBranchGonePage` 分流到合并/放弃页。fail-safe（无墓碑照旧、asset 请求不拦），且置于 auto-wake/恢复副作用之前（不复活已合并分支）。守卫测试 `proxy-tombstone.test.ts` | 完成 |

## 极速版「等待 CI 镜像」可观测性（2026-06-24，关联但独立）

> 根因调查：分支卡显示「容器停止 · 无记录 · 时间未知」，实为极速版分支卡在
> `ciImageStatus='waiting'` 永不部署。实证 `claude/nice-newton-zngjw1`（PR #919，
> `82ff0df`）：分支 tree 缺 `.github/workflows/branch-image.yml`（从旧 main 切出）→
> GitHub 该分支 `branch-image.yml` 运行 0 次 → CDS 等 `workflow_run.completed` 永不到达 →
> 无限期 idle / `lastDeployAt=null`，且无任何记录。前端把它误标成「停止」。

已修：
- **A. UI 说真话**（`BranchListPage.tsx`）：拆出 `等待 CI 镜像 / CI 镜像未就绪 / 待部署` 三态，
  `shouldShowStopReason` 对齐后端 `isStoppedBranch` 口径（真有停止信号才显示停止面板）。
- **B. waiting 看门狗**（`index.ts` `startCiWaitWatchdog`）：`ciWaitingSince` 计时，超时
  （默认 15min，`CDS_CI_WAIT_TIMEOUT_MS` 可调）翻 `failed` + 写 `ciImageError` 归因 +
  server-event（`app.ci-image.wait-timeout`）+ `branch.updated` 事件。failed 不阻断恢复
  （真 CI 晚到仍 failed→ready）。

后续可补：

| # | 项 | 说明 | 优先级 |
|---|----|------|--------|
| 7 | 入口校验（C-full） | 进极速版等待前先确认分支 tree 有 `branch-image.yml`（一次 GitHub API 查），没有就直接走源码编译，不进死等。当前靠看门狗事后兜底（15min 延迟） | 中 |
| 8 | 详情页 CI 态 | `BranchDetailDrawer` / `BranchDetailPage` 暂未单独渲染 `ciImageStatus=waiting/failed`（已不会误标停止，但缺主动提示）。可补与卡片一致的 CI 状态块 | 低 |
| 9 | 自动回退源码编译 | 看门狗目前只翻 failed + 提示「可手动切源码编译」，未自动触发源码部署（避免后台任务抢资源）。可做成项目级开关 | 低 |

## 验证状态

- 单测：`tests/services/github-webhook-dispatcher.test.ts`（merged/abandoned 的 tombstoneRequest + delete 路径 abandoned）、`tests/services/state.test.ts`（record/get/cap/persist + merged 粘性 + CI 字段 round-trip）全绿
- `pnpm tsc --noEmit`（cds 后端 + cds/web）零错误；`cds/web` `pnpm build` 通过
- 真机验收：待 CDS 部署后，`claude/nice-newton-zngjw1` 应由看门狗翻 failed、卡片显示「CI 镜像未就绪（缺 branch-image.yml…）」而非「停止/无记录」
- `pnpm tsc --noEmit` 零错误
- 真机视觉验收（双主题截图合并页/放弃页）：待 CDS 部署后补
