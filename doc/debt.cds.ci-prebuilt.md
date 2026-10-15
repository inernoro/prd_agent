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
| 13 | **极速版没有静态前端的运行期配置注入** | 来源 #1437（2026-08-28，2026-09-08 吸收进本台账后关闭）。极速版对前端镜像只做「prebuilt 跳过 source mount」，平台按分支注入的只有 `VITE_GIT_BRANCH` / `VITE_BUILD_ID` 两个元数据，没有「容器启动时把分支级配置渲染成静态产物（如 `__APP_CONFIG__` 或 `/usr/share/nginx/html/config.js`）」的能力。于是凡是把 API 地址、子域等配置烤进构建产物的前端（mdimp 三个前端即如此），只能留在宿主机源码编译，占掉构建槽，是分支抖动主因之一 | prd-agent 自身前端不受影响。要做需要两边同时动：CDS 平台侧新增启动期配置渲染（建议照 env-provenance 的分支注入口径产出一份机读配置文件），应用侧改成运行期读取。验收方在 mdimp 仓库，prd-agent 单方做不完闭环，故记账不排期 |
| 12 | **网关侧两个服务的版本自述仍是单值** | 网关控制台与网关引擎的镜像只把 commit 写进环境变量，容器启动时会被平台同名注入覆盖，其健康端点因此只能反映「部署希望跑哪版」而不是「实际跑哪版」——与主 API 在 2026-08-04 修掉的是同一个坑。未一并修的原因：对账逻辑目前放在主后端的公共库里，跨解决方案复用需要先定共享方式，宁可显式留尾也不半接线 | 对这两个服务判断「新代码上线了吗」仍可能被骗，可靠判据同样是 CDS 记录的实际派发 commit。修法照抄主 API：构建阶段把 commit 烤进程序集，端点分列实际值与期待值并当场对账 |
| 14 | **极速版门禁覆盖面未核实到 import-and-init / copy-config-from** | 「Agent 只允许极速版部署」门禁（见「已偿还」）覆盖了部署、模式覆盖、构建配置写入等主要入口，但项目初始化时的 `import-and-init`、跨分支拷贝配置的 `copy-config-from`，以及「机器自建 prebuilt 配置」这条路径，尚未逐一核实是否落在门禁判定范围内 | 若这些入口能落到源码编译且不经门禁判定，机器凭据仍可能绕开「只允许极速版」的项目设置 |
| 15 | **main 镜像尚未发布时的借用窗口**（2026-09-30，PR #1650 review） | `branch-image.yml` 的 `main_drift` 步骤拿「本提交」与 `origin/main` 的树比，决定分支没改的组件要不要建本提交镜像。若分支建在 main 最新提交之上、又多了自己的提交，而 main 那一版的镜像还在发布途中，没改的组件判为「与 main 一致」不建镜像，CDS 却只能借到**上一版** `branch-main`，`proveFallbackImage` 比出差异拒绝借用，部署红掉。分支头**恰好等于** main 时不受影响（`main_equivalence` 会补齐全部镜像）。这个窗口在 `main_drift` 之前就一模一样存在，不是它引入的 | 窗口期内部署失败，main 镜像发布完后重新部署即恢复。彻底堵住要把比较基准换成「`branch-main` 镜像里实际嵌的提交」（查镜像标签），或在 main 镜像未就绪时保守构建——都是新的判据来源，另行排期 |

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

| 债务 | 偿还方式 |
|------|----------|
| **版本端点报的 commit 是环境变量、不是二进制真身**（2026-08-04） | commit 改为在构建阶段烤进程序集，成为运行时改不掉的**实际值**；环境变量注入的那个降格为**期待值**，只代表本次部署希望跑哪版。版本端点同时给出两者并当场对账，不一致时直接在响应里告警。纯函数判定 + 守卫用例锁死「事故那组值必须判不一致」「缺任一边只能判未知，不许乐观放行」。原则已升级成通用规则的一节，覆盖所有「我是哪一版 / 我连哪个上游」类自述 |
| **无法强制 Agent 只走极速版部署**（2026-09-08） | 新增项目级门禁「Agent 只允许极速版（CI 预构建）部署」（默认关闭，只能由真人开关）。开启后，机器凭据（AgentApiKey）发起的部署、分支模式覆盖、项目默认部署模式写入，只要最终会落到源码编译，一律 409 `agent_prebuilt_only` 拒绝；镜像拉取失败时也不再静默回退源码编译。判据按「实际生效模式」而非「声明的模式名」算，覆盖单服务部署、通用构建配置 PUT、项目默认模式、bulk 批量改模式、远端执行器派发等多个入口——上线后经过多轮复核，陆续堵住了「镜像拉不到时回退源码」「可伪造的内部豁免头」「显式空串覆盖被判成继承基线」「版本重放误判」等绕过路径。cdscli 同步在 `profile list` 里暴露 `prebuiltModes`/`deployRuntime.prebuilt`，供 Agent 按标志而非模式名识别极速版。**已知边界**：`import-and-init`、`copy-config-from` 两个入口以及「机器自建 prebuilt 配置」路径尚未纳入门禁覆盖核实，见「已知边界 / 待补」新增行 |

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
| 版本双值对账 | `prd-api/Dockerfile`（build 阶段 `ARG GIT_COMMIT` + `-p:SourceRevisionId`）、`prd-api/src/PrdAgent.Core/Diagnostics/BuildIdentity.cs`、`prd-api/src/PrdAgent.Api/Program.cs` 的 `VersionInfo`、`prd-api/tests/PrdAgent.Tests/BuildIdentityTests.cs`、`.claude/rules/config-runtime-drift.md` 第三点五节；未覆盖项：`llmgw/console-api/Dockerfile`、`llmgw/serving/Dockerfile` |
| 总览 | `.github/workflows/branch-image.yml`、`cds-compose.yml`、`cds/src/services/{container,deploy-runtime,github-webhook-dispatcher,state,branch-events}.ts`、`cds/src/routes/{branches,github-webhook}.ts`、`cds/web/src/pages/BranchListPage.tsx`、`cds/src/services/compose-parser.ts` |

## 2026-10-15 部署排队与中断复查

实际运行版本的三个验收部署已结束，不能继续称为排队中：文件和画布部署被心跳收割器判中断；问答部署仅部分服务启动，其他服务等待超时。同期源码构建闸为空、CPU 未饱和，启动阶段却因内存余量排队，并保留十六项历史启动预约。容量保护本身不能通过提高上限或停止其他项目来绕过。

当前恢复候选分别处理：失败运行与执行资格同步结束；合法阶段排队保留原二十分钟截止，不伪造心跳；迟到就绪及错误结果不得覆盖后继；启动时只读核对历史预约，未知身份或创建结果继续保留。单元与本地 HTTP 红绿回归不代表共享 CDS 已恢复，只有实际版本切换、目标部署完成、公网入口及功能闭环证据齐备后才能关闭本次故障。

独立未关闭项：增量构建允许未变组件没有目标提交镜像，但当前产物准入在等价复用前就拒绝该组件；消费端和远端回执还有第二次精确提交检查。已有跨模块反例，不能靠每次全量构建消账。后续须在准入、实际启动与回执中使用同一等价证明，固定真实镜像摘要和平台，保留镜像实际提交与目标提交的区别；缺证明保持等待，不冒充目标版本。当前三个业务候选已有完整固定镜像，先恢复启动链路，不借本次窄修复宣布这一独立契约缺口已解决。

同日上午共享控制面由其他维护任务快进至新版本后，十六项旧观察已不能代表当前截面：实际有五十七份历史预约、十二项启动等待，原因全部变为CPU启动容量。历史容量责任被等同为本进程仍在启动，低负载下也会阻塞。当前候选将两者分开：未知运行仍保留内存/PID责任，新启动仍按真实负载限流并持续计到就绪；不将历史状态伪装为就绪，不清除实际容器。

同一生命周期的远端边界也必须覆盖：Master本机没有的等待不能被虚构为本机队列；执行器只能回传原操作与代次下、保留原截止时间的真实等待事实，过期事实不豁免。原远端响应在资格失效后不得回写后继路由、状态和版本。当前修复与实际共享恢复仍分别记账，未有固定提交真实部署证据前保持未关闭。

远端等待保证要求对应执行器也运行支持该回执的版本；旧执行器没有原代次和真实排队证明时，不提供永久豁免。等待事实仅在当前进程内短时有效，重启不恢复或续写截止；远端实际节点未覆盖的场景仍需独立验收，不以本地Docker替身测试冒充完成。

### 2026-10-15 范围熔断后的收窄决定

以上远端候选说明保留为历史，不代表本包继续交付远端恢复。本包撤出新增远端等待及专属回写增量，只交付归属可确认的本节点恢复。运行与当前分支都必须属于本节点、项目一致，且仍持有原操作和代次的精确作用域，才可保留有界阶段等待或回收超时执行资格；不明归属只沿用原超时失败记账，不释放无法撤销的远端执行资格。

远端两项直接缺陷继续未关闭：[原代次撤销与独立心跳围栏](https://github.com/inernoro/prd_agent/pull/1695#discussion_r4278945627)、[跨节点等待时钟](https://github.com/inernoro/prd_agent/pull/1695#discussion_r4278945630)。后续独立工作包须同时证明远端执行确实失去资格、旧心跳不能覆盖后继、原等待总期限和回执新鲜度不依赖跨机墙钟。当前没有远端节点不是通过证据，本次本机恢复和业务验收也不能关闭这两项。

### 2026-10-15 本节点清理等待的资格接线复查

[清理排队后仍可迟到删除](https://github.com/inernoro/prd_agent/pull/1695#discussion_r4279152457)已由真实本地路由反例确认：旧部署在清理槽等待时被收割，后继取得资格后，旧队列仍能发出删除。候选修复让本节点部署的清理全程携带原操作、代次及资格检查；有效等待仍受原二十分钟上限约束，超时撤销后不能再准入，不通过伪造心跳保活。红绿回归只证明候选行为，实际共享版本、部署及公网业务验收仍需单独取证。

独立未关闭边界：旧配置导入初始化及远端维护入口并未取得上述本节点部署租约，不在本次修复中伪造同一运行身份；终止类维护清理也不借本次扩为新授权或取消协议。相关入口若需统一可恢复部署资格，须在独立工作包补齐受理、取消、持久化与验收合同；现有删除身份及后继保护不变。

### 2026-10-15 增量镜像准入独立修复候选

本候选单独处理上文的增量产物契约缺口：仅在目标镜像确实不存在时尝试已配置的同仓库候选，实际镜像提交与目标提交不同则必须证明完整构建输入没有变化。Master不信任远端布尔声明，执行器部署前和容器启动前均重新核对；镜像摘要、平台与实际提交仍以执行节点事实为准，运行环境和版本展示不得把旧镜像改称目标版本。部署版本保存当时的构建范围，重放不得借用后来收窄的配置。

边界仍为未完成的真实环境验收：本候选尚未发布，定向测试与本地HTTP替身不关闭线上缺口。历史提交缺失、构建范围缺失、比较能力不可用、鉴权或平台异常均继续等待或拒绝，不自动全量构建、不回退源码编译。旧版本快照未保存构建范围时，只允许实际提交正好等于该目标的产物；无法证明的跨提交复用不能用当前配置补齐。现有普通部署受理后的独立源码准备仍保留，属于原债务第4项，不是本包新增构建兜底。远端原代次撤销与跨节点等待时钟两项不由本包处理或关闭。
