---
title: "CDS loading pages 债务台账"
type: debt
module: cds
status: partial
updated: 2026-06-23
---

## 已知债务

### D1 — forwarder 硬重启（~3s 预览抖动）

**现状**：`master-run` 启动时检测到 `dist/ mtime > forwarder 进程启动时间`，直接执行
`systemctl restart cds-forwarder.service`（硬重启，非 graceful drain）。
每次 CDS self-update 重建 dist 后，forwarder 重启期间所有预览流量 502 约 3 秒。

**位置**：`exec_cds.sh` L2916-2925

**修法（待做）**：
1. forwarder 监听 `SIGUSR2` → 开始 graceful drain（停接新连接，等进行中请求完成）
2. `master-run` 改为发 `SIGUSR2` 替代 `systemctl restart`
3. 或：`cds-forwarder.service` 启用 `ExecStop` graceful timeout + socket 继承（`SO_REUSEPORT`）

**优先级**：低（3s 抖动用户感知不强，且已有 nginx 等待页兜底）

---

### D2 — nginx waiting page 有多个散落的硬编码 HTML 模板

**现状**：8 个 loading/waiting HTML 页面分散在 5 个文件中，没有统一的 SSOT：

| # | 文件 | 函数/位置 |
|---|------|-----------|
| 1 | `cds/web/src/pages/PreviewPreparingPage.tsx` | React 组件（已迁移） |
| 2 | `exec_cds.sh` L738 | `write_waiting_html()` heredoc |
| 3 | `src/forwarder/waiting-page.ts` | `buildForwarderWaitingPageHtml()` |
| 4 | `src/routes/branches.ts` L13935 | `buildLegacyWaitingPreviewHtml()` |
| 5 | `src/routes/branches.ts` L14108 | `buildLoadingPreviewBranchGoneHtml()` |
| 6 | `src/index.ts` L2351 | `buildBranchGonePageHtml()` |
| 7 | `src/index.ts` L2435 | `buildTransitPageHtml()` |
| 8 | `src/services/proxy.ts` L890 | `serveDeployErrorLightPillarPage()` |

各自的 CSS token / 色值 / 双主题支持程度不一致，导致每次"更新样式"只能改到几个，
其余继续用旧风格，被用户发现后再修再遗漏，循环往复。

**已完成**：#2（`write_waiting_html`）已迁移到 `src/loading-pages/index.ts`，
`exec_cds.sh` 调用 `node dist/cli/render-page.js nginx-waiting` 生成，SSOT 统一到 TypeScript。

**待做（按优先级）**：
- [ ] #3 `buildForwarderWaitingPageHtml` 迁移到 `src/loading-pages/index.ts`
- [ ] #4 `buildLegacyWaitingPreviewHtml` 迁移并统一双主题
- [ ] #5 `buildLoadingPreviewBranchGoneHtml` 已有双主题，迁移到统一模块
- [ ] #6 `buildBranchGonePageHtml` 升级样式 + 迁移
- [ ] #7 `buildTransitPageHtml` 迁移（这个是最现代的，作为样式基准）
- [ ] #8 `serveDeployErrorLightPillarPage` 迁移

**完成标准**：所有 loading page HTML 都从 `src/loading-pages/index.ts` 导出，
`exec_cds.sh` 调用 TypeScript CLI 渲染，添加 vitest 快照测试防止各自漂移。

---

### D3 — CDS_USE_FORWARDER 默认 0（隔离未启用）

**现状**：`exec_cds.sh` 默认 `CDS_USE_FORWARDER=0`，`cds_worker` upstream 指向 master 9900。
CDS self-update 重启 master 期间（pnpm install + tsc 编译，约 30s~2min），
所有预览流量 502，nginx 返回 `cds-waiting.html`。

**修法（待评估）**：
在 `init` 向导中主动询问用户是否启用 forwarder，或改为默认 1 + 自动安装 systemd service。
需确认所有生产部署节点的 systemd 版本兼容性。

**优先级**：中（影响所有自升级窗口的预览可用性）

---

### D4 — 预览访问自动唤醒（preview auto-wake）的已知边界

**背景**：2026-06-23 用户要求"降温分支被访问时自动唤醒"，不再甩诊断死页。已落地
`proxyService.setOnReviveCooled`（`src/index.ts`）+ `ProxyService.triggerCooledWake/
shouldAutoWakeCooled`（`src/services/proxy.ts`），对**调度器降温**的分支
（`status='idle'` 且 `lastStopSource='scheduler'`，容器被 `docker stop` 保留）在
真实页面导航时做一次 `containerService.restartServiceInPlace`（docker restart，不重建代码）
并展示等待页，就绪后落到真实页面。这是 `src/index.ts` 旧注释里写的"Phase 2 lighter-weight
restart path"。

**已知边界 / 待补**：
- [ ] **沙箱无 docker，未端到端验证**：scoping 决策已有 vitest 守卫
  （`tests/services/proxy-auto-wake.test.ts`，7 例），但真实的 docker restart →
  健康 → 落地真实页面只在 CDS 环境可验。首次部署后需人工复测一次。
- [ ] **容器被 janitor 回收后无法原地重启**：`restartServiceInPlace` 返回 false →
  分支转 `error` 展示诊断页（不再无限 spinner）。此时正确做法是引导用户「重新部署」
  （全量重建），目前未在等待页给一键重部署入口。可后续补。
- [ ] **爬虫/链接预取仍可能唤醒**：已用「仅顶层 HTML 导航请求（`isHtmlNavigationRequest`）」
  过滤静态资源/非 document 请求，但发送 `Accept: text/html` 的爬虫仍可能触发一次唤醒。
  缓解而非根除。Kill-switch：`CDS_PREVIEW_AUTOWAKE=0` 整体关闭。
- [ ] **多服务分支**：逐个 `restartServiceInPlace`，任一失败该分支转 `error`。未做部分
  成功的细粒度展示。
- [ ] **与调度器 tick 的竞态**：靠 `branchOperationCoordinator` 租约（kind=`auto-restart`
  → priorityOf 35）抢占——高于 scheduler-cooling（30，可抢占），低于 auto-lifecycle（40）/
  webhook deploy（50）/ manual restart·deploy（80，让位）。唤醒成功后刷新 `lastReadyAt` +
  `lastAccessedAt` 再 `markHot`，避免下一 tick 立刻按陈旧时间戳降温或 auto-publish（与手动
  `/restart` 同款修法）。容量驱逐 best-effort（驱逐失败不毒化本分支）。

**完成标准**：CDS 环境实测「降温 → 访问预览域名 → 看到唤醒等待页 → 落到真实应用页」
闭环；并对 janitor 回收后的 fallback、kill-switch 各验一次。
