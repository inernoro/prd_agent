# CDS 极速版（CI 预构建）· 债务台账

> **版本**：v1.0 | **日期**：2026-06-23 | **状态**：维护中

## 总览

把「编译」从 CDS 服务器卸载到 GitHub Actions：push → CI 按 commit SHA 编译成 ghcr 镜像 →
CDS 收 `workflow_run.completed` 后 `docker pull` + run（跳过本机编译）。在现有「热加载 / 发布版」
之外新增第三种部署模式「极速版（CI 预构建）」。旧源码编译模式全部保留兼容。

模块范围：`.github/workflows/branch-image.yml`、`cds-compose.yml`、`cds/src/services/{container,deploy-runtime,github-webhook-dispatcher,state,branch-events}.ts`、`cds/src/routes/{branches,github-webhook}.ts`、`cds/web/src/pages/BranchListPage.tsx`、`cds/src/services/compose-parser.ts`。

SSOT 约定：镜像 tag = `sha-${github.sha}`（完整 40 hex，不可变）。CI 推什么 tag、CDS 拉什么 tag，
两边走同一公式（CI `docker/metadata-action` ↔ CDS `resolveImageTemplate` / `slugifyBranchForImage`）。

---

## 已知边界 / 待补（open）

| # | 债务 | 说明 | 影响 |
|---|------|------|------|
| 1 | ghcr 包需手动设为 public | 首次 push 后 `prdagent-server` / `prdagent-admin` 两个包默认 private，需在 GitHub Packages 设置里改 Public，CDS 才能匿名 `docker pull`。否则极速版部署报「镜像拉取失败」 | 一次性 ops；未设则极速版不可用，分支显示「CI 构建失败」可切回源码 |
| 2 | 工作流名硬编码 | CDS 只认 `branch-image.yml` / name `Branch Image` 的 workflow_run（避免 ci.yml 等先完成误触发）。常量在 `github-webhook-dispatcher.ts` 的 `CI_PREBUILT_WORKFLOW_FILE/NAME` | 泛化到任意 public 仓库时需做成 project 级配置 |
| 3 | 每次 push 构建两镜像 | 不做 path-filter（保证每个 SHA 的 api+admin 镜像都齐全，避免缺镜像拉取失败）。public 仓库 CI 免费可承受，但分钟数消耗较大 | 私有仓库或限额场景需重新评估 |
| 4 | 极速版仍 git pull worktree | 部署时未跳过 `worktreeService.pull`（仅跳过编译）。pull 是廉价 git fetch，且保留 worktree 同步利于「切回源码编译」兜底；真正的重负载（编译）已由 prebuiltImage/skipSrcMount 消除 | 轻微冗余，不影响目标（卸载编译算力） |
| 5 | 构建时延（分钟级） | push → 预览就绪比源码热加载慢出现（要等 CI 构建）。等待期分支卡有「等待 CI 镜像」徽章（非静止），符合预期管理 | 体验取舍：省 CDS CPU 换首次时延 |
| 6 | 「切回源码编译」非一键 | 失败态徽章的「切回源码编译」打开分支详情抽屉，由现有部署模式下拉切回 source 模式（已可用），未在卡片做单击直切 | 能力已存在，仅少一步快捷 |
| 7 | ClaudeSdkExecutor 回调端口 | express 模式 env 覆盖 `ClaudeSdkExecutor__CallbackBaseUrl` 为 `http://api-prd-agent:8080`（生产镜像端口）。若分支网络别名与项目 slug 不一致需核对 | 边缘功能；主链路（API 服务）不受影响 |

## 验证状态

- CDS 后端 `pnpm tsc --noEmit` 零错误；web `pnpm tsc --noEmit` 零错误。
- 新增 `tests/services/ci-prebuilt-express.test.ts`（12 用例）全绿：镜像模板解析、prebuilt 模式生效、
  workflow_run head_sha 匹配、push→waiting、非预构建工作流忽略。
- 回归：compose-parser / container / github-webhook-dispatcher / github-webhook(route) 全绿。
- 端到端（真实 push → CI → CDS 拉取）需在 ghcr 包设 public 后于预览环境取证（未在本地沙箱跑通，
  依赖 GitHub Actions 真实构建 + CDS 实例 webhook）。

## 已偿还（paid）

（暂无）
