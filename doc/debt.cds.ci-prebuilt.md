# CDS 极速版（CI 预构建） · 债务台账

> **版本**：v1.1 | **日期**：2026-07-10 | **状态**：开发中

**一句话**：把编译从部署服务器卸载到持续集成、按提交拉镜像跑的方案，本文记它的已知边界与验证状态。
**谁该读**：关心构建耗时的人；接手这条链路的工程师。
**读完能做什么**：判断极速版当前能用到什么程度，以及还差哪些验证。

---

## 总览

把「编译」从 CDS 服务器卸载到 GitHub Actions：push → CI 按 commit SHA 编译成 ghcr 镜像 →
CDS 收 `workflow_run.completed` 后 `docker pull` + run（跳过本机编译）。在现有「热加载 / 发布版」
之外新增第三种部署模式「极速版（CI 预构建）」。旧源码编译模式全部保留兼容。


SSOT 约定：镜像 tag = `sha-${github.sha}`（完整 40 hex，不可变）。CI 推什么 tag、CDS 拉什么 tag，
两边走同一公式（CI `docker/metadata-action`  CDS `resolveImageTemplate` / `slugifyBranchForImage`）。

---

## 已知边界 / 待补（open）

| # | 债务 | 说明 | 影响 |
|---|------|------|------|
| 1 | ghcr 包需手动设为 public | 首次 push 后 `prdagent-server` / `prdagent-admin` 两个包默认 private，需在 GitHub Packages 设置里改 Public，CDS 才能匿名 `docker pull`。否则极速版部署报「镜像拉取失败」 | 一次性 ops；未设则极速版不可用，分支显示「CI 构建失败」可切回源码 |
| 2 | 工作流名硬编码 | CDS 只认 `branch-image.yml` / name `Branch Image` 的 workflow_run（避免 ci.yml 等先完成误触发）。常量在 `github-webhook-dispatcher.ts` 的 `CI_PREBUILT_WORKFLOW_FILE/NAME` | 泛化到任意 public 仓库时需做成 project 级配置 |
| 4 | 极速版仍 git pull worktree | 部署时未跳过 `worktreeService.pull`（仅跳过编译）。pull 是廉价 git fetch，且保留 worktree 同步利于「切回源码编译」兜底；真正的重负载（编译）已由 prebuiltImage/skipSrcMount 消除 | 轻微冗余，不影响目标（卸载编译算力） |
| 5 | 构建时延（分钟级） | push → 预览就绪比源码热加载慢出现（要等 CI 构建）。等待期分支卡有「等待 CI 镜像」徽章（非静止），符合预期管理 | 体验取舍：省 CDS CPU 换首次时延 |
| 6 | 「切回源码编译」非一键 | 失败态徽章的「切回源码编译」打开分支详情抽屉，由现有部署模式下拉切回 source 模式（已可用），未在卡片做单击直切 | 能力已存在，仅少一步快捷 |
| 7 | ClaudeSdkExecutor 回调端口 | express 模式 env 覆盖 `ClaudeSdkExecutor__CallbackBaseUrl` 为 `http://api-prd-agent:8080`（生产镜像端口）。若分支网络别名与项目 slug 不一致需核对 | 边缘功能；主链路（API 服务）不受影响 |
| 8 | **极速版只省编译,不省运行时容器** | express 省掉的是 CDS 本机「编译」算力,但部署仍会 `docker run` 拉起运行时容器(api dotnet + admin serve)。在**已饱和的共享 CDS 宿主**上,首次 `docker pull` 大镜像(api ~数百 MB)的 I/O + 新容器内存,仍可能把宿主压到 CDS 控制台无响应。2026-06-23 实测一次:express 部署后 ~12:23 生产 CDS 控制台 healthz=000,约 1h 后恢复。**注意**:镜像首拉是一次性重 I/O,之后本地缓存命中,re-deploy 只 `docker run`(轻)。 | 共享宿主容量是独立于「编译卸载」的另一根轴;高负载实例上首拉大镜像前建议先看 `docker stats` / 停闲置分支。后续可考虑:拉取限流 / 拉取与运行分离 / 宿主容量预检 |
| 9 | **早到 workflow_run 缓存是进程内** | push 延迟/重试导致 `workflow_run.completed` 早于 push 到达时,结果暂存在 dispatcher 的 `recentCompletedRuns`(Map,1h TTL/200 上限/一次性消费),push 置 express-waiting 时认领。**残留**:若 CDS 在「workflow_run 缓存」与「后续 push」之间重启,缓存丢失 → 分支仍会卡在 waiting,需再 push 或对失败 run 点 re-run 恢复。绝大多数竞态在秒级内完成,重启恰好插在中间概率极低。webhook **完全**漏投（而非早到/晚到）的场景不在本条覆盖，见 #11 手动恢复路径。 | 进程内缓存够用;若要彻底持久化可把 completed-run 落 state(成本/收益不划算,暂不做) |
| 10 | **managed 本地产物不能跨执行器搬运** | managed 源码构建通过临时容器完成 install/build，再以 `sha-*` 标签 `docker commit` 为当前执行器上的不可变本地镜像。分支粘性调度下重复部署与回滚可直接复用；若执行器迁移、故障或本地镜像被清理，目标节点不存在该产物。 | 当前明确返回“本地产物不存在”，要求重新源码构建，不伪装成可拉取镜像。后续可选方案是推送 Registry 并按 digest 分发，或实现执行器间产物复制。 |
| 11 | **webhook 完全漏投时需要手动恢复** | `workflow_run` webhook 若整条丢失（非早到/晚到，是压根没送达），分支会一直卡在旧 `ciTargetSha`/`ciImageStatus=waiting`，即使对应 commit 的 `Branch Image` 已在 GitHub Actions 构建成功。已提供运维兜底：`POST /branches/:id/prebuilt-image/claim`（`cds/src/services/prebuilt-image-claim.ts` + `branches.ts:10782`，校验 40 位 SHA + `branchUsesPrebuiltMode`，支持 `dryRun`）与 CLI `cdscli branch claim-prebuilt <id> --commit <sha> [--workflow-url] [--dry-run] [--deploy]`：运维在 Actions 页确认目标 commit 构建成功后手动把 `githubCommitSha/ciTargetSha/ciImageStatus` 标记 `ready`，`--deploy` 认领后立即按同一 commit 触发部署。 | 需要人工判断「哪个 commit 真的构建成功了」再执行认领；未做自动检测漏投并自愈。**2026-07-28 同日命中两次**（`ed72bfa` / `669792f`，均为只改 `cds/**` 的提交）：投递台账显示 push 已置 waiting，但该 sha 的 `Branch Image` completed 事件整条没送达，15 分钟看门狗按预期翻 failed 并在 PR 上留下红灯 —— 护栏工作正常，缺的是**主动补查**。现象特征：这类提交的 `Branch Image` 全部 image job 被 path-filter 跳过，工作流约 15 秒即完成，完成得越快越容易与 push 处理重叠，值得作为自愈优先级的判据。自愈方向：看门狗翻 failed 前先调一次 GitHub API 查该 sha 的 workflow runs（与 `CheckRunRunner.reconcileStale` 同款「不只依赖 webhook」的收敛思路），查到成功即自行认领，查不到再翻红。 |

| 12 | **`/api/v` 报的 commit 是环境变量，不是二进制真身** | 版本端点读的是容器启动时注入的 `GIT_COMMIT` / `CDS_COMMIT_SHA` 环境变量（`Program.cs` 的 `FirstEnv`），而这些值来自分支当前 commit；镜像本身在极速版下用的是可变 tag。于是「CI 镜像还没就绪、容器仍跑旧镜像」时，`/api/v` 依然报最新 commit。2026-08-04 实测：`shortCommit` 显示新 commit、`buildTimeUtc` 却早于该 commit 的提交时间，而新增的路由在容器里根本不存在。 | 任何「看 `/api/v` 确认新代码上线了」的验收都可能被骗。当前可靠判据是 `branch status` 的 `lastDeployDispatchCommitSha`（真实派发的 commit）与 `ciImageStatus`。自愈方向：把 commit 在构建期烤进镜像（Dockerfile ARG → 编译期常量），运行期 env 只作兜底并在两者不一致时于端点里显式标注 |

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

---

## 已结清（供回溯）

下列条目台账里已自己标记为解决/交付，移到文末只为让上文只剩未还的账；内容原样保留。

### 已知边界 / 待补（本节的行均已偿还）

| # | 债务 | 说明 | 影响 |
|---|------|------|------|
| 3 | ~~每次 push 构建两镜像~~（已改为 path-filter，2026-06-23） | **已偿还**：改为 `dorny/paths-filter` 只构建改动组件（`prd-api/**`→api、`prd-admin/**`→admin），不再重复构建。某 commit 缺某组件镜像时，runService 走 `DeployModeOverride.fallbackImage` **有序回退链**：① `:branch-<slug>`（本分支该组件最近一次构建，保住本分支已有改动）② `:branch-main`（本分支从未构建过该组件时退到主分支）。避免「A 改 api、B 只改 admin」部署 B 把 api 直接退 main 丢掉本分支 A 的 api 改动。三种缺镜像场景均由回退链兜底，预览不硬失败 | 回退链写在 cds-compose `fallbackImage`（数组）；新仓库接入需同步配置；`:branch-<slug>` 依赖 CI 的 `type=ref,event=branch` 移动 tag 与 CDS slugify 一致 |

---

## 实现来源

给要跳去看代码的人；只读这篇文档的人可以整块跳过。

| 位置 | 文件 |
|------|------|
| 总览 | `.github/workflows/branch-image.yml`、`cds-compose.yml`、`cds/src/services/{container,deploy-runtime,github-webhook-dispatcher,state,branch-events}.ts`、`cds/src/routes/{branches,github-webhook}.ts`、`cds/web/src/pages/BranchListPage.tsx`、`cds/src/services/compose-parser.ts` |
