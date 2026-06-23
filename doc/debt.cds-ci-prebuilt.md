# CDS 极速版（CI 预构建）· 债务台账

> **版本**：v1.0 | **日期**：2026-06-23 | **状态**：进行中

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
| 3 | ~~每次 push 构建两镜像~~（已改为 path-filter，2026-06-23） | **已偿还**：改为 `dorny/paths-filter` 只构建改动组件（`prd-api/**`→api、`prd-admin/**`→admin），不再重复构建。某 commit 缺某组件镜像时，CDS runService 逐组件回退到固定主分支镜像（`:branch-main`，由 `DeployModeOverride.fallbackImage` 配置）。三种缺镜像场景（只一个构建/都没构建/仅 cds 改动）均由回退兜底，预览不硬失败 | 回退镜像目标固定写在 cds-compose `fallbackImage`；新仓库接入时需同步配置该字段 |
| 4 | 极速版仍 git pull worktree | 部署时未跳过 `worktreeService.pull`（仅跳过编译）。pull 是廉价 git fetch，且保留 worktree 同步利于「切回源码编译」兜底；真正的重负载（编译）已由 prebuiltImage/skipSrcMount 消除 | 轻微冗余，不影响目标（卸载编译算力） |
| 5 | 构建时延（分钟级） | push → 预览就绪比源码热加载慢出现（要等 CI 构建）。等待期分支卡有「等待 CI 镜像」徽章（非静止），符合预期管理 | 体验取舍：省 CDS CPU 换首次时延 |
| 6 | 「切回源码编译」非一键 | 失败态徽章的「切回源码编译」打开分支详情抽屉，由现有部署模式下拉切回 source 模式（已可用），未在卡片做单击直切 | 能力已存在，仅少一步快捷 |
| 7 | ClaudeSdkExecutor 回调端口 | express 模式 env 覆盖 `ClaudeSdkExecutor__CallbackBaseUrl` 为 `http://api-prd-agent:8080`（生产镜像端口）。若分支网络别名与项目 slug 不一致需核对 | 边缘功能；主链路（API 服务）不受影响 |
| 8 | **极速版只省编译,不省运行时容器** | express 省掉的是 CDS 本机「编译」算力,但部署仍会 `docker run` 拉起运行时容器(api dotnet + admin serve)。在**已饱和的共享 CDS 宿主**上,首次 `docker pull` 大镜像(api ~数百 MB)的 I/O + 新容器内存,仍可能把宿主压到 CDS 控制台无响应。2026-06-23 实测一次:express 部署后 ~12:23 生产 CDS 控制台 healthz=000,约 1h 后恢复。**注意**:镜像首拉是一次性重 I/O,之后本地缓存命中,re-deploy 只 `docker run`(轻)。 | 共享宿主容量是独立于「编译卸载」的另一根轴;高负载实例上首拉大镜像前建议先看 `docker stats` / 停闲置分支。后续可考虑:拉取限流 / 拉取与运行分离 / 宿主容量预检 |
| 9 | **早到 workflow_run 缓存是进程内** | push 延迟/重试导致 `workflow_run.completed` 早于 push 到达时,结果暂存在 dispatcher 的 `recentCompletedRuns`(Map,1h TTL/200 上限/一次性消费),push 置 express-waiting 时认领。**残留**:若 CDS 在「workflow_run 缓存」与「后续 push」之间重启,缓存丢失 → 分支仍会卡在 waiting,需再 push 或对失败 run 点 re-run 恢复。绝大多数竞态在秒级内完成,重启恰好插在中间概率极低。 | 进程内缓存够用;若要彻底持久化可把 completed-run 落 state(成本/收益不划算,暂不做) |

## 验证状态（2026-06-23 生产实证）

- CDS 后端 `pnpm tsc --noEmit` 零错误；web `pnpm tsc --noEmit` 零错误。
- 新增 `tests/services/ci-prebuilt-express.test.ts`（13 用例）全绿：镜像模板解析、prebuilt 模式生效、
  **express 无 command 时 effective.command 为空（走镜像 ENTRYPOINT）**、workflow_run head_sha 匹配、
  push→waiting、非预构建工作流忽略。回归：compose-parser / container / github-webhook-dispatcher / github-webhook(route) 全绿。
- **端到端生产实证（铁证）**：CI 三次 run 最终 `98562a05` 两镜像 green 推 ghcr → self-update 生产 CDS 到本分支
  → 导入 express 模式到 prd-agent 项目 → 分支设 express → 部署。`workflow_run` webhook **自动触发过部署**
  （ciImageStatus waiting→ready）；直连预览 `…/api/v` 返回 `{commit:98562a05, environment:Production,
  buildTimeUtc:2026-06-23T12:11:54Z}` —— 证明 API 跑的是 **CI 预构建镜像、经 ENTRYPOINT 启动、CDS 零编译**。
- 真 bug 修复：express 无 command 原会继承 baseline 源码命令 → 预构建镜像里无 SDK/源码必失败；改为置空走
  ENTRYPOINT（commit `98562a05`，先于实证修掉）。
- 边界 #8（宿主容量）见上：实证过程中触发过一次共享 CDS 控制台短时宕机,已恢复。

## 已偿还（paid）

（暂无）
