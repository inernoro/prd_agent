// ── Cloud Development Suite (CDS) — Core Types ──

import type { SealedSecret } from './infra/secret-seal.js';

/** A routing rule that maps incoming requests to a branch */
export interface RoutingRule {
  id: string;
  /**
   * Project this rule belongs to. PR_B.1 起为必填 — migrateProjectScoping()
   * 启动时把所有 pre-P4 规则补齐到 legacy project 的真实 id（不再硬编码
   * 'default'，会跟随 project rename 自动更新）。
   */
  projectId: string;
  /** Human-readable name */
  name: string;
  /** Match type: header (X-Branch), domain substring, or pattern */
  type: 'header' | 'domain' | 'pattern';
  /**
   * Match value. Supports {{wildcard}} placeholders:
   *   - {{agent_*}}  → matches "agent-xxx", "agent-yyy", etc.
   *   - {{feature_*}} → matches "feature-xxx", etc.
   * For 'header' type: matched against X-Branch header value
   * For 'domain' type: matched against request Host header
   * For 'pattern' type: matched against full URL path
   */
  match: string;
  /** Target branch slug (resolved at runtime) */
  branch: string;
  /** Priority (lower = higher priority, default 0) */
  priority: number;
  enabled: boolean;
}

/** A build profile defines how to build/run a specific type of project */
export interface BuildProfile {
  id: string;
  /**
   * Project this profile belongs to. PR_B.1 起为必填 — migrateProjectScoping()
   * 启动时把所有 pre-P4 profile 补齐到 legacy project 的真实 id。
   */
  projectId: string;
  name: string;
  /** Docker image to use for building/running */
  dockerImage: string;
  /** Working directory relative to worktree root (derived from volume mount host path) */
  workDir: string;
  /** Working directory inside the container (from compose `working_dir`, default: '/app'). */
  containerWorkDir?: string;
  /**
   * Full command to start the service.
   * Example: "dotnet restore && dotnet build && dotnet run --urls http://0.0.0.0:5000"
   */
  command?: string;
  /** Port the service listens on inside the container */
  containerPort: number;
  /** Extra environment variables for this profile (may contain ${CDS_*} template references) */
  env?: Record<string, string>;
  /** Volume mounts for shared caches (e.g., node_modules, nuget) */
  cacheMounts?: CacheMount[];
  /** Timeout for build in ms (default: 600000) */
  buildTimeout?: number;
  /**
   * URL path prefixes this profile handles (e.g., ["/api/", "/graphql"]).
   * Used by the proxy to route requests to the correct service within a branch.
   * If not set, falls back to convention: profile id containing "api" handles /api/*.
   * Derived from compose labels: `cds.path-prefix`.
   */
  pathPrefixes?: string[];
  /**
   * Service dependencies — IDs of infra services or other profiles this app depends on.
   * Derived from compose `depends_on`. Used for startup ordering.
   */
  dependsOn?: string[];
  /**
   * Readiness probe — HTTP check to determine when the service is truly ready to serve.
   * Without this, CDS only checks that the container process is alive (liveness).
   * Derived from compose label `cds.readiness-path`.
   */
  readinessProbe?: ReadinessProbe;
  /**
   * Startup signal — a string pattern to watch for in container stdout/stderr.
   * When this pattern appears in the logs, the service is considered successfully started.
   * Example: 'API listening on: ["http://0.0.0.0:5000"]' for .NET, 'Network:' for Vite.
   * Takes priority over readinessProbe when set.
   */
  startupSignal?: string;
  /**
   * Deploy mode alternatives. Each key is a mode ID (e.g., "dev", "static").
   * When activeDeployMode matches a key, its overrides replace profile defaults.
   * Derived from compose extension `x-cds-deploy-modes`.
   */
  deployModes?: Record<string, DeployModeOverride>;
  /**
   * Currently active deploy mode. null/undefined = use profile defaults (first mode or raw command).
   */
  activeDeployMode?: string;
  /**
   * Per-container cgroup limits (Phase 2 of resilience plan).
   * When set, `docker run` gets `--memory <N>m` and/or `--cpus <N>` flags.
   * Unset = no limit (legacy behavior).
   *
   * Derived from compose `deploy.resources.limits` or `x-cds-resources`.
   */
  resources?: ResourceLimits;
  /**
   * 2026-04-22 新增 —— 热更新（Hot Reload）配置。
   *
   * 启用后 CDS 不再每次改代码都重建镜像 + 重启容器；而是：
   *   - 容器里跑 `dotnet watch run` / `pnpm dev` / `vite --host` 等「监听源码」的命令
   *   - 源码目录以 rw 绑挂到 /app（正常启动时也是这样挂，但 hotReload 会用 watch 命令）
   *   - 代码变更 → inotify 触发热编译 → 无需重启容器，秒生效
   *
   * 仅适合开发环境。生产环境永远用编译好的镜像运行。
   * UI 上带高亮标识提醒用户。
   */
  hotReload?: HotReloadConfig;
  /**
   * 2026-05-01 Phase 7(B10)新增 —— Docker entrypoint 覆盖。
   *
   * 默认(undefined):docker run 不传 --entrypoint,容器走 image 自带 ENTRYPOINT。
   * 适合大部分应用 — 用户 command 作为 CMD 走完 ENTRYPOINT 后被执行。
   *
   * 指定字符串:`docker run --entrypoint "<entrypoint>"`,**完全覆盖** image
   * 自带 ENTRYPOINT。适合预构建镜像里 ENTRYPOINT 是 wrapper 脚本(自跑
   * setup / migration / 自定义 wait-for)且和 CDS 部署模式不兼容时。Twenty CRM
   * 实战暴露:image entrypoint 自跑 psql,在 db ready 前抢跑,容器 exit 2。
   * **支持的取值**(Bugbot fix PR #521 第十三轮 Bug 3 — Docker --entrypoint 只接受单 token):
   *
   * - `""` 空字符串(最常用):清空 image 自带 ENTRYPOINT,CDS 默认会
   *   `sh -c "command"` 包装应用 command,直接绕过 image 的 wrapper。
   * - `"sh"` / `"node"` 等单 token:覆盖为该可执行文件。
   *
   * **不支持** `"sh -c"` 这种多词形式 — Docker 会查找字面名为 "sh -c"
   * 的文件,启动失败 "executable file not found"。如果要"用 sh -c 包装",
   * 直接设 `cds.entrypoint: ""` 即可,CDS 默认就是这么做的。
   *
   * 设置来源:cds-compose 的 `cds.entrypoint` label。
   *
   * 例:
   *   labels:
   *     cds.entrypoint: ""   # 清空 image wrapper(典型用法,Twenty CRM 实战)
   */
  entrypoint?: string;
  /**
   * 2026-05-01 Phase 7(B17)新增 —— 预构建镜像模式标记。
   *
   * 默认(undefined / false):传统模式 — 把项目仓库的 workDir 挂到
   * containerWorkDir(为"开发预览 + 源码 bind mount + 容器内 build/run"
   * 模式设计)。Vite/.NET/Node 应用走这个。
   *
   * true:预构建镜像模式 — image 已含编译产物,**不要**挂仓库 workDir 到
   * containerWorkDir(否则会覆盖 image 里的应用文件,导致 module not found)。
   * 用于 twentycrm/twenty / sentry / cal.com 等开源项目的"docker pull + run"
   * 部署模式。
   *
   * cds-compose 中通过 `cds.prebuilt-image: "true"` label 触发。
   *
   * 影响:
   *   - container.ts runService 跳过 srcMount,只挂 cacheMounts(named volume 等)
   *   - 应用所有文件来自 image,workDir/cds-marker 仅给 CDS app 识别用,不影响运行
   */
  prebuiltImage?: boolean;
  /**
   * 2026-06-23 极速版「逐组件回退」新增 —— 预构建镜像缺失时的**有序回退链**（解析后）。
   * 由 DeployModeOverride.fallbackImage 经 resolveEffectiveProfile 解析模板得到。
   * runService 在 `docker pull dockerImage` 失败时按数组顺序逐个回退,第一个拉到的即用。
   */
  fallbackImage?: string | string[];
  /**
   * 2026-06-24 极速版自动回退源码编译新增 —— **运行期字段,不持久化**。
   * 由 resolveEffectiveProfile 在解析出 prebuilt(极速版) profile 时,**从 baseline**
   * 额外解析出一个源码编译 profile 挂在这里(dockerImage=源码基础镜像如 dotnet-sdk/node,
   * command=源码构建命令,prebuiltImage=false)。runService 在极速版镜像全部拉不到时,
   * 直接切到这个已正确解析的源码 profile,避免「从极速版 profile 原地切换」误继承 sha
   * 镜像/8080 端口(那是 bug)。无源码模式可回退时为 undefined。 */
  sourceFallbackProfile?: BuildProfile;
  /**
   * 2026-05-01 Phase 5 新增 —— 多分支数据库隔离策略。
   *
   * 'shared'(默认):所有分支共用一个数据库实例 + 一个 database name。
   *   优点:省 disk,跨分支跑 e2e 测试时数据可见
   *   缺点:多分支同时跑 migration 可能互相打架,A 分支删表 B 分支炸
   *
   * 'per-branch':每个分支用独立 database name(同一个 mysql/postgres 实例下),
   *   通过自动后缀 branchSlug 实现:`MYSQL_DATABASE: app` → 容器实际收到 `app_<branch_slug>`。
   *   优点:分支完全独立,migration / 数据互不干扰
   *   缺点:每个分支首次部署都要重跑 migration + seed
   *
   * 自动后缀的 env key 列表(container.ts 内置):
   *   - MYSQL_DATABASE
   *   - POSTGRES_DB
   *   - MONGO_INITDB_DATABASE
   *   - MARIADB_DATABASE
   *   (后续按需扩展;不在列表内的 env key 不动)
   *
   * 注意:连接串(DATABASE_URL/MONGODB_URL 等)如果通过 ${MYSQL_DATABASE} 引用,
   * 会自动跟随后缀;如果硬编码了 `mysql://.../app`,需要用户手改成 `${MYSQL_DATABASE}` 引用。
   * cdscli scan 生成的模板默认走引用形式,无需手改。
   *
   * 历史:此机制属于 Phase 5(多分支 DB 策略),完成"任意 schemaful DB 项目接 CDS,
   * 多分支不互相破坏数据"的北极星目标。
   */
  dbScope?: 'shared' | 'per-branch';
}

/**
 * 2026-05-01 Phase 8 新增 —— env 三色 metadata。
 *
 * cdscli scan 时给每个 env 变量打标:
 *   - 'auto'          : cdscli 自动生成或自动给定(密码 / 默认值),用户无需管
 *   - 'required'      : 用户必须填写,deploy 前 block(SMTP_PASSWORD / OAUTH_SECRET 等)
 *   - 'infra-derived' : 引用 ${VAR} 由 CDS infra 推导(DATABASE_URL = mysql://${MYSQL_USER}:...)
 *
 * CDS 后端读 envMeta:
 *   - deploy 路由:任何 required 项的 value 为空 → 返回 412 Precondition Failed,
 *     payload 含 missingRequiredEnvKeys 列表
 *
 * CDS 前端读 envMeta:
 *   - 项目导入成功后弹窗:上面 required(必填,带输入框)/ 下面 auto + infra-derived
 *     (CDS 已搞定,可展开查看)
 *   - 必填项全填了 → enable deploy 按钮
 */
export interface EnvMeta {
  /** 三色分类。决定 UI 弹窗样式 + deploy block 行为 */
  kind: 'auto' | 'required' | 'infra-derived';
  /** 给用户的提示语,UI 弹窗里显示在 input 上方(如"请填写你的 SMTP 邮箱密码") */
  hint?: string;
}

/**
 * Phase 9.5 — env 修改审计条目。
 *
 * 每次 PUT /env 或 PUT /env/:key 时追加一条,记录"谁、何时、改了哪些 key"。
 * 不记 value(避免密钥泄漏到日志);只记 key 列表 + 操作类型。
 *
 * 用 ring buffer 限制 ≤ 200 条 / project,防止无限增长。
 */
export interface EnvChangeLogEntry {
  /** ISO 时间戳 */
  ts: string;
  /** 操作类型:set(新增/修改) / delete(删除) / bulk-replace(整体替换) */
  op: 'set' | 'delete' | 'bulk-replace';
  /** 涉及的 env key 名(密钥脱敏后的,只记 key 不记 value) */
  keys: string[];
  /** 用户标识 — 来自 cdscli auth 或 UI 用户。'unknown' 表示无认证上下文 */
  actor?: string;
  /** 来源:UI / cdscli / api(通用) */
  source?: 'ui' | 'cdscli' | 'api';
}

/**
 * 热更新配置。mode 决定用哪种 watcher 命令，enabled=true 时 CDS 启动容器时
 * 用 `hotReload.command` 代替 `profile.command`。
 *
 * 2026-04-22 补丁：从踩过的坑里总结出来的防御措施——
 *
 *   警告：MSBuild 的 incremental compile 和 dotnet watch 的 hot reload 在我们这个
 *     绑挂 worktree + 长驻容器的场景下有已知 bug：
 *
 *     现象：改代码 → publish/build 成功 → DLL 时间戳更新 → DLL 里 grep 得到新字符串
 *          → 但运行进程加载的还是旧字节码 → 日志里看不到新日志。
 *     根因：MSBuild 判定"项目引用未变"跳过 compile；或 dotnet watch hot reload
 *          只应用到内存没重启进程，导致 Infrastructure.dll 反复 5 轮不生效。
 *
 *   解决：默认改成 `dotnet-restart` —— 明确 kill 进程 + clean + no-incremental +
 *        重跑。放弃 hot reload 的"秒级生效"，换"每次生效"。
 *        原来的 `dotnet-watch` 保留为可选，但不再是 .NET 项目的推荐默认。
 *
 *   如果还不生效：点 Profile 卡片的「强制干净重建」—— 额外物理删掉 bin/obj，
 *   避免文件系统缓存干扰。
 */
export interface HotReloadConfig {
  /** 是否启用。即使配置了 mode/command，也要 enabled=true 才生效。 */
  enabled: boolean;
  /**
   * 热更新模式预设。
   *   dotnet-run     — 推荐默认（快）：纯 `dotnet run` 走 MSBuild 增量编译，文件变 → kill + 重跑。
   *                    相信 MSBuild 增量；绝大多数场景最快。如偶尔撒谎点清理按钮即可。
   *   dotnet-restart — 疑难兜底（慢）：每次 `dotnet clean` + `rm -rf bin/obj` + `--no-incremental`。
   *                    当 dotnet-run 稳定撒谎时才切过来；大多数人不需要。
   *   dotnet-watch   — `dotnet watch run`。**不推荐**：hot-reload 偶尔只改内存不重启进程
   *   pnpm-dev       — `pnpm dev`
   *   vite           — `vite --host 0.0.0.0 --port <port>`
   *   next-dev       — `pnpm next dev -p <port>`
   *   custom         — 用户自填命令
   */
  mode: 'dotnet-run' | 'dotnet-restart' | 'dotnet-watch' | 'pnpm-dev' | 'vite' | 'next-dev' | 'custom';
  /** 仅在 mode='custom' 时使用；其他 mode 下忽略。 */
  command?: string;
  /** 是否开启 polling（NFS / docker-on-mac 场景 inotify 不生效时）。默认 false。 */
  usePolling?: boolean;
  /**
   * dotnet-restart 模式下每次 rebuild 前是否先 `dotnet clean` + `rm -rf bin obj`。
   * 默认 true —— 就是为了根治"DLL 看起来更新了但没真重建"的 MSBuild 增量误判。
   */
  cleanBeforeBuild?: boolean;
}

/** Readiness probe configuration for app services */
export interface ReadinessProbe {
  /** HTTP path to check (e.g., "/health", "/api/health"). Default: "/" */
  path?: string;
  /** Seconds between checks (default: 5) */
  intervalSeconds?: number;
  /** Max seconds to wait for readiness (default: 300 = 5min) */
  timeoutSeconds?: number;
  /**
   * Phase 7 fix(B11,2026-05-01)— 跳过 HTTP probe,只跑 TCP liveness。
   * 用于后台 worker / job runner / 队列消费者等不监听 HTTP 的 service。
   * 当 true:
   *   - waitForReadiness 跳过 HTTP 阶段,容器只要 alive(waitForContainerAlive
   *     的 6 秒生死探活)即视为 ready
   *   - 不再 90 次 ECONNRESET 之后超时
   * 由 cds-compose 的 `cds.no-http-readiness: "true"` label 触发。
   */
  noHttp?: boolean;
}

/** A deploy mode override — alternative command/image/env for a build profile */
export interface DeployModeOverride {
  /** Human-readable label shown in dropdown (e.g., "开发模式", "静态部署") */
  label: string;
  /** Override command (replaces profile.command when this mode is active) */
  command?: string;
  /**
   * Override Docker image (replaces profile.dockerImage when this mode is active).
   *
   * 2026-06-23 极速版（CI 预构建）新增 —— 支持部署期模板变量,在
   * resolveEffectiveProfile 解析 branch 上下文时替换:
   *   - `${CDS_COMMIT_SHA}`  → branch.githubCommitSha（CI 按此 SHA 推镜像）
   *   - `${CDS_BRANCH_SLUG}` → 分支 slug（CI 的 branch-<slug> 移动 tag）
   * 例: `ghcr.io/inernoro/prd_agent/prdagent-server:sha-${CDS_COMMIT_SHA}`
   */
  dockerImage?: string;
  /** Extra/override environment variables merged on top of profile.env */
  env?: Record<string, string>;
  /**
   * 2026-06-23 极速版新增 —— 预构建镜像模式开关（对齐 BuildProfile.prebuiltImage）。
   * true 时本模式跳过 source mount,直接 docker pull + run 镜像里的编译产物
   * （CI 已编译好,CDS 不再本机编译,省服务器算力）。
   * cds-compose 中通过 `x-cds-deploy-modes.<svc>.<mode>.prebuilt: true` 触发。
   */
  prebuilt?: boolean;
  /**
   * 2026-06-23 极速版新增 —— 覆盖容器端口。预构建镜像监听端口通常与源码开发
   * 模式不同（如 prd-api 源码模式 5000,生产镜像 8080;prd-admin dist serve 8080）。
   */
  containerPort?: number;
  /**
   * 2026-06-23 极速版「逐组件回退」新增 —— 本 commit 没有该组件镜像时的**有序回退链**。
   * CI 按 path-filter 只构建改动的组件（不重复构建），所以某 commit 可能缺某组件镜像。
   * 按数组顺序逐个 docker pull,第一个拉到即用。推荐顺序（Codex P1: preserve prior branch
   * images when a component is skipped）:
   *   1. `:branch-${CDS_BRANCH_SLUG}` —— 本分支该组件最近一次构建（保住本分支已有改动,
   *      避免「A 改 api、B 只改 admin」时部署 B 把 api 退到 main 丢掉本分支 api 改动）。
   *   2. `:branch-main` —— 本分支从未构建过该组件时退到固定主分支镜像。
   * 单字符串视为只有一个回退。支持模板变量(${CDS_BRANCH_SLUG} 等)。
   */
  fallbackImage?: string | string[];
}

/**
 * Branch-level override for a BuildProfile. All fields optional — each unset
 * field inherits from the shared public BuildProfile. Lets a branch customize
 * its container runtime (image version, command, env, resources, deploy mode)
 * without touching the public baseline that other branches still share.
 *
 * Merge order at deploy time:
 *   baseline profile → branch override → deploy-mode override
 *
 * See the helper `resolveEffectiveProfile()` in services/container.ts.
 */
export interface BuildProfileOverride {
  /** Override Docker image (replaces baseline.dockerImage) */
  dockerImage?: string;
  /** Override run command (replaces baseline.command) */
  command?: string;
  /** Override container working directory */
  containerWorkDir?: string;
  /** Override container port (rare — only needed if app listens on a different port) */
  containerPort?: number;
  /**
   * Env vars merged on top of baseline.env. Override wins per-key, keys absent
   * here inherit from the baseline.
   */
  env?: Record<string, string>;
  /** Override path prefixes (replaces baseline list when set) */
  pathPrefixes?: string[];
  /** Override resource limits (replaces baseline.resources when set) */
  resources?: ResourceLimits;
  /** Override active deploy mode (lets a branch pick a different mode than the public default) */
  activeDeployMode?: string;
  /** Override startup signal (log pattern to wait for) */
  startupSignal?: string;
  /** Override readiness probe */
  readinessProbe?: ReadinessProbe;
  /** Free-form notes explaining why this branch needs the override */
  notes?: string;
  /** ISO timestamp of last update — set automatically by StateService */
  updatedAt?: string;
  /**
   * 2026-05-01 Phase 5 新增 —— 多分支数据库隔离策略覆盖。
   * baseline profile 通常用 'shared',个别分支(如要做大改的 main)可以
   * branchOverride 改成 'per-branch' 拿到独立 DB,避免污染 main。
   */
  dbScope?: 'shared' | 'per-branch';
  /**
   * 2026-05-01 Phase 7(B10)新增 —— Docker entrypoint 覆盖。
   * 见 BuildProfile.entrypoint 注释。允许个别分支临时改 entrypoint(如调试用)。
   */
  entrypoint?: string;
}

/** A shared cache mount to avoid duplicating packages across branches */
export interface CacheMount {
  /** Host path (absolute) for the shared cache */
  hostPath: string;
  /** Container path where it gets mounted */
  containerPath: string;
}

/**
 * Per-container resource limits enforced via Docker cgroup flags.
 *
 * Phase 2 of the CDS resilience plan: prevent a single runaway container
 * from draining the whole host. Configured via compose
 * `deploy.resources.limits` (standard) or `x-cds-resources` (our extension).
 *
 * See `doc/design.cds.resilience.md` Phase 2.
 */
export interface ResourceLimits {
  /**
   * Max memory in MB.
   *
   * 2026-05-06 起仅作 capacity 调度规划提示(见 capacityMessage),
   * **不再**下发为 --memory / --memory-swap docker 运行时硬限制。
   * 用户明确"每个容器都不限制内存,尽情释放"。
   */
  memoryMB?: number;
  /** Max CPU cores (fractional allowed, e.g. 1.5). Docker flag: --cpus <N> */
  cpus?: number;
}

/**
 * Heat state of a branch in the scheduler's warm pool.
 * - `hot`: running, ready to serve requests
 * - `warming`: being woken up (docker run in progress)
 * - `cooling`: being shut down (docker stop in progress)
 * - `cold`: containers not running, worktree preserved
 * - `undefined`: branch not managed by the scheduler (legacy / scheduler disabled)
 *
 * See `doc/design.cds.resilience.md` for the full state machine.
 */
export type BranchHeatState = 'hot' | 'warming' | 'cooling' | 'cold';

/**
 * 分支被删原因，决定 gone 页渲染哪种中间页：
 *  - 'merged'    PR 合并进主分支 → 引导用户切换到主分支预览
 *  - 'abandoned' PR 关闭未合并 / 分支被直接删除 → 告知已放弃，跳 PR/commit
 */
export type BranchRemovalReason = 'merged' | 'abandoned';

/**
 * 分支墓碑 —— 分支删除后留下的一条轻量记录，让"过期分支预览页"能区分
 * "已合并到主分支"（引导切主分支）与"已放弃/删除"（跳 PR/commit），
 * 不必保留整个 BranchEntry。写入点见 github-webhook 路由层 recordRemovedBranch。
 */
export interface BranchTombstone {
  /** 预览子域名 slug（gone 页查询主键，与 BranchTombstone 在 removedBranches 的 key 相同）。 */
  previewSlug: string;
  /** git 分支名（展示用）。 */
  branch: string;
  /** 所属项目 id。 */
  projectId: string;
  /** 删除原因。 */
  reason: BranchRemovalReason;
  /** 关联 PR 号（若由 PR 事件触发）。 */
  prNumber?: number;
  /** 关联 PR 的 GitHub 链接。 */
  prUrl?: string;
  /** 合并提交 SHA（reason='merged' 时由 PR payload 带出）。 */
  mergeCommitSha?: string;
  /** PR 的目标分支名（merged 时即合并进的分支，通常等于默认分支）。 */
  baseRef?: string;
  /** 记录当时解析出的项目默认分支名（"切换到主分支"按钮的目标分支）。 */
  defaultBranch?: string | null;
  /**
   * 分支 canonical id。gone 页对**自定义子域别名**访问时，proxy 的 extractPreviewBranch
   * 返回的是分支 id（或别名 label）而非 v3 previewSlug，主键查不到 → 用它兜底匹配。
   */
  branchId?: string;
  /** 分支的自定义子域别名（删除前快照）。别名访问 gone 页时用它兜底匹配墓碑。 */
  aliases?: string[];
  /** 记录时间（ISO）。容量淘汰按此排序。 */
  removedAt: string;
}

/** Branch entry — simplified for CDS */
export interface BranchEntry {
  id: string;
  /**
   * 该分支所属项目。PR_B.1 起为必填 — migrateProjectScoping() 启动时把
   * pre-P4 / 孤儿引用补齐到 legacy project 的真实 id。消费方不再需要
   * `b.projectId || 'default'` 兜底。
   */
  projectId: string;
  /** Original git branch name */
  branch: string;
  worktreePath: string;
  /** Per-profile container state */
  services: Record<string, ServiceState>;
  /**
   * Overall branch status.
   * `restarting` is a transient state entered when a container is being
   * hot-reloaded via `docker restart` without teardown — the proxy layer
   * treats it like `starting` (serves a loading page) so users never see
   * a 502 during the restart window.
   */
  status: 'idle' | 'building' | 'starting' | 'running' | 'restarting' | 'stopping' | 'error';
  errorMessage?: string;
  createdAt: string;
  lastAccessedAt?: string;
  /** User favorite flag — favorites are sorted to the top */
  isFavorite?: boolean;
  /** User notes — free-text annotation shown beside branch name */
  notes?: string;
  /** User tags — labels for filtering and categorization */
  tags?: string[];
  /** Color marker — marks branch as actively debugging, prevents priority stop */
  isColorMarked?: boolean;
  /** Pinned to a specific commit hash (detached HEAD). Cleared on next deploy. */
  pinnedCommit?: string;
  /** ID of the executor this branch is deployed on (scheduler mode) */
  executorId?: string;
  /** Dynamically allocated preview port (path-prefix routing proxy for port mode) */
  previewPort?: number;
  /**
   * Scheduler heat state. Set by SchedulerService; undefined when scheduler disabled.
   * See `doc/design.cds.resilience.md` §三.
   */
  heatState?: BranchHeatState;
  /**
   * User explicitly pinned this branch — scheduler must never evict it.
   * The default branch and color-marked branches are also treated as pinned implicitly.
   */
  pinnedByUser?: boolean;
  /**
   * Custom subdomain aliases for this branch. Each alias is a DNS label
   * (e.g. "paypal-webhook", "demo", "api-staging") that, when combined with
   * the configured `previewDomain`/`rootDomains`, routes traffic to THIS
   * branch in addition to its default `<slug>.<rootDomain>` subdomain.
   *
   * Use cases:
   *  - Stable URLs for third-party webhook receivers that can't be reconfigured
   *  - Memorable demo links ("demo.miduo.org" vs ugly branch slugs)
   *  - Front-end config pointing at hardcoded `api.miduo.org`
   *
   * Validation (enforced by routes/branches.ts PUT handler):
   *  - Each alias matches /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/ (DNS-safe)
   *  - No duplicates within the same branch
   *  - No collision with another branch's slug or aliases
   *  - Reserved labels (`www`, `admin`, `api-preview`, `switch`) are rejected
   *
   * Resolution is handled by `ProxyService.extractPreviewBranch()` — aliases
   * are checked BEFORE the default slug lookup, so an alias always wins.
   */
  subdomainAliases?: string[];
  /**
   * Per-branch overrides keyed by BuildProfile.id. Each entry extends (rather
   * than replaces) the shared public BuildProfile — unset fields inherit from
   * the baseline. Merged into the effective profile by `resolveEffectiveProfile`
   * at container start time.
   *
   * Absent / empty = pure inheritance (legacy behavior).
   */
  profileOverrides?: Record<string, BuildProfileOverride>;
  /**
   * GitHub Checks integration — populated when the branch was
   * auto-created by a webhook push or the user linked a repo to the
   * owning project. Used to post check-run status back to GitHub
   * (PR "Checks" panel) as the branch deploys.
   *
   * - `githubRepoFullName`: "owner/repo" copied from the project at
   *   webhook-dispatch time. Cached on the branch so a project re-link
   *   doesn't break ongoing check runs.
   * - `githubCommitSha`: the head SHA that triggered the current deploy.
   *   Required by GitHub's POST /check-runs.
   * - `githubCheckRunId`: the id returned by POST /check-runs so the
   *   deploy-complete path can PATCH the same run instead of creating
   *   a new one.
   * - `githubInstallationId`: the GitHub App install id that has write
   *   access to the repo. Cached so check-run updates don't need to
   *   walk back through the project record.
   */
  githubRepoFullName?: string;
  githubCommitSha?: string;
  /** Time when CDS last accepted a GitHub push/check metadata update for this branch. */
  lastPushAt?: string;
  /** Time when CDS last accepted/attempted to dispatch a deploy request. */
  lastDeployDispatchAt?: string;
  /** Commit SHA attached to the last deploy dispatch request. */
  lastDeployDispatchCommitSha?: string;
  /** Source that created the last deploy dispatch request. */
  lastDeployDispatchSource?: 'webhook' | 'manual' | 'system';
  /** Whether the last deploy dispatch was accepted by the deploy endpoint. */
  lastDeployDispatchStatus?: 'dispatching' | 'accepted' | 'failed' | 'interrupted';
  /** Failure reason when the deploy dispatch itself failed before deployment started. */
  lastDeployDispatchError?: string;
  /**
   * 2026-06-23：本轮 webhook 部署派发的**首次**派发时间（ISO）。与
   * lastDeployDispatchAt 不同——后者每次 reconciler 重试都会被刷新成最新
   * 重试时刻，导致「自派发以来的时长」永远归零、age 上限永不触发，正是
   * 「7 小时前的构建还在跑」幽灵的根因之一。本字段在 markWebhookDeployDispatch
   * 收到全新派发（新 commit / 上一轮已终态）时打戳，重试路径**不更新**，
   * 因此 reconciler 可以据此判断「这个派发已经太老，放弃重试」。
   */
  deployDispatchFirstAt?: string;
  /**
   * 2026-06-23：本轮 webhook 部署派发已被 reconciler 自动重试的次数。
   * 每次 dispatchRecoveredWebhookDeploys 真正重新 POST /deploy 时 +1；
   * markWebhookDeployDispatch 收到全新派发时归 0。达到上限
   * （CDS_DEPLOY_DISPATCH_MAX_RETRIES，默认 3）后不再重试，避免无限重试风暴。
   */
  deployDispatchRetryCount?: number;
  /** GitHub user login that triggered the latest webhook touching this branch. */
  githubSenderLogin?: string;
  /** Original GitHub avatar URL from webhook payload.sender.avatar_url. */
  githubSenderAvatarUrl?: string;
  githubCheckRunId?: number;
  githubInstallationId?: number;
  /**
   * 2026-06-23 极速版（CI 预构建）新增 —— CI 镜像就绪状态。
   *
   * 仅对走「极速版」部署模式的分支有意义。push 进来后 CDS 不立即本机编译,
   * 而是置 'waiting' 等 GitHub Actions 把该 commit 编译成 ghcr 镜像;CI 完成的
   * `workflow_run.completed` webhook 到达后:
   *   - conclusion=success → 'ready' → 触发 docker pull + deploy
   *   - 否则 → 'failed'（前端提示「CI 构建失败,可切回源码编译」,不自动回退）
   *
   * 非极速版分支不设此字段,行为不变（push 即本机编译）。
   */
  ciImageStatus?: 'waiting' | 'ready' | 'failed';
  /** 极速版正在等待 CI 构建的目标 commit SHA（用于 workflow_run 的 head_sha 匹配）。 */
  ciTargetSha?: string;
  /** 最近一次匹配到的 CI workflow_run 结论（success / failure / cancelled / timed_out …）。 */
  ciWorkflowConclusion?: string;
  /** 关联的 GitHub Actions run 页面 URL,前端「等待中 / 失败」态可一键跳转查看。 */
  ciWorkflowRunUrl?: string;
  /**
   * 进入极速版「等待 CI 镜像」态的时刻（ISO）。看门狗据此判定 waiting 是否超时
   * （等不到 workflow_run.completed —— 分支缺 branch-image.yml / CI 未运行 / 投递丢失）。
   * 缺省时看门狗退回 lastPushAt 计时。
   */
  ciWaitingSince?: string;
  /**
   * 极速版镜像未就绪的人类可读原因（看门狗超时或 CI 失败时写）。前端「CI 镜像未就绪」
   * 卡片展示此文案,替代过去把它误渲染成「容器停止 · 无记录」。
   */
  ciImageError?: string;
  /**
   * PR number this branch is associated with (via webhook `pull_request`
   * event). Populated when CDS first sees a PR opened/reopened from this
   * branch. Used so subsequent deploys can refresh the bot comment
   * instead of duplicating it.
   */
  githubPrNumber?: number;
  /**
   * Id of the Railway-style preview-URL bot comment posted on the PR.
   * Set when the first PR-opened event is handled and the comment is
   * created; on later push events the webhook dispatcher will PATCH the
   * same comment instead of creating a new one, so the PR thread stays
   * quiet.
   */
  githubPreviewCommentId?: number;
  /**
   * PR_C.1 起的分支级运营计数。与 Project 同名字段是项目维度汇总，
   * 这里是分支维度。所有字段 optional，未设视作 0。
   */
  deployCount?: number;
  pullCount?: number;
  stopCount?: number;
  /** 该分支被 AI agent 占用过的总次数。 */
  aiOpCount?: number;
  /** 该分支被标记 / 取消调试灯泡的总切换次数。 */
  debugCount?: number;
  /** 最近一次 AI 占用的 ISO 时间戳。 */
  lastAiOccupantAt?: string;
  /** 最近一次成功拉取代码的 ISO 时间戳。 */
  lastPullAt?: string;
  /** 最近一次成功部署完成的 ISO 时间戳。 */
  lastDeployAt?: string;
  /**
   * 2026-06-21：本轮 deploy/build 真正开始执行的 ISO 时间戳。
   * 在 status 切到 'building' 的那一刻打戳（branches.ts 两处部署起点）。
   * 用途：预览等待页 `/_cds/waiting-status` 的"已等待 / 预计还需"必须以
   * **本轮构建开始**为锚点。在途构建的 op-log 直到 finalize 才落库，期间
   * getLogs() 只有上一轮已完成的部署 → 若以历史 op-log 兜底会算成"几小时/几天"
   * 误判 overdue。本字段是唯一可靠的在途构建起点（修复 PR #865 Codex P2
   * 「Use the active redeploy start time for waiting ETAs」）。
   */
  lastDeployStartedAt?: string;
  /**
   * 2026-05-14: 容器最近一次进入 running 状态的 ISO 时间戳。
   * 由 reconcileBranchStatus() 在状态机切换到 'running' 时打戳。
   * 调度器（项目级 autoPublishAfterMinutes）
   * 以本字段为计时锚点 —— "完全启动成功之后开始算"。
   * 进入 running 后再回退到其他状态时**不清空**，下一次再次 running 才覆盖；
   * 这样调度器即便错过一拍也能基于上一次有效 ready 时间继续工作。
   */
  lastReadyAt?: string;
  /**
   * 2026-05-14: 最近一次容器被停止的 ISO 时间戳。
   * 涵盖用户主动 /stop、调度器空闲降温、远端执行器停止；不涵盖部署失败转 error
   * 状态（那个走 errorMessage）。UI 上配合 lastStopReason / lastStopSource 展示，
   * 解决"分支莫名变灰用户不知道为什么"的问题。
   */
  lastStoppedAt?: string;
  /**
   * 停止原因的人类可读短语，UI 直接展示。例如：
   *   - "用户手动停止"
   *   - "调度器：空闲超过 15 分钟自动降温"
   *   - "调度器：超出热容量上限被驱逐"
   *   - "远端执行器停止"
   */
  lastStopReason?: string;
  /**
   * 停止发起方分类，用于过滤与统计：
   *   - 'user'      用户在 UI 上点了停止
   *   - 'scheduler' 调度器自动降温/驱逐
   *   - 'executor'  远端执行器
   *   - 'crash'     进程自行异常退出（非 0/143/137）
   *   - 'oom'       Docker / kernel 明确报告 OOMKilled
   *   - 'external'  未匹配到 CDS 意图的 docker kill / SIGKILL
   *   - 'cds'       CDS 生命周期操作（删除 / 重部署替换 / 清理旧容器）
   *   - 'webhook'   GitHub webhook / 外部事件触发
   *   - 'ai'        AI Agent 通过 API 触发
   *   - 'system'    其他系统侧（垃圾回收 / janitor 等）
   */
  lastStopSource?: 'user' | 'scheduler' | 'executor' | 'crash' | 'oom' | 'external' | 'cds' | 'webhook' | 'ai' | 'system';
  /**
   * 2026-06-20：自动发布（auto-publish）最近一次成功把分支从源码/热加载切到
   * 发布版并重建的 ISO 时间戳。与 lastStopReason 是兄弟字段，但语义不同——
   * 这是"成功切到发布版"而非"被停止"，redeploy 成功路径**不能**钉 lastStoppedAt
   * （否则 UI 会在一个正在运行的分支上误报"已停止"）。
   *
   * 病根（任务 3）：原来 auto-publish 的 release 重建只写一条 activity log，
   * 分支卡片上没有任何持久态标记说明"我现在是被自动发布过的 release 版"，
   * 用户看到容器重建一次却不知道为什么——把"发布版 vs 热加载"切换变得隐形。
   * 本字段让这次模式跃迁在分支态里可观测。
   */
  lastPublishAt?: string;
  /**
   * 自动发布的人类可读原因短语，UI 直接展示。例如：
   *   - "项目设置：启动满 30 分钟，已自动切到发布版并重新部署（web=prod）"
   */
  lastPublishReason?: string;
}

/** State of a single service (one build profile instance) within a branch */
export interface ServiceState {
  profileId: string;
  containerName: string;
  /** Host port allocated for this service */
  hostPort: number;
  status: 'idle' | 'building' | 'starting' | 'running' | 'restarting' | 'stopping' | 'stopped' | 'error';
  buildLog?: string;
  errorMessage?: string;
  /**
   * 2026-05-14：容器**真正启动成功那一刻**实际使用的 deploy mode id
   * （= 当时 resolveEffectiveProfile 的 activeDeployMode）。这是"在跑的
   * 是不是发布版"的唯一真相来源——卡片徽章据此判断真实态 vs 配置意图，
   * 不再只看 profileOverrides。空串 = 源码/默认模式启动。
   * undefined = 该容器在本字段引入前启动（旧数据），徽章回退到配置语义。
   */
  deployedMode?: string;
}

/** A build/operation log event */
export interface OperationLogEvent {
  step: string;
  status: string;
  title?: string;
  detail?: Record<string, unknown>;
  log?: string;
  chunk?: string;
  timestamp: string;
}

/** A tail snapshot of docker logs captured when a deployment finalizes. */
export interface OperationLogContainerSnapshot {
  profileId: string;
  containerName: string;
  hostPort?: number;
  status?: ServiceState['status'] | string;
  capturedAt: string;
  tailLines: number;
  source: 'deploy-finalize' | 'deploy-error';
  logs: string;
  message?: string;
}

/** Append-only CDS-owned container log archive. */
export interface ContainerLogArchiveEntry {
  id: string;
  branchId: string;
  projectId?: string;
  profileId: string;
  containerName?: string;
  hostPort?: number;
  status?: ServiceState['status'] | string;
  capturedAt: string;
  source:
    | 'deploy-finalize'
    | 'deploy-error'
    | 'container-logs-api'
    | 'container-logs-stream'
    | 'pre-deploy-recreate'
    | 'manual-stop'
    | 'webhook-stop'
    | 'ai-stop'
    | 'system-stop'
    | 'scheduler-stop'
    | 'auto-lifecycle-stop'
    | 'crash-detected'
    | 'boot-reconcile'
    | 'branch-delete'
    | 'cleanup';
  sha256: string;
  byteLength: number;
  lineCount: number;
  masked: boolean;
  logs: string;
  message?: string;
}

/** A complete operation log */
export interface OperationLog {
  type: 'build' | 'run' | 'auto-build';
  startedAt: string;
  finishedAt?: string;
  /**
   * Timestamp when CDS judged the branch runtime to be truly ready.
   * This is stamped after container creation plus readiness/startup probes,
   * not when docker run starts.
   */
  runtimeStartedAt?: string;
  containerLogSnapshots?: OperationLogContainerSnapshot[];
  status: 'running' | 'completed' | 'error';
  events: OperationLogEvent[];

  // ───────────────────────────────────────────────────────────────────────
  // 2026-06-27 构建历史元数据（additive block）。
  //
  // 让「部署/构建历史」每一行能回答 为什么(触发器) / 干了什么(部署类型) /
  // 哪个版本(commit) / 什么时候开始(startedAt 已有)。全部 optional —— 旧
  // OperationLog 没有这些字段时前端优雅降级，不编造（no-rootless-tree）。
  // 写入点：branches.ts 的本地 / 远端两个 deploy opLog 创建处。
  // ───────────────────────────────────────────────────────────────────────

  /**
   * 本次构建的触发来源：
   *   - 'webhook'         GitHub push / PR webhook 自动派发
   *   - 'manual'          用户在 UI / cdscli 手动点部署
   *   - 'retry'           reconciler 对卡住/失败派发的自动重试（deployDispatchRetryCount>0）
   *   - 'cooldown-rewarm' 调度器把降温的分支重新唤醒（warm pool）
   *   - 'system'          其他系统侧自调（auto-lifecycle / 启动 reconcile 等）
   * 无法判定时省略（undefined），不强行归类。
   */
  triggerSource?: 'webhook' | 'manual' | 'retry' | 'cooldown-rewarm' | 'system';

  /**
   * 本次部署使用的部署模式（= resolveEffectiveProfile 解析出的 activeDeployMode）。
   * 空串 = 源码/默认模式；常见值如 'express' / 'static' / 'dev'。
   * 多 profile 时取首个非空模式。undefined = 旧记录未采集。
   */
  deployMode?: string;

  /** 本次部署锚定的 commit 完整 SHA（webhook 带入或 worktree HEAD 推导）。 */
  commitSha?: string;
  /** commitSha 的短哈希（前 7 位），UI 直接展示，省去前端再截断。 */
  shortCommit?: string;
}

export interface ReleaseArtifact {
  type: 'branch-preview' | 'image' | 'static' | 'generic';
  commitSha: string;
  branchId?: string;
  branchName?: string;
  previewUrl?: string;
  imageDigest?: string;
  artifactPath?: string;
}

export interface ReleaseTarget {
  id: string;
  projectId: string;
  name: string;
  type: 'ssh' | 'image-registry' | 'static-site' | 'webhook' | 'gitops' | 'k8s';
  createdAt: string;
  updatedAt?: string;
  createdBy?: string;
  isEnabled: boolean;
  ssh?: {
    host: string;
    port: number;
    user: string;
    /** RemoteHost.id that owns the encrypted SSH private key. */
    privateKeyRef: string;
    appPath: string;
    deployCommand: string;
    rollbackCommand?: string;
    healthcheckUrl: string;
  };
}

export interface ReleasePlanStep {
  id: string;
  title: string;
  kind: 'ssh' | 'healthcheck' | 'record' | 'manual';
  command?: string;
}

export interface ReleasePlan {
  id: string;
  projectId: string;
  name: string;
  template: 'ssh-script' | 'docker-compose-remote' | 'image-push' | 'webhook';
  targetType: ReleaseTarget['type'];
  steps: ReleasePlanStep[];
  failureStrategy: 'stop' | 'rollback';
  rollbackStrategy: 'command' | 'previous-release' | 'none';
  createdAt: string;
}

export interface ReleaseLogEntry {
  seq: number;
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  phase?: string;
}

export interface ReleaseRun {
  releaseId: string;
  projectId: string;
  branchId: string;
  commitSha: string;
  artifact: ReleaseArtifact;
  targetId: string;
  planId: string;
  status:
    | 'queued'
    | 'prechecking'
    | 'running'
    | 'healthchecking'
    | 'success'
    | 'failed'
    | 'rollback_running'
    | 'rollback_success'
    | 'rollback_failed';
  startedAt: string;
  finishedAt?: string;
  operator?: string;
  logs: ReleaseLogEntry[];
  seq: number;
  previousReleaseId?: string;
  rollbackOf?: string;
  rollbackTargetReleaseId?: string;
  errorMessage?: string;
}

/** Persisted state */
/**
 * Scoped custom environment variable store.
 *
 * The reserved key `_global` holds variables shared across every project;
 * any other key is a projectId whose bucket overrides the global one at
 * container-launch time (project wins; global is the baseline).
 *
 * Shape purposely mirrors `{ _global: {...}, <projectId>: {...} }` from
 * the product spec so the dashboard UI can render a simple two-column
 * picker (scope → key/value pairs).
 */
export type CustomEnvStore = Record<string, Record<string, string>>;

/** Reserved scope key for project-independent (global) variables. */
export const GLOBAL_ENV_SCOPE = '_global';

/**
 * 部署耗时模式分类。与 deploy-runtime.ts 的 classifyDeployRuntime 输出对齐：
 *   - 'release' ：发布版（生产/编译产物运行，prod/release/static…）
 *   - 'source'  ：源码 / 热加载（dev watch / vite / 默认源码模式）
 * 历史中位预计耗时按 (projectId, mode) 分桶，互不串味。
 */
export type DeployDurationMode = 'release' | 'source';

/**
 * 部署耗时样本桶（2026-06-20）。
 *
 * 病根：分支构建中卡片只显示"已耗时 NN s"，用户不知道"还要等多久"。
 * 对应的历史样本不能用 OperationLog —— 那个 per-branch 上限 10 条、build/run
 * 混在一起、删分支即没。这里另立一份持久化样本台账，keyed by projectId + mode，
 * 每桶保留最近 N 条（毫秒，从 deploy 开始到 ready）。
 *
 * 系统级放 CdsState 顶层（与项目维度无关的存储位置选择，样本本身按 projectId
 * 分桶）；随 save() 落盘，跟随 JSON ↔ Mongo 存储切换。
 */
export interface DeployDurationSamples {
  /** key = `${projectId}::${mode}`，value = 最近若干条毫秒耗时（旧→新追加）。 */
  buckets: Record<string, number[]>;
}

/**
 * 单个 (project, mode) 桶的历史耗时估算结果。
 * medianMs = p50；sampleCount = 参与计算的样本数。无样本时 medianMs = null。
 */
export interface DeployDurationEstimate {
  medianMs: number | null;
  sampleCount: number;
}

/**
 * 分支卡片消费的部署预计耗时摘要（两种模式各一份），随 BranchSummary 下发，
 * 卡片无需额外请求即可在构建中展示"预计 MM:SS（近 N 次中位值）"。
 * 某模式无历史样本时 median 为 null —— 卡片只显示已耗时，不编造预计值
 * （no-rootless-tree：不假定不存在的数据）。
 */
export interface BranchDeployEstimate {
  releaseMedianMs: number | null;
  releaseSamples: number;
  sourceMedianMs: number | null;
  sourceSamples: number;
}

export interface CdsState {
  /** Routing rules */
  routingRules: RoutingRule[];
  /** Build profiles */
  buildProfiles: BuildProfile[];
  /** All tracked branches */
  branches: Record<string, BranchEntry>;
  /** Next port index for allocation */
  nextPortIndex: number;
  /** Per-branch operation logs */
  logs: Record<string, OperationLog[]>;
  /** Release targets keyed by id. */
  releaseTargets?: Record<string, ReleaseTarget>;
  /** Release plan templates keyed by id. */
  releasePlans?: Record<string, ReleasePlan>;
  /** Immutable release run records keyed by releaseId. */
  releaseRuns?: Record<string, ReleaseRun>;
  /** Per-branch append-only container log archives owned by CDS. */
  containerLogArchives?: Record<string, ContainerLogArchiveEntry[]>;
  /**
   * Legacy 全局 default branch（PR_A 之后改为 per-project，存在
   * Project.defaultBranch 上）。本字段仍由 setProjectDefaultBranch 同步刷新，
   * 仅保留给 proxy.ts 这种没有 projectId 上下文的 fallback 路径使用。
   * 等 PR_A.7 验收后改为只读 derive，由所有项目的 defaultBranch 推导。
   * @deprecated 新代码请用 stateService.getDefaultBranchFor(projectId)
   */
  defaultBranch: string | null;
  /**
   * User-defined environment variables, scoped by project.
   *
   * Reserved scope `_global` holds variables shared by every project
   * (pre-feature behaviour). Project-specific scopes (`<projectId>`)
   * override `_global` at deploy time, so a `JWT_SECRET` in project A
   * never leaks into project B.
   *
   * **PR_A 之后**：`_global` 桶仍保留作为历史 fallback；新写入由
   * setCustomEnvVar 路由到 `Project.customEnv`，scope='<projectId>' 时
   * 不再写入这个 store 而是直接写到对应项目。
   *
   * Legacy state.json files stored this as a flat `Record<string, string>`.
   * migrateCustomEnvByProject() in state.ts wraps the flat object into
   * `{ _global: <flat> }` on first load so existing callers keep working.
   *
   * In-memory shape is always the nested form after load; the migration
   * is idempotent (already-nested stays put).
   */
  customEnv: CustomEnvStore;
  /** CDS-managed infrastructure services (databases, caches, etc.) */
  infraServices: InfraService[];
  /** Mirror acceleration enabled (npm/docker registry mirrors for faster builds in China) */
  mirrorEnabled?: boolean;
  /** Tab title override enabled (updates browser tab title with tag or branch short name) */
  tabTitleEnabled?: boolean;
  /**
   * Legacy 全局 preview mode（PR_A 之后改为 per-project，存在
   * Project.previewMode 上）。新读路径请用 getPreviewModeFor(projectId)。
   * 本字段仍由 setProjectPreviewMode 同步刷新供 PR_A 灰度兼容。
   * @deprecated 用 stateService.getPreviewModeFor(projectId)
   */
  previewMode?: 'simple' | 'port' | 'multi';
  /** Registered executor nodes (scheduler mode) */
  executors?: Record<string, ExecutorNode>;
  /**
   * UI-controlled override for the warm-pool scheduler enable flag. When
   * defined, it supersedes `config.scheduler.enabled` at runtime so the user
   * can toggle the scheduler from the Dashboard without editing
   * `cds.config.json`. Persisted to state.json and re-applied on boot.
   *
   * `undefined` = no override (fall back to config file). `true` = forced on.
   * `false` = forced off (even if config file has enabled:true).
   */
  schedulerEnabledOverride?: boolean;
  /**
   * UI-controlled override for the warm-pool scheduler idle timeout
   * (`config.scheduler.idleTTLSeconds`, seconds). Same semantics as
   * `schedulerEnabledOverride`: when defined it supersedes the config-file
   * value at runtime and is re-applied on boot. `undefined` = no override.
   */
  schedulerIdleTTLOverride?: number;
  /**
   * UI-controlled override for the warm-pool scheduler hot-pool cap
   * (`config.scheduler.maxHotBranches`). Same semantics as
   * `schedulerEnabledOverride`. `undefined` = no override. `0` = unlimited.
   */
  schedulerMaxHotOverride?: number;
  /**
   * UI-controlled override for the global janitor enable flag. When defined,
   * it supersedes `config.janitor.enabled` at runtime and is re-applied on boot.
   */
  janitorEnabledOverride?: boolean;
  /**
   * UI-controlled override for branch/container expiry in days.
   * Range is intentionally capped at 7 days so stale local containers cannot
   * accumulate indefinitely.
   */
  janitorWorktreeTTLOverride?: number;
  /** Data migration task history */
  dataMigrations?: DataMigration[];
  /** Per-branch/per-resource external access policies. Keyed by projectId:branchId:resourceId. */
  resourceExternalAccess?: Record<string, ResourceExternalAccessPolicy>;
  /** Resource-scoped database clone / create / restore task history. */
  resourceCloneTasks?: ResourceCloneTask[];
  /**
   * 分支墓碑台账（PR 合并/关闭后分支被删，gone 页据此区分"已合并"与"已放弃"）。
   * Keyed by previewSlug（即预览子域名 slug，与 gone 页收到的 slug 同口径），
   * 这样 serveBranchGonePage(slug) 能直接命中。容量上限由 StateService
   * recordRemovedBranch 维护（保留最近 N 条，按 removedAt 淘汰最旧）。
   */
  removedBranches?: Record<string, BranchTombstone>;
  /** Registered remote CDS peers (for one-click cross-CDS data migration) */
  cdsPeers?: CdsPeer[];
  /**
   * P4 Part 1: multi-project support. Each Project groups branches,
   * build profiles, infra services, and routing rules under one name.
   *
   * Optional so that legacy state.json files (pre-P4) still parse. On
   * load, StateService.migrateProjects() ensures at least one "legacy
   * default" project exists and assigns all pre-existing resources to
   * it. Real multi-project creation lands in P4 Part 2.
   *
   * See doc/design.cds.multi-project.md, doc/spec.cds.project-model.md.
   */
  projects?: Project[];
  /**
   * Global (bootstrap-equivalent) Agent Keys. Each entry holds only the
   * sha256 of a `cdsg_<suffix>` plaintext. Unlike project-scoped keys,
   * these are not enforced by assertProjectAccess and CAN create new
   * projects — intended for onboarding a fresh Agent that needs to
   * provision a new project end-to-end. Revoke after the Agent is done.
   *
   * Absent for pre-feature state.json — migrateGlobalAgentKeys() is a
   * no-op that just ensures the array exists when needed.
   */
  globalAgentKeys?: GlobalAgentKey[];
  /**
   * P4 Part 18 (Phase E): single-slot GitHub Device Flow token used
   * by the "从 GitHub 选择仓库" button in the New Project modal and
   * the Settings → GitHub Integration tab. Orthogonal to the CDS
   * session auth (auth-service.ts) — this is bring-your-own-token
   * for repo fetching, not a CDS login mechanism.
   *
   * Single-slot because CDS is single-tenant-per-install; per-user
   * tokens are a future phase once the user model stabilises.
   */
  githubDeviceAuth?: GitHubDeviceAuth;
  /**
   * Agent-authored configuration imports awaiting human approval.
   *
   * Workflow: an external agent (e.g. Claude Code running
   * cds-project-scan) generates a cds-compose YAML tailored to a
   * specific project and POSTs it to /api/projects/:id/pending-import.
   * The dashboard shows a badge with count; an operator reviews the
   * diff and either approves (parse + apply scoped to the project) or
   * rejects. Approved/rejected imports stay around with that status
   * for a short audit trail, then the frontend hides them.
   */
  pendingImports?: PendingImport[];
  /**
   * 被动授权 — agent 免密发起的授权申请队列。
   *
   * agent 直接 POST /api/projects/:id/access-requests 发起一条申请(无需预置密钥,
   * 按项目限量防刷),右下角审批盒(AccessRequestInbox,复用 pending-import 的被动审批
   * 底座)弹出。用户批准 → CDS 当场签发一把项目 AgentKey(授权密钥),明文挂在该申请
   * 记录上供发起方凭 pollToken 轮询一次取走(取走即清空明文,一次性交付)。拒绝 →
   * 标记 rejected。与 pendingImports 平级放顶层,审批盒一次列出所有项目的待批申请。
   */
  accessRequests?: AccessRequest[];
  /**
   * FU-04 — worktree directory layout version.
   *
   *   - undefined / 1: legacy flat layout `<worktreeBase>/<slug>`
   *     (pre-FU-04). Every branch in every project shares one
   *     directory, so two projects with the same branch name (e.g.
   *     "main") collide.
   *   - 2: per-project layout `<worktreeBase>/<projectId>/<slug>`.
   *     New branches always land here. On first boot after the
   *     upgrade, `WorktreeService.migrateFlatLayoutIfNeeded()`
   *     symlinks every surviving legacy entry into
   *     `<worktreeBase>/default/<slug>` and rewrites each
   *     `BranchEntry.worktreePath` accordingly.
   *
   * The migration is guarded by this counter so boots after the
   * one-shot move don't repeatedly re-scan the legacy layout.
   */
  worktreeLayoutVersion?: number;
  /**
   * User-customisable settings for the GitHub PR preview comment that
   * CDS posts on PR open / refreshes on every deploy
   * (postOrUpdatePrComment in routes/github-webhook.ts).
   *
   * Stored under state so it lives through the same JSON ↔ Mongo
   * storage swap as the rest of CDS state (no separate collection).
   *
   * Absent on pre-feature state.json — the renderer falls back to the
   * built-in default template (services/comment-template.ts).
   *
   * @deprecated PR_A 之后改为 per-project，存 Project.commentTemplate；
   * 新读路径用 stateService.getCommentTemplateFor(projectId)。
   */
  commentTemplate?: CommentTemplateSettings;
  /**
   * 2026-04-22 新增 —— 配置快照（导入/破坏性操作前自动备份，供一键回滚）。
   *
   * 每次下列动作会自动创建一条快照：
   *   - POST /api/import-config   (trigger='pre-import')
   *   - 破坏性操作（清项目、factory-reset 等）  (trigger='pre-destructive')
   *   - 用户在 Settings「历史版本」页手动「保存当前配置」 (trigger='manual')
   *
   * 保留策略：全局最近 30 条，满了淘汰最旧。
   * 不做 per-project 独立保留，因为导入/破坏性操作通常跨项目影响。
   *
   * 只快照「配置」，不快照「分支/容器/数据库」—— 这些属于运行时状态，
   * 由 DestructiveOperationLog 单独追踪（见 undoable 字段）。
   */
  configSnapshots?: ConfigSnapshot[];
  /**
   * 2026-04-22 新增 —— 破坏性操作审计 + 撤销。
   *
   * 记录每次「删项目/清容器/清数据库/replace-all 导入」等高风险操作，
   * 关联到一条 ConfigSnapshot（如适用）和可选的 mongoDumpPath。
   * 顶部「最近操作」抽屉让用户在 30 分钟内撤销。
   */
  destructiveOps?: DestructiveOperationLog[];
  /**
   * PR_C.2 起的项目活动日志 ring buffer（keyed by projectId）。
   * 每个 project 单独一个数组，按追加顺序，最多保留 N 条（默认 200）；
   * 老的事件被新的覆盖。Schema 见 ProjectActivityLog。
   *
   * 设计理由：放在 state 里而不是每个项目对象上，方便后期切到独立
   * collection（cds_activity_log）时整体迁移；同时避免把 Project
   * 文档撑大影响 cds_projects 单文档大小。
   */
  activityLogs?: Record<string, ProjectActivityLog[]>;

  /**
   * CDS 自身的更新流水(2026-05-04)。每次 /api/self-update / /api/self-force-sync
   * 走完关键节点(预检通过、即将重启)时会追加一条;UI 在「CDS 系统设置 → 维护」
   * 显示最近 N 条,让运维 lookup「上次系统更新是什么时候」「触发源是什么」「成功失败」。
   *
   * 当前 cap 在 20 条,append-only 由 stateService.recordSelfUpdate() 维护。
   * Per-instance 全局,与项目无关 → 系统级字段(参考 scope-naming.md §5)。
   */
  selfUpdateHistory?: SelfUpdateRecord[];
  /**
   * 部署耗时样本台账（2026-06-20）。keyed by `${projectId}::${mode}`，
   * 每桶保留最近 N 条毫秒耗时（StateService.DEPLOY_DURATION_SAMPLES_MAX）。
   * 仅在部署成功时由 recordDeployDuration() 追加；卡片"预计耗时"的中位值
   * 数据源。系统级（与具体项目无关的存储位置，样本本身按 projectId 分桶）。
   */
  deployDurationSamples?: DeployDurationSamples;
  /**
   * Agent 请求历史摘要(2026-06-11 用户信任诉求:「看到一条条请求事件才相信
   * HTML 真是远程 agent 返回的」)。会话 done/fail/stop 时由 remote-hosts
   * 落一条摘要(收发预览各截 2000 字),ring buffer 500 条;全量事件仍在内存随重启丢失。
   */
  agentRequestHistory?: AgentRequestRecord[];
  /**
   * Daemon 启动完成时间戳(ISO),由 index.ts 的 server.listen() 回调写入。
   * 2026-05-07 用户反馈"在左下角卡了 1 小时"导致的 timing 体系审视
   * (report.cds.self-update-timing-audit.md):durationMs 只覆盖 process.exit
   * 之前的后端流程,daemon 重启 + SSE 重连那段沉默时间不在记录里。本字段
   * 让 recordSelfUpdate 能算出真实"总耗时(含重启)"= daemonReadyAt - update.ts。
   */
  daemonReadyAt?: string;
  /**
   * 2026-06-24：系统级「发布(部署)阶段就绪探测下限秒数」默认值（默认 1200）。
   * 项目可用 Project.deployReadinessFloorSeconds 覆盖。仅作用于部署首启的就绪等待
   * （取 max(profile.timeoutSeconds, 此下限)），运行期重启/唤醒保持各 profile 短超时。
   */
  deployReadinessFloorSeconds?: number;
  /**
   * GitHub webhook 投递日志(2026-05-07 用户反馈"需要看到每次 hook 详情")。
   * Ring buffer,最多 200 条,新插入溢出时丢最早的。系统级 —— 跨项目的全部
   * webhook 都进同一队列(每条带 repoFullName 区分),前端「CDS 系统设置」→
   * 「GitHub Webhook 日志」tab 直接消费。
   */
  githubWebhookDeliveries?: GithubWebhookDelivery[];
  /**
   * 系统级 GitHub App owner 白名单。CDS GitHub App 公开后,任何人都能安装
   * App,但只有这里列出的 GitHub owner/org 才允许触发 CDS dispatch
   * (clone/build/deploy/stop/comment command)。空数组表示兼容模式:不启用
   * owner 门禁,避免升级后挡住现有 prd_agent / 已绑定项目的 webhook。
   */
  githubAppWhitelist?: GithubAppWhitelistSettings;
  /**
   * 远程 SSH 主机登记表（2026-05-06）。系统级 —— 一台主机可承载多个 shared-service
   * 项目的容器。SSH 凭据通过 sealToken（infra/secret-seal.ts）加密存储。
   *
   * 详见 doc/plan.cds-shared-service-extension.md。
   */
  remoteHosts?: Record<string, RemoteHost>;
  /**
   * shared-service 项目部署历史（2026-05-06）。每次 deploy 创建一条，
   * 含 5 阶段 SSE 日志流。Append-only，UI 取最新一条作"当前部署"。
   */
  serviceDeployments?: Record<string, ServiceDeployment>;
  /**
   * MAP 配对连接登记表（2026-05-06，spec.cds.map-pairing-protocol.md v1）。
   *
   * 每条记录代表一次 issue/accept handshake 后建立的双向信任关系：CDS 给
   * MAP（或未来其他 partner）一个长效 token，MAP 通过 instance discovery
   * API 拉这条 connection 关联的 shared-service Project 实例列表。
   *
   * 安全约束（spec §5）：
   *   - pairingToken / longToken 只存 SHA256 hash，明文不出库
   *   - status='pending-pairing' 的 connection 在 expiresAt 后被定期 GC
   *   - 同 partnerId + partnerKind 已有 active 时，issue 端不阻止；
   *     accept 端检查并返回 409 connection_duplicate
   */
  cdsConnections?: Record<string, CdsConnection>;
  /**
   * CDS 自托管验收报告元数据（2026-06-20）。系统级 —— 报告正文（可能是
   * 很大的 HTML / Markdown）落在 `<dataDir>/reports/<id>.<ext>` 磁盘文件上，
   * 不进 state.json；这里只存轻量元数据（标题/格式/大小/归属/时间）。
   *
   * 验收/视觉测试报告以往只能归档到外部知识库（需单独鉴权），CDS 自己托管
   * 后挂在 CDS 登录态后面即可访问，无需额外权限配置。HTML 报告以沙箱
   * iframe 渲染（不授予 same-origin），见 routes/reports.ts。
   */
  acceptanceReports?: AcceptanceReportMeta[];
  /** 验收报告文件夹（项目级分类，见 ReportFolder）。 */
  reportFolders?: ReportFolder[];
  /** WS3 MAP-KBTP peer-sync：本 CDS 实例的稳定 nodeId（首次用时生成）。 */
  peerSelfNodeId?: string;
  /** WS3：已配对的对端节点（MAP 等），见 PeerNodeRecord。 */
  peerNodes?: PeerNodeRecord[];
  /** WS3：待用的一次性配对码（明文不存，只存 hash），见 PeerPairingCode。 */
  peerPairingCodes?: PeerPairingCode[];
}

/**
 * WS3 MAP-KBTP v1 peer-sync：已配对的对端节点。
 * CDS 作为「源 peer」对外暴露验收报告供 MAP 等系统按知识库开放协议拉取。
 * sharedSecret 是 HMAC-SHA256 的密钥（base64 编码的 32 字节随机串）。
 */
export interface PeerNodeRecord {
  /** 本地记录 ID。 */
  id: string;
  /** 对端自报的稳定 nodeId（请求头 X-Peer-Node 的值）。 */
  partnerNodeId: string;
  /** 配对时生成的共享密钥（base64，HMAC 密钥）。明文存储——本机可读即可签验。 */
  sharedSecret: string;
  /** 对端公开 baseUrl（对端 handshake 自报，审计/回调用，本实现不回调）。 */
  partnerBaseUrl?: string;
  /** 对端显示名。 */
  partnerDisplayName?: string;
  /** 创建时间 ISO。 */
  createdAt: string;
  /** 最近一次被对端调用时间（审计）。 */
  lastUsedAt?: string;
}

/**
 * WS3：一次性配对码。管理员在 CDS 生成明文码交给对端，对端 handshake 时回带。
 * CDS 只存 sha256 hash，校验通过即换发 sharedSecret + 建 PeerNodeRecord。
 */
export interface PeerPairingCode {
  /** 稳定 ID。 */
  id: string;
  /** 配对码明文的 sha256 hex（明文不存）。 */
  codeHash: string;
  /** 备注显示名（这把码发给谁）。 */
  displayName?: string;
  /** 过期时间 ISO。 */
  expiresAt: string;
  /** 是否已被消费。 */
  used: boolean;
  /** 创建时间 ISO。 */
  createdAt: string;
}

/**
 * CDS 自托管验收报告的元数据（2026-06-20）。
 *
 * 报告正文不入 state —— 存到 `<dataDir>/reports/<id>.<ext>` 磁盘文件。
 * 这里只保留供列表/详情页展示的轻量字段。系统级（与具体 project 无关的
 * 存储位置，可选地通过 projectId 关联到某个项目以便过滤）。
 */
export interface AcceptanceReportMeta {
  /** 稳定 ID（用于磁盘文件名 `<id>.<ext>` 与路由 `:id`）。 */
  id: string;
  /** 报告标题（用户填写，列表/详情展示）。 */
  title: string;
  /** 报告格式：'html' 原样渲染，'md' 转 HTML 后渲染。 */
  format: 'html' | 'md';
  /** 可选关联项目 ID（用于按项目过滤）；不关联时为 null。 */
  projectId?: string | null;
  /** 可选关联分支 ID；不关联时为 null。 */
  branchId?: string | null;
  /** 可选归属文件夹 ID（项目内分类）；未归类时为 null。文件夹的 projectId 必须与本报告一致。 */
  folderId?: string | null;
  /** 正文字节数（UTF-8）。 */
  sizeBytes: number;
  /** 验收结论：pass 通过 / conditional 有条件通过 / fail 不通过；未判定为 null。 */
  verdict?: 'pass' | 'conditional' | 'fail' | null;
  /** 验收档位（如 P0 冒烟 / 视觉回归 / 完整验收等，自由文本，用于看板分组）；可空。 */
  tier?: string | null;
  /** 缺陷计数（按严重度），如 { p0:0, p1:1, p2:3 }；可空。 */
  defectCounts?: Record<string, number> | null;
  /** E1 部署上下文：被验收对象对应的 commit SHA（7+ 位）；可空。 */
  commitSha?: string | null;
  /** E1 部署上下文：被验收对象对应的分支名（与 branchId 互补，分支名更可读）；可空。 */
  branch?: string | null;
  /** E1 部署上下文：关联的 PR 编号（数字，便于回写）；可空。 */
  prNumber?: number | null;
  /** E1 部署上下文：部署模式（如 'fast' 极速版 / 'source' 源码 / 'preview'）；可空。 */
  deployMode?: string | null;
  /**
   * E6 匿名分享 token（只读公开链接 `/r/<token>`，补登录态门控缺口）。
   * 为 null 时未开启分享；撤销分享即置回 null。token 是不可枚举的随机串。
   */
  shareToken?: string | null;
  /** 创建人（resolveActorFromRequest 解析的 actor，如 'user' / 'ai'）。 */
  createdBy?: string;
  /** 创建时间 ISO 字符串。 */
  createdAt: string;
  /** 最近一次更新时间 ISO 字符串。 */
  updatedAt: string;
}

/**
 * 验收报告文件夹（项目级分类）。挂在某个 projectId 下，用于把该项目的验收报告
 * 归类（如「2026-06 这几天 CDS 验收」「视觉回归」「冒烟」）。projectId=null 表示
 * 全局报告（CDS 自身）的文件夹。报告的 folderId 必须与文件夹的 projectId 同属。
 */
export interface ReportFolder {
  /** 稳定 ID。 */
  id: string;
  /** 文件夹名称（用户填写）。 */
  name: string;
  /** 归属项目 ID；全局（CDS 自身）报告的文件夹为 null。 */
  projectId?: string | null;
  /** 父文件夹 ID（嵌套层级，根级为 null）。项目 = 根目录，下面技能自取多层子文件夹。 */
  parentId?: string | null;
  /** 排序权重（小在前）。 */
  sortOrder: number;
  /** 创建时间 ISO 字符串。 */
  createdAt: string;
}

/**
 * CDS 与 MAP（或未来其他 partner）的配对连接（系统级）。
 *
 * 状态机：
 *   pending-pairing --(accept 成功)--> active
 *   pending-pairing --(超时 / token 已用)--> （后台 GC 时删除）
 *   active --(用户/CDS 撤销)--> revoked
 *
 * 详见 doc/spec.cds.map-pairing-protocol.md。
 */
export interface CdsConnection {
  /** 稳定 ID。 */
  id: string;
  /** 内部识别用的显示名（例 "for noroenrn map"）。 */
  name: string;
  /** 对端类型；v1 仅 'map'，未来扩展 'cli' / 'other'。 */
  partnerKind: 'map' | 'cli' | 'other';
  /** 状态机；详见 interface 头部注释。 */
  status: 'pending-pairing' | 'active' | 'revoked';
  /**
   * 这条连接被赋予的 scope 列表，例：
   *   - 'shared-service:deploy'
   *   - 'instance:read'
   *   - 'deployment:stream'
   * accept 时长效 token 的鉴权按这个 scope 集做。
   */
  scopes: string[];

  // ── 配对态字段（status='pending-pairing' 时有，accept 后清空） ──
  /** SHA256 hash of pairing token（明文不存）。 */
  pairingTokenHash?: string;
  /** 配对密钥过期时间（默认 issuedAt + 10 分钟）。 */
  pairingExpiresAt?: string;

  // ── 激活态字段（status='active' 时有） ──
  /** SHA256 hash of long token（明文不存）。 */
  longTokenHash?: string;
  /** 长效 token 过期时间。为空表示系统级长期授权，直到显式 revoke / delete。 */
  longTokenExpiresAt?: string;
  /** 长效 token 签发时间。 */
  longTokenIssuedAt?: string;
  /** 对端实例稳定 ID（accept 时由 partner 自报，CDS 记录）。 */
  partnerId?: string;
  /** 对端显示名（例 "prd-agent prod"）。 */
  partnerName?: string;
  /** 对端公开访问 URL，CDS 反向 callback / 健康检查用。 */
  partnerBaseUrl?: string;
  /** 这条连接绑定的 shared-service Project（accept 时 CDS 自动创建）。 */
  projectId?: string;

  /** ISO 时间戳。 */
  createdAt: string;
  /** accept 成功时间；status='active' 后填充。 */
  activatedAt?: string;
  /** 最近一次被 partner 调用 API 的时间（审计用）。 */
  lastUsedAt?: string;
}

/**
 * 远程 SSH 主机登记（系统级）。一台主机可被多个 shared-service 项目共用。
 *
 * 安全约束：
 * - sshPrivateKeyEncrypted / sshPassphraseEncrypted 走 sealToken（AES-256-GCM）
 * - 明文私钥永不出库；API 返回时仅暴露 fingerprint 后 8 字符
 * - 录入时必须当场跑 SSH echo 验证（zero-friction-input 原则）
 *
 * 字段 SSOT 与命名规范见 .claude/rules/scope-naming.md §5。
 */
export interface RemoteHost {
  /** 稳定 ID，URL/路由用。 */
  id: string;
  /** UI 显示名（如 "prod-sandbox-1"）。 */
  name: string;
  /** SSH host（IP 或 domain）。 */
  host: string;
  /** SSH 端口，默认 22。 */
  sshPort: number;
  /** SSH 登录用户。 */
  sshUser: string;
  /**
   * SSH 私钥密文。通过 sealToken() 加密；isSealedSecret() 校验后用
   * unsealToken() 解密。明文不出库。
   *
   * 类型为 string | SealedSecret：CDS_SECRET_KEY 未配置时 sealToken
   * 直接返回明文 string（pre-seal 安装可能落明文 PEM），配置后返回
   * SealedSecret 对象。**不要 JSON.stringify SealedSecret 再存** —— 那
   * 会绕过 unsealToken 的 isSealedSecret 校验，把序列化字符串当明文返回。
   */
  sshPrivateKeyEncrypted: string | SealedSecret;
  /** 私钥指纹（明文 SHA256，前 16 hex 字符），用于 UI 展示和日志去敏。 */
  sshPrivateKeyFingerprint: string;
  /** 私钥口令密文（可选，同样走 sealToken）。 */
  sshPassphraseEncrypted?: string | SealedSecret;
  /** 路由 / 分类标签（如 ["prod","asia"]）。 */
  tags: string[];
  /** 是否启用；false 表示 deploy 不会路由到此主机。 */
  isEnabled: boolean;
  /** 创建时间。 */
  createdAt: string;
  /** 创建者 user/agent ID（审计用，可选）。 */
  createdBy?: string;
  /** 最后一次连接测试时间（test 按钮触发）。 */
  lastTestedAt?: string;
  /** 最后一次连接测试结果。 */
  lastTestOk?: boolean;
  /** 最后一次连接测试错误信息（失败时）。 */
  lastTestError?: string;
}

/**
 * shared-service 项目的一次部署记录。
 *
 * 5 阶段流程：connecting → installing → verifying → registering → running。
 * 任一阶段失败 → status='failed' + finishedAt 设置。
 *
 * 字段 logs 是 append-only 数组，SSE 通过 seq 续传；
 * UI 拉详情时取 logs.slice(afterSeq) 实现断线重连。
 */
export interface ServiceDeployment {
  /** 稳定 ID。 */
  id: string;
  /** 关联的 shared-service Project.id。 */
  projectId: string;
  /** 关联的 RemoteHost.id。 */
  hostId: string;
  /** Git tag / image tag，仅做展示与升级追踪用。 */
  releaseTag?: string;
  /** 当前阶段。 */
  status: 'pending' | 'connecting' | 'installing' | 'verifying' | 'registering' | 'running' | 'failed';
  /** 阶段描述（细化 status，如 "docker compose up -d"）。 */
  phase?: string;
  /** 用户可见的简要说明。 */
  message?: string;
  /** SSE 事件序号（断线续传用，logs 同步增长）。 */
  seq: number;
  /** 最后一次容器健康探针结果（独立于 status，用于 running 后的运行时监测）。 */
  containerHealthOk?: boolean;
  /** 最后一次健康探针时间。 */
  lastHeartbeatAt?: string;
  /** 部署开始时间。 */
  startedAt: string;
  /** 部署结束时间（成功或失败）。 */
  finishedAt?: string;
  /** 阶段日志流（append-only）。 */
  logs: ServiceDeploymentLogEntry[];
}

/** ServiceDeployment 的单条日志（与 SSE event 1:1）。 */
export interface ServiceDeploymentLogEntry {
  /** ISO 时间戳。 */
  at: string;
  /** 日志级别。 */
  level: 'info' | 'warn' | 'error';
  /** 日志正文（已脱敏：私钥 / token 等不允许出现）。 */
  message: string;
  /** 可选关联阶段。 */
  phase?: string;
}

/**
 * 一次 CDS 自更新事件的快照。结构刻意小 + 只存必要字段,20 条不到 5KB。
 *
 * 注意:status === 'success' 表示「预检通过 + 已发起重启」,**不**意味着新进程
 * 真的起来了 —— 真起没起要看 GET /healthz?probe=routes(我之前推的保活探针)。
 * 这两件事配合看就能完整复盘:历史告诉你「曾经发生过更新」,healthz 告诉你
 * 「现在能不能用」。
 */
/**
 * In-progress self-update marker(in-memory only,CDS 重启后丢)。
 * 用户反馈 2026-05-06:中间面板不知道别 session / webhook 触发的 self-update。
 * /api/self-status 携带此字段,前端任何 tab 都能立刻显示"正在重启"语义。
 */
export interface ActiveSelfUpdate {
  startedAt: string;
  branch: string;
  trigger: 'manual' | 'force-sync' | 'auto-poll' | 'webhook';
  actor?: string;
  /** 当前阶段标签(validate / build-backend / web-build / restart 等) */
  step?: string;
  /** Sidecar updater 进程 PID — 主进程启动时用 process.kill(pid, 0) 探活,
   *  pid 已死 + 文件还在 → 标记 'interrupted'(用户能看到上次更新崩在哪) */
  pid?: number;
  /** Sidecar 心跳时间戳(ISO)— 每次写步骤/日志时刷新。前端拿来判活:
   *  Date.now() - Date.parse(lastTickAt) > 30_000 → 显示"失联"而非继续跳秒 */
  lastTickAt?: string;
  /** 最近 N 行日志(ring buffer,保留 ~50 行)。让前端面板能看到当前
   *  到底在跑什么命令、stderr 是什么。代替"卡 web-build 2 分钟空白" */
  logTail?: Array<{ ts: string; level: 'info' | 'warning' | 'error'; text: string }>;
  /** 启动时扫描发现 sidecar pid 已死 → 标 true。前端渲染"已中断"红色态。
   *  下次正常更新触发时清掉。 */
  interrupted?: boolean;
}

/** Agent 请求历史摘要（观测台持久层，重启可查） */
export interface AgentRequestRecord {
  sessionId: string;
  projectId: string;
  title: string | null;
  clientUser: string | null;
  clientApp: string | null;
  runtime: string;
  model: string | null;
  status: string;
  createdAt: string;
  finishedAt: string;
  durationMs: number;
  eventCount: number;
  requestPreview: string | null;
  responsePreview: string | null;
}

export interface SelfUpdateRecord {
  /** ISO timestamp 当事件被记录(预检通过 / 出错时) */
  ts: string;
  /** 目标分支(空字符串=保持当前分支) */
  branch: string;
  /** 更新前 HEAD short SHA */
  fromSha: string;
  /** 更新后 HEAD short SHA(success 时为 origin/<branch> tip;abort 时为 fromSha) */
  toSha: string;
  /** 触发源:目前只有 'manual'(/api/self-update);保留枚举给未来 webhook/auto-poll 接入 */
  trigger: 'manual' | 'force-sync' | 'auto-poll' | 'webhook';
  /** 终态 */
  status: 'success' | 'failed' | 'aborted' | 'deferred';
  /** 整个流程耗时(ms);失败也填,便于看是「秒挂」还是「磨蹭半天才失败」。
   *  注意:这只是 process.exit 之前的后端流程时间,**不含 daemon 重启**。 */
  durationMs?: number;
  /** 真实总耗时(ms,含 daemon 重启 + SSE 重连)。 = 下一次 daemon ready 时刻
   *  - 本 record 的 ts。daemon 重启后第一次 recordSelfUpdate 会回填上一条
   *  success entry 的此字段。比 durationMs 更接近用户体感等待时长。
   *  2026-05-07 timing 审视新增 (report.cds.self-update-timing-audit)。 */
  totalElapsedMs?: number;
  /** 失败/中止时的简短原因(已截断,前端不展开) */
  error?: string;
  /** 触发用户,用于审计;manual 时 = cookie 里 username,自动触发时为 'system' */
  actor?: string;
  /** 完整的 SSE 步骤序列(2026-05-07 用户反馈"以前的更新日志去哪了"):
   *  recordSelfUpdate 把当前 active-update.json 的 logTail 转储到这里,
   *  历史抽屉点条目就能展开看完整步骤。截断到 50 行(与 active 同 ring buffer)。
   *  /api/self-status 默认 includeSteps=false 时被剥离换成 stepsCount,
   *  减小默认 payload(steps 在 50 行 × N 条记录下能滚到几十 KB)。
   *  完整版从 /api/self-update-history?limit=N 拉。 */
  steps?: Array<{ ts: string; level: 'info' | 'warning' | 'error'; text: string }>;
  /** /api/self-status 默认 slim 时给前端的提示:本 record 有几行完整步骤;
   *  前端可据此显示"完整步骤(N 行)"按钮 + 点击时再 lazy fetch 完整日志。 */
  stepsCount?: number;
  /** 本次 self-update 走的更新档位(用户可见标签由前端 chip 渲染):
   *   - 'hot-reload': 跳过 validate 走 systemd 软重启(~15-25s)
   *   - 'restart':   完整 validate + systemd 重启(~70-95s,默认)
   *   - 'noOp':      HEAD 已与 dist 一致,啥都没做(~3s)
   *   - 'web-only':  改动只触前端,只重 web/dist,daemon 不重启
   *   - 'doc-only':  改动只触文档/changelogs,完全 noop */
  updateMode?: 'hot-reload' | 'restart' | 'noOp' | 'web-only' | 'doc-only';
  /** 结构化耗时明细。用于复查"每次慢在哪里",避免只能解析 steps 文本。
   *  常见字段:fetchMs/pullMs/validateMs/buildBackendMs/webBuildMs/totalMs,
   *  validate 内含 install_cds_ms/tsc_web_ms 等 validateBuildReadiness 原始计时。 */
  timings?: SelfUpdateTimingBreakdown;
}

export interface SelfUpdateTimingBreakdown {
  totalMs?: number;
  fetchMs?: number;
  checkoutMs?: number;
  pullMs?: number;
  resetMs?: number;
  nginxRenderMs?: number;
  analyzeMs?: number;
  validateMs?: number;
  validateInstallMs?: number;
  validateTscMs?: number;
  cacheMs?: number;
  buildBackendMs?: number;
  webBuildMs?: number;
  webOnlyMs?: number;
  docOnlyMs?: number;
  noOpMs?: number;
  restartMs?: number;
  /** 重启前等待 in-flight 分支操作排空的耗时(可达 180s,见 restart-drain.ts)。
   *  历史上这段不计入任何 step,导致 totalMs 远大于各 step 之和 ——
   *  进度条大片留白、看不出时间去哪了。2026-06-03 用户反馈后补记。 */
  drainMs?: number;
  validate?: Record<string, number>;
  [key: string]: number | boolean | string | Record<string, number> | undefined;
}

/**
 * GitHub webhook 投递日志条目(2026-05-07 新增)。
 *
 * 每次 POST /api/github/webhook 命中,在路由处理完毕后(无论成功失败)
 * 写一条进 CdsState.githubWebhookDeliveries(ring buffer,200 条上限)。
 * 前端「CDS 系统设置」→「GitHub Webhook 日志」tab 列表展示 + 点开看详情。
 *
 * 字段命名贴近 GitHub webhook spec:deliveryId / event 来自请求头,
 * sender / commitSha / commitMessage 从 payload 抽取(payload 形态因
 * event 类型而异,所以这些字段都是 optional)。
 */
export interface GithubWebhookDelivery {
  /** 内部 UUID,前端 React key */
  id: string;
  /** 接收时间(ISO),也是排序锚 */
  receivedAt: string;
  /** 处理总耗时(ms),包括验签 + dispatch */
  durationMs: number;
  /** GitHub 给的官方追踪 ID(X-GitHub-Delivery 头),用于和 GitHub 端日志对账 */
  deliveryId?: string;
  /** event 类型(X-GitHub-Event 头)— push / pull_request / check_run / ... */
  event: string;
  /** 仓库全名(payload.repository.full_name)— 跨项目区分 */
  repoFullName?: string;
  /** push 的 ref(refs/heads/main)/ pull_request 的 head ref / 其他 */
  ref?: string;
  /** 短 commit SHA(7 位)— push.head_commit.id 或 pull_request.head.sha */
  commitSha?: string;
  /** commit message(截断 200 字)— 帮 operator 一眼认出是什么 commit */
  commitMessage?: string;
  /** 触发者 GitHub login(payload.sender.login) */
  actor?: string;
  /** 触发者 GitHub 原始头像 URL(payload.sender.avatar_url) */
  actorAvatarUrl?: string;
  /** GitHub repository owner / org,用于白名单筛选和一键加入 */
  githubOwner?: string;
  /** GitHub App 白名单判定。blocked 表示已验签但未进入业务 dispatch。 */
  githubWhitelistDecision?: 'allowed' | 'blocked' | 'not-evaluated';
  /** 拦截后是否已尝试在 PR 评论区回复提示。 */
  githubWhitelistCommentPosted?: boolean;
  /** HMAC 验签是否通过。失败的也记录下来,便于排查"GitHub webhook secret 漂移" */
  signatureValid: boolean;
  /** dispatcher 实际做了啥:branch-created / deploy / skipped / ignored / error */
  dispatchAction: 'branch-created' | 'deploy' | 'skipped' | 'ignored' | 'error';
  /** dispatch 决策的简短原因,展示在列表行 */
  dispatchReason?: string;
  /** dispatcher 解析出的 CDS branchId。用于分支详情抽屉按分支过滤 webhook 触发日志。 */
  branchId?: string;
  /** 是否已经向内部 deploy endpoint 派发。dispatchAction=deploy 但 dedup 时此值为 false。 */
  deployDispatched?: boolean;
  /** 内部 deploy endpoint 未接受派发时的可见原因。 */
  deployDispatchError?: string;
  /** 同一 branchId + commitSha 在 dedup 窗口内被跳过。 */
  deployDedupSkipped?: boolean;
  /** push 是否同时命中 CDS 当前运行分支,从而触发左下角 self-update badge 刷新。 */
  selfStatusBroadcast?: boolean;
  /** payload 截断片段(JSON 字符串,最多 4KB)— 详情面板可展开看 */
  payloadSnippet?: string;
  /** 处理过程中抛出的错误(若有) */
  error?: string;
}

export interface GithubAppWhitelistSettings {
  /** 允许触发 CDS 的 GitHub owner/org login,统一按小写保存和匹配。 */
  allowedOwners: string[];
}

/**
 * 一条项目活动日志：deployRequest / pull / colormark / ai-occupy 等。
 * 结构刻意小 — 让 ring buffer 200 条只占几十 KB。
 */
export interface ProjectActivityLog {
  /** 自增唯一 id（"<projectId>:<seq>"）。仅用于 dedupe，不必持久全局唯一。 */
  id: string;
  /** ISO 时间戳。 */
  at: string;
  /** 触发事件类型。新增类型时也要在 UI 渲染映射里加一个图标 / 中文名。 */
  type:
    | 'deploy'         // POST /branches/:id/deploy 完成
    | 'deploy-failed'  // 同上但部分 / 全部 service error
    | 'pull'           // POST /branches/:id/pull
    | 'stop'           // POST /branches/:id/stop
    | 'restart'        // POST /branches/:id/restart（轻量重启，未重建）
    | 'crash'          // 容器异常退出，auto-restart 巡检发现
    | 'colormark-on'   // 标记调试中
    | 'colormark-off'  // 取消调试中
    | 'ai-occupy'      // AI agent 开始操作
    | 'ai-release'     // AI agent 释放
    | 'branch-deleted' // DELETE /branches/:id
    | 'branch-created' // POST /branches
    | 'resource-created'
    | 'resource-deleted'
    | 'resource-restart'
    | 'resource-external-access'
    | 'resource-db-clone'
    | 'resource-backup'
    | 'resource-restore'
    | 'resource-credentials-reset'
    | 'resource-connection-inject'
    | 'resource-data-query'
  ;
  /** 关联分支（如有）。 */
  branchId?: string;
  /** 关联分支的可读名（缓存避免 join）。 */
  branchName?: string;
  /** 触发者：用户名 / agent 标识 / "system"。 */
  actor?: string;
  /** 自由文本，可空。展示用，<= 200 字符。 */
  note?: string;
  /** 关联资源（如 app:frontend / infra:mysql）。 */
  resourceId?: string;
  /** 资源显示名缓存，避免 UI 再 join。 */
  resourceName?: string;
  /** 操作结果。 */
  result?: 'success' | 'failed' | 'pending';
}

export interface ResourceExternalAccessPolicy {
  id: string;
  projectId: string;
  branchId: string;
  resourceId: string;
  enabled: boolean;
  kind: 'https' | 'tcp';
  address?: string;
  host?: string;
  port?: number;
  connectionString?: string;
  proxyContainerName?: string;
  targetHost?: string;
  targetPort?: number;
  allowlistEnforced?: boolean;
  firewallChain?: string;
  allowlist: string[];
  expiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
}

export interface ResourceCloneTask {
  id: string;
  projectId: string;
  branchId: string;
  resourceId: string;
  runtime: 'mysql' | 'postgres' | 'mongodb' | 'redis' | 'unknown';
  mode: 'empty' | 'clone-main' | 'restore-backup' | 'connect-existing';
  strategy: 'branch-database' | 'mysqldump' | 'mysqlpump' | 'background-copy' | 'backup-restore' | 'external-connection';
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  progressMessage?: string;
  sourceBranchId?: string;
  sourceResourceId?: string;
  targetDatabase?: string;
  backupId?: string;
  externalConnectionName?: string;
  injectedEnv?: Record<string, string>;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  actor?: string;
  log?: string;
}

/**
 * 配置快照。拍下 buildProfiles/envVars/infra/routingRules 四件套当前状态，
 * 供一键回滚。不包含 branches/logs/运行时字段 —— 那些不算「配置」。
 */
export interface ConfigSnapshot {
  id: string;
  createdAt: string;
  /** 关联项目（如果是项目级操作触发）。全局导入为 null。 */
  projectId?: string | null;
  /** 触发来源 */
  trigger: 'pre-import' | 'pre-destructive' | 'manual' | 'scheduled';
  /** 人类可读的标签（如 "导入 prd-agent.yaml 前" / "factory-reset 前"） */
  label: string;
  /** 谁触发的（agent key id / user id / 'system'） */
  triggeredBy?: string;
  /** 快照内容（JSON） */
  payload: {
    buildProfiles: BuildProfile[];
    customEnv: CustomEnvStore;
    infraServices: InfraService[];
    routingRules: RoutingRule[];
  };
  /** 快照字节数（存 state.json 时粗略统计，用于 UI 展示） */
  sizeBytes?: number;
}

/**
 * 破坏性操作审计日志。用户「撤销」时，从关联的 ConfigSnapshot 回放配置，
 * 并从 mongoDumpPath（如存在）恢复数据库。
 */
export interface DestructiveOperationLog {
  id: string;
  at: string;
  type: 'import-replace-all' | 'factory-reset' | 'delete-project' | 'purge-branch' | 'purge-database' | 'other';
  /** 项目范围，全局为 null */
  projectId?: string | null;
  /** 关联 ConfigSnapshot.id（可选） */
  snapshotId?: string | null;
  /** 数据库 dump 文件路径（可选） */
  mongoDumpPath?: string | null;
  /** 操作的 summary（UI 显示） */
  summary: string;
  /** 谁触发的 */
  triggeredBy?: string;
  /** 是否可撤销（时间窗：at + 30min；已撤销为 false） */
  undoable: boolean;
  /** 已撤销时间（undone 后前端显示为灰色） */
  undoneAt?: string;
}

/**
 * GitHub PR preview comment template settings.
 *
 * `body` is a Markdown blob with `{{var}}` placeholders. The list of
 * supported variables is fixed at code level (see VARIABLE_DEFS in
 * services/comment-template.ts) — adding a new one requires touching
 * both the renderer and the settings-panel UI so the user speaks the
 * same vocabulary as the renderer.
 *
 * No separate "PR review host" field: the deeplink reuses the current
 * branch's previewUrl (the frontend hosting PrReviewPage is itself
 * deployed per-branch by CDS), so {{prReviewUrl}} is fully derivable
 * from state the webhook already has.
 */
export interface CommentTemplateSettings {
  /** Markdown body with {{var}} placeholders. Empty string = use default. */
  body: string;
  /** ISO timestamp of the last save, for UI display. */
  updatedAt?: string;
}

/**
 * An Agent-submitted CDS compose YAML awaiting operator approval.
 *
 * Small summary fields (addedProfiles/addedInfra/addedEnvKeys) are
 * precomputed at submit time so the dashboard can render a one-line
 * "+3 profiles, +2 infra" preview without re-parsing the YAML.
 */
export interface PendingImport {
  /** Opaque hex id for approve/reject routing. */
  id: string;
  /** Target project id this YAML should apply to when approved. */
  projectId: string;
  /** Free-form agent identifier (e.g. "Claude Code", "cds-project-scan"). */
  agentName: string;
  /** One-line rationale the agent provides so the operator knows why. */
  purpose: string;
  /** Raw cds-compose YAML. Stored verbatim; parsed lazily on approve. */
  composeYaml: string;
  /** Precomputed summary so the dashboard can render without re-parsing. */
  summary: {
    addedProfiles: string[];
    addedInfra: string[];
    addedEnvKeys: string[];
    /**
     * Phase 8 — env 三色分类(可选;旧 PendingImport 没这字段时 UI 走兼容兜底)。
     * UI 弹窗据此渲染"必填项 / CDS 自动 / infra 推导"三栏。
     */
    requiredEnvKeys?: string[];
    autoEnvKeys?: string[];
    infraDerivedEnvKeys?: string[];
    envMeta?: Record<string, EnvMeta>;
  };
  /** ISO timestamp when the agent POSTed this import. */
  submittedAt: string;
  /** Lifecycle: starts 'pending', moves to 'approved' or 'rejected'. */
  status: 'pending' | 'approved' | 'rejected';
  /** Set when status === 'rejected'. */
  rejectReason?: string;
  /** Set when status flips away from 'pending'. */
  decidedAt?: string;
}

/**
 * GitHub Device Flow token snapshot persisted in state.json. The
 * token itself is a GitHub-issued opaque string — we never decrypt
 * or inspect it, just pass it along to api.github.com.
 */
export interface GitHubDeviceAuth {
  /** Raw access_token returned by GitHub. */
  token: string;
  /** GitHub login (e.g. 'octocat') for the UI. */
  login: string;
  /** Display name (may be null). */
  name: string | null;
  /** Avatar URL for the Settings UI. */
  avatarUrl: string | null;
  /** ISO timestamp of when the device flow completed. */
  connectedAt: string;
  /** OAuth scopes granted by the user. */
  scopes: string[];
}

/**
 * A Project is the top-level grouping container for a CDS workload.
 * Introduced in P4 Part 1. In Part 1 only the "legacy default" project
 * exists (auto-created on migration); Part 2 adds real CRUD; Part 3
 * threads projectId into Branch/BuildProfile/InfraService/RoutingRule.
 *
 * Field discipline: Part 1 only adds the minimum set needed for the
 * projects list UI. Fields like `dockerNetwork`, `webhookSecret`,
 * `autoDeployStrategy`, `branchCount` etc. land with the phases that
 * actually use them. Adding them prematurely would create dead fields
 * in state.json that mislead future readers.
 */
export interface Project {
  /** Stable identifier, used in URLs and routing filters. */
  id: string;
  /** URL-friendly slug (may equal id, usually kebab-case). */
  slug: string;
  /** Human-friendly display name shown on the projects list card. */
  name: string;
  /**
   * Optional display-only alias. Populated via Settings → 基础信息 →「显示别名」.
   * All UI call sites (project cards, breadcrumb, Settings title,
   * Agent-key modal) read `aliasName || name`, so the pre-feature
   * behaviour is preserved when this field is absent.
   *
   * Does NOT rename the project — `id` / `slug` / branch id prefixes
   * remain anchored to the original values so existing branches keep
   * working and GitHub webhooks keep routing by `githubRepoFullName`.
   * Use this field when the auto-migrated `name` (e.g. "prd-agent" from
   * the legacy default project) is not the label the user wants to see.
   */
  aliasName?: string;
  /**
   * Optional alternative slug, reserved for a future "use alias in new
   * branch ids" toggle. Stored here so the Settings UI can capture it
   * alongside `aliasName`, but NOT consumed by branch-id derivation
   * yet (see doc/plan.cds-github-integration-followups.md §1 — branch
   * prefix change is scoped to a follow-up PR).
   *
   * Must pass the same SLUG_REGEX as `slug` and must not collide with
   * any other project's `slug` or `aliasSlug`.
   */
  aliasSlug?: string;
  /** Optional one-line description shown under the name. */
  description?: string;
  /**
   * Infrastructure 隔离模式（mongo / redis 等基础设施容器与分支的关系）。
   *
   * - 'shared'（默认 / 缺省）：infra 是 init 时一次性创建的 long-lived 资源，
   *   所有分支**共享**同一个 mongo / redis 容器。容器隔离 ≠ infra 隔离。
   *   分支的 deploy 流程**不应触碰** infra（不重启、不删除、不健康检查阻塞）—
   *   touch infra 是 init / admin 的事，不是 branch deploy 的事。
   *
   * - 'per-branch'：每分支自己的 infra 容器（容器名带 branchSlug 后缀）。
   *   适合需要数据完全隔离的场景（如灰度数据演练）。deploy 流程会触发
   *   computeRequiredInfra → startInfraService 走完整启动链路。
   *
   *   警告：'per-branch' 当前是 placeholder，containerName 还没真正按
   *   branch 区分（cds/src/services/infra-name.ts TODO）。在那块 land
   *   之前，project.infraIsolation 别填 'per-branch'，否则会落回
   *   shared 行为但触发额外重启循环。
   *
   * 字段缺省时（老 project / fresh install）按 'shared' 处理。
   */
  infraIsolation?: 'shared' | 'per-branch';
  /**
   * 分支卡片资源 chip 的显示项。默认只显示技术图标 + 端口，避免
   * Node.js / .NET / MongoDB 等名称把卡片撑成多行。项目设置可开启
   * 运行时名称显示，但 icon/name/port 至少要保留一项。
   */
  resourceChipDisplay?: {
    icon?: boolean;
    name?: boolean;
    port?: boolean;
  };
  /**
   * Project kind. 'git' is the only value Part 1 creates; 'manual'
   * lands in P6 when users can upload their own compose.
   *
   * 'shared-service' (2026-05-06)：long-lived 共享基础设施服务（如
   * claude-sdk sidecar / Embedding / RAG 等），不绑定 git 分支预览，
   * 而是部署到 RemoteHost 列表跑长生命周期容器。详见
   * doc/plan.cds-shared-service-extension.md。
   */
  kind: 'git' | 'manual' | 'shared-service';
  /**
   * shared-service 专用：要部署的 docker 镜像（含 tag/digest）。
   * 例 `prdagent/claude-sidecar:v0.2.1` 或 `ghcr.io/...@sha256:...`。
   */
  serviceImage?: string;
  /**
   * shared-service 专用：sidecar 容器对外暴露的端口（远程主机上的端口）。
   * 默认 7400（claude-sdk-sidecar 约定）。
   */
  servicePort?: number;
  /**
   * shared-service 专用：当前部署的 release/tag 标识，仅用于 UI 显示
   * 与升级追踪。serviceImage 含 tag 时此字段可冗余但非必需。
   */
  releaseTag?: string;
  /**
   * shared-service 专用：要部署到的 RemoteHost.id 列表。
   * 每台主机起一份独立容器；deploy 调用按列表顺序依次部署。
   */
  targetHostIds?: string[];
  /**
   * shared-service 专用：注入到容器的环境变量（明文 + 已 seal 的私密项）。
   * 普通 key/value 走明文；包含 `_API_KEY` / `_TOKEN` / `_SECRET` 后缀的
   * 字段在保存时通过 sealToken 加密。
   * 与 customEnv 不冲突 —— customEnv 给 git 分支用；此字段专属 shared-service。
   */
  serviceEnv?: Record<string, string>;
  /** Optional Git repository URL; populated for auto-created legacy projects from CdsConfig.repoRoot. */
  gitRepoUrl?: string;
  /**
   * Default branch name reported by the Git remote, for example "main" or
   * "master". This is intentionally separate from Project.defaultBranch,
   * which stores the CDS fallback branch id used by preview routing.
   */
  gitDefaultBranch?: string | null;
  /**
   * Railway-style first-run hint selected in the Dashboard. When a cloned
   * repo has no cds-compose.yml/docker-compose.yml, CDS can still create a
   * root BuildProfile from these fields instead of leaving a blank canvas.
   */
  onboardingRuntime?: 'auto' | 'node' | 'python' | 'dotnet' | 'java' | 'go' | 'rust' | 'php' | 'static' | 'dockerfile' | 'custom';
  onboardingDockerImage?: string;
  onboardingCommand?: string;
  onboardingPort?: number;
  onboardingServices?: Array<{
    id: string;
    name: string;
    role: 'frontend' | 'backend' | 'worker' | 'app';
    runtime: 'auto' | 'node' | 'python' | 'dotnet' | 'java' | 'go' | 'rust' | 'php' | 'static' | 'dockerfile' | 'custom';
    dockerImage?: string;
    command?: string;
    port?: number;
  }>;
  /**
   * Absolute path to the git checkout for this project. For projects
   * created after P4 Part 18 (G1) this points to
   * `${config.reposBase}/<projectId>` and is populated once the async
   * git clone completes.
   *
   * The legacy 'default' project and any pre-G1 projects leave this
   * undefined and fall back to the globally-mounted `config.repoRoot`
   * at every use site — see `StateService.getProjectRepoRoot()`.
   */
  repoPath?: string;
  /**
   * Async clone lifecycle for this project. Absent (or 'ready') for
   * legacy projects; set to 'pending' immediately after POST /projects
   * when a gitRepoUrl is supplied; 'cloning' while the SSE clone runs;
   * 'ready' after success; 'error' after failure.
   *
   * Deploy endpoints should refuse to build a branch from a project
   * whose cloneStatus is 'pending' / 'cloning' / 'error' — the repo
   * isn't usable until the clone has finished.
   */
  cloneStatus?: 'pending' | 'cloning' | 'ready' | 'error';
  /** Human-readable error message set when cloneStatus === 'error'. */
  cloneError?: string;
  /**
   * Name of the dedicated Docker network backing this project. Populated
   * by P4 Part 2 on project creation (`cds-proj-<id-prefix>`). The
   * legacy default project has this field unset — it continues to use
   * the pre-P4 shared network until P4 Part 3 threads projectId through
   * every container operation.
   */
  dockerNetwork?: string;
  /**
   * True for the migration-created "legacy default" project that wraps
   * all pre-P4 data. Marked so the UI can label it and so P4 Part 2
   * knows it is not deletable.
   */
  legacyFlag?: boolean;
  /**
   * Bug N fix(2026-05-10) — clone 完成后是否触发启发式栈扫描自动建 BuildProfile。
   *
   * 默认 `false`(/undefined):POST /api/projects → git clone 完成后,只解析
   * cds-compose.yml / docker-compose.yml(用户的精确意图),不做 stack 启发式
   * 自动建 ghost profile,把"该跑什么"的决定权交还给 cdscli scan 或手动配置。
   *
   * `true`:保留旧行为(modules / Dockerfile fallback / placeholder),给某些
   * 真的依赖自动检测的脚本化用例。建议只在 e2e 测试 / demo 项目里开。
   */
  autoDetectOnClone?: boolean;
  /**
   * P5: the CdsWorkspace this project belongs to. Null / absent = personal
   * workspace of the creating user (backward-compatible default).
   */
  workspaceId?: string | null;
  /** ISO timestamp when the project entry was created (or migrated in). */
  createdAt: string;
  /** ISO timestamp of most recent mutation. */
  updatedAt: string;
  /**
   * Project-scoped Agent Keys. Each entry stores only the sha256 of
   * the plaintext key so a leaked state.json can't be replayed; the
   * plaintext is shown once at signing time and never again. The
   * prefix of the plaintext key (`cdsp_<slugHead12>_<suffix>`) encodes
   * the owning project so auth middleware can look up the owning
   * project without the caller having to also send projectId.
   *
   * Absent for legacy projects / pre-feature state.json. See
   * StateService.addAgentKey / findAgentKeyForAuth for the storage
   * + auth contract.
   */
  agentKeys?: AgentKey[];
  /**
   * GitHub Checks integration — when set, pushes to the linked
   * repository auto-create/update CDS branches and post back to
   * GitHub as a "CDS Deploy" check run (shown in the PR "Checks"
   * panel, Railway-style).
   *
   * - `githubRepoFullName`: "owner/repo" (case-preserved as returned
   *   by the GitHub App installation_repositories event).
   * - `githubInstallationId`: numeric install id granted to the CDS
   *   GitHub App for this project's org/user. Required to mint
   *   installation access tokens.
   * - `githubAutoDeploy`: when true (default when the link is created)
   *   every push auto-creates+deploys a matching CDS branch. When
   *   false, CDS still posts check runs for branches created manually
   *   but won't trigger deploys from webhooks.
   * - `githubLinkedAt`: ISO timestamp of the most recent link event.
   */
  githubRepoFullName?: string;
  githubInstallationId?: number;
  /**
   * @deprecated PR_D.1 起改用 githubEventPolicy.push。本字段仍由
   * isEventEnabled('push') 兜底读取，保证老 state.json 行为不变；
   * 新写入只走 githubEventPolicy。
   */
  githubAutoDeploy?: boolean;
  githubLinkedAt?: string;
  /**
   * Phase 4 (冒烟自动化): when true, every successful `POST /branches/
   * :id/deploy` call that owns this project auto-triggers
   * scripts/smoke-all.sh against the branch's preview URL right after
   * the deploy SSE `complete` event. Results stream through the same
   * SSE as `smoke-line` / `smoke-complete` events so the dashboard
   * deploy log keeps going without a second round-trip.
   *
   * Requires `_global.customEnv.AI_ACCESS_KEY` to be set (the deploy
   * flow has no operator UI to prompt for it). Silent no-op when the
   * key is missing — we emit a single `smoke-line` warning line so the
   * operator sees why it didn't run. Default `undefined` ⇒ false.
   *
   * Phase 5 piggybacks on the same flag: when true AND a GitHub check
   * run was opened for this deploy, the smoke conclusion PATCHes the
   * run (or appends a second check run named "CDS Smoke") so the PR
   * Checks panel also reports smoke status.
   */
  autoSmokeEnabled?: boolean;
  /**
   * 项目的虚拟 cds-compose.yml —— 配置 SSOT（2026-05-29）。
   *
   * 历史上 composeYaml 只存在于临时 PendingImport（审批快照），批准后被
   * 解析成 build profiles / infra / env 散装落库，**原始 yaml 当场丢弃**。
   * 结果：repo 结构变了没人知道 profile 漂移（mdimp 案例），agent 也无从
   * 通过技能读改一份权威配置。这几个字段把虚拟 compose 提升为 Project 的
   * 一等公民：approve / 手动编辑 / repo 同步都写这里，下游 profile/infra
   * 都视为它的派生物。
   *
   * - `composeYaml`：最近一次生效的完整 cds-compose.yml 文本（verbatim）
   * - `composeUpdatedAt`：最近写入时间
   * - `composeVersion`：单调递增版本号，每次写入 +1（供漂移检测 / 回滚）
   * - `composeSource`：本次写入来源，便于面板标注「谁改的」
   *
   * 字段缺省（老 project）时 GET 接口回退到「从已落库的 profile/infra
   * 反向拼一份只读视图」，不强制要求历史项目立刻有 composeYaml。
   */
  composeYaml?: string;
  composeUpdatedAt?: string;
  composeVersion?: number;
  composeSource?: 'import-approved' | 'manual-edit' | 'repo-sync';
  /**
   * P5 (per-project settings, migrated from CdsState top-level fields).
   * 历史上以下字段都挂在 state.xxx 全局根，多项目时全局值会跨项目串扰。
   * 现在迁到 Project 上，全局值在升级时一次性 seed 进 default 项目。
   * 为兼容老 state.json 这里都是 optional：未设置时读取处兜底到 state.xxx。
   */
  /**
   * 项目级环境变量（旧 state.customEnv['_global'] 的家）。
   * Branch-scoped overrides 仍由 state.customEnv[<branchId>] 承担，
   * 这里只迁移 "项目共享" 这一层。
   */
  customEnv?: Record<string, string>;
  /**
   * 2026-05-01 Phase 8 新增 —— env 三色 metadata(参见 EnvMeta 类型注释)。
   *
   * 项目导入时由 cdscli scan 输出的 x-cds-env-meta 段填入。每个 env key 关联
   * 一个 metadata,告知 CDS 后端 / UI 该字段是 required / auto / infra-derived。
   *
   * 用途:
   *   - deploy 路由 block:任何 kind='required' 且 customEnv 中 value 为空 →
   *     返回 412 Precondition Failed,deploy 不启动
   *   - UI 弹窗:导入项目后强制用户感知必填项,不填不让 deploy
   *
   * 项目导入后用户在 CDS UI 编辑 env 时,如果新增了 envMeta 没覆盖到的 key,
   * 默认按 'auto' 处理(不 block)。
   */
  envMeta?: Record<string, EnvMeta>;
  /**
   * 2026-05-01 Phase 9.5 新增 —— env 修改审计日志(ring buffer ≤ 200 条)。
   * 每次 customEnv 变更追加一条,GET /api/env/audit?scope=<projectId> 可读。
   * 不记 value,只记 keys(避免密钥进日志泄漏)。
   */
  envChangeLog?: EnvChangeLogEntry[];
  /**
   * 2026-05-01 Phase 8 新增 —— 项目级默认 env(给新分支继承用)。
   *
   * 用户在 main 分支填了 SMTP_PASSWORD / OAUTH_SECRET 等密钥后,新开 feat/xxx
   * 分支时自动继承,不需要重填。`Project.defaultEnv` 是"项目级模板",所有
   * 新建分支的 customEnv 默认从这里 copy。
   *
   * 与 Project.customEnv 区别:
   *   - customEnv:运行时实际生效的项目级 env(reconcile 注入到容器)
   *   - defaultEnv:作为模板供新分支创建时拷贝的初始值;不直接生效
   *
   * 通常 defaultEnv == customEnv 同步更新(用户填一次,既写当前项目又写模板),
   * 但保留两个字段是为了未来支持"项目设置 env 不立即生效,先存 defaultEnv,
   * 下次 deploy 才生效"等高级场景。
   */
  defaultEnv?: Record<string, string>;
  /**
   * Project-level template for new branches only.
   *
   * Key = BuildProfile.id, value = deploy mode id. When a new branch is
   * created, CDS copies these values into BranchEntry.profileOverrides so the
   * branch owns its runtime mode from that point onward. Updating this field
   * never mutates existing branches and never writes BuildProfile.activeDeployMode.
   */
  defaultDeployModes?: Record<string, string>;
  /**
   * 2026-05-14: 项目级 "运行 N 分钟后自动切发布版" 策略。
   * - 0 / 缺省 / 未启用：禁用。
   * - >0：从 BranchEntry.lastReadyAt（容器进入 running 状态时打戳）计时；
   *   超过 N 分钟仍是源码 / 热加载模式且当前 running，则将所有 profileOverrides 的
   *   activeDeployMode 翻转到 profile.deployModes 里第一个被 classifyDeployRuntime
   *   判定为 'release' 的模式，并停止容器；用户下次访问会被 auto-build 路径以发布
   *   模式拉起来。
   * 时间锚点 = lastReadyAt（部署成绿色），而不是 HTTP 流量，避免长连接永远刷新。
   */
  autoPublishAfterMinutes?: number;
  /**
   * 2026-06-24：项目级「发布(部署)阶段就绪探测下限秒数」覆盖。覆盖系统默认
   * （CdsState.deployReadinessFloorSeconds，未设则 1200）。仅作用于**部署首启**的
   * 就绪等待（取 max(该 profile 的 timeoutSeconds, 此下限)），运行期重启/唤醒不受影响。
   * 给构建慢 / JVM 暖机慢的项目留足发布探测时间，避免被探活超时误杀。
   */
  deployReadinessFloorSeconds?: number;
  /**
   * Deprecated: 旧版项目级 "运行 N 分钟后自动停止" 策略。
   * 自动停止已收敛到 CDS 系统级 SchedulerService，避免项目设置中出现
   * 两个互相打架的分钟值。字段保留仅用于兼容旧 state/API，运行时不再执行。
   */
  autoStopAfterMinutes?: number;
  /**
   * 当 routing rules 都不匹配时回退到的分支 id（旧 state.defaultBranch）。
   * 历史上是机器级单值，多项目时会 cross-talk —— 现在每个项目独立。
   */
  defaultBranch?: string | null;
  /**
   * Preview 路由策略（旧 state.previewMode）。'simple' = cookie switch + 主域名，
   * 'port' = 动态端口，'multi' = 每分支独立子域。默认 'multi'。
   */
  previewMode?: 'simple' | 'port' | 'multi';
  /**
   * GitHub PR 评论模板（旧 state.commentTemplate）。不同项目可能有不同的
   * repo 命名约定 / 评审流程，模板 per-project 更合理。空 body = 用默认。
   */
  commentTemplate?: CommentTemplateSettings;
  /**
   * PR_C.1 起新增的项目级运营计数。每次部署 / 拉取 / 调试 / AI 操作时
   * 由 StateService 内部 helper 自增。所有字段 optional，未设视作 0。
   */
  /** 该项目下成功完成的部署次数（POST /branches/:id/deploy 全部 services 完成）。 */
  deployCount?: number;
  /** 拉取代码次数（POST /branches/:id/pull 成功）。 */
  pullCount?: number;
  /** 容器停止次数（POST /branches/:id/stop）。 */
  stopCount?: number;
  /** 该项目下任何分支被 AI agent 占用过的总次数。 */
  aiOpCount?: number;
  /** 该项目下分支被标记 / 取消调试灯泡的总切换次数。 */
  debugCount?: number;
  /** 最近一次 AI 占用的 ISO 时间戳。 */
  lastAiOccupantAt?: string;
  /** 最近一次成功拉取代码的 ISO 时间戳。 */
  lastPullAt?: string;
  /** 最近一次成功部署完成的 ISO 时间戳（不是触发时间）。 */
  lastDeployAt?: string;
  /**
   * 2026-06-23：项目级「暂停」开关。设为 true 时**冻结整个项目**——
   * 拒绝所有自动部署（webhook push/PR）、拒绝手动 deploy、reconciler 不再
   * 重试该项目的 stale dispatch、scheduler/auto-lifecycle 跳过该项目。
   * 暂停动作同时会停止该项目所有分支正在运行的容器（释放 CPU/内存）。
   *
   * 用途：长期不用却频繁被 webhook 触发反复构建的项目，无需删除即可
   * 一键冻结止血；恢复后用户手动重新部署即可。缺省 / undefined 视作未暂停。
   */
  paused?: boolean;
  /** 最近一次被暂停的 ISO 时间戳（恢复时清空）。 */
  pausedAt?: string;
  /** 发起暂停的操作者（actor 字符串，如 'user' / 'ai:xxx' / 'system'）。 */
  pausedBy?: string;
  /** 暂停原因（可选，用户在暂停时填写，UI 展示）。 */
  pauseReason?: string;
  /**
   * PR_D.1: 项目级 GitHub 事件 policy。每个字段对应一类 webhook 事件，
   * undefined / true → 处理（默认行为，与 PR_D 之前一致），false → 短路忽略。
   *
   * 旧 githubAutoDeploy 字段会作为 push 的兜底（policy.push undefined 时
   * 仍读 githubAutoDeploy），保证向后兼容。
   *
   * 设计原则：保留单字段而不是 enum 对象，方便 settings UI 直接渲染
   * 5 个独立 toggle；新增事件类型时在 schema 加字段 + UI 加一行即可。
   */
  githubEventPolicy?: {
    /** push 自动建分支 + 部署。undefined 时 fallback 到 githubAutoDeploy。 */
    push?: boolean;
    /** GitHub 删分支 → 自动停容器 + 清理。 */
    delete?: boolean;
    /** PR closed/merged → 自动停容器。 */
    prClose?: boolean;
    /** PR opened/reopened → 自动建分支 + 部署。 */
    prOpen?: boolean;
    /** PR 评论里的 /cds slash 命令。 */
    slashCommand?: boolean;
  };
}

/**
 * A project-scoped Agent Key. Plaintext is never persisted — only the
 * sha256 hash. Scope is always 'rw' in the current implementation;
 * kept as a field so a later read-only tier can slot in without a
 * schema migration.
 */
export interface AgentKey {
  /** Random 8-hex id, used for revocation by keyId. */
  id: string;
  /** Human-readable label, e.g. "签发于 2026-04-18 10:32" or user-supplied. */
  label: string;
  /** sha256 hex of the plaintext key (`cdsp_<slug>_<base64url suffix>`). */
  hash: string;
  /** Permission scope. Always 'rw' — a placeholder for future tiers. */
  scope: 'rw';
  /** ISO timestamp of sign time. */
  createdAt: string;
  /** GitHub login of the signer if github auth mode, else undefined. */
  createdBy?: string;
  /** ISO timestamp updated (best-effort) each time the key authenticates. */
  lastUsedAt?: string;
  /** ISO timestamp set by DELETE — revoked keys stay in state for audit. */
  revokedAt?: string;
}

/**
 * 授权申请(Access Request)— agent 直接发起、等用户右下角一键批准的记录。
 *
 * 零前置:agent 无需任何预置密钥就能 POST 发起(免密 + 按项目限量,防刷)。发起时
 * CDS 当场生成一个一次性「轮询票据」(pollToken),只返回给发起方,用于之后取结果。
 * 生命周期:pending --(用户批准)--> approved(签发授权密钥) / --(拒绝)--> rejected。
 * 批准时把全权项目 AgentKey 的**明文**临时挂在 issuedKeyPlaintext 上,发起方凭
 * pollToken 轮询取走一次;取走后明文清空、deliveredAt 落时间戳(一次性交付)。
 */
export interface AccessRequest {
  /** Random 12-hex id. */
  id: string;
  /** 目标项目 id(单项目)。 */
  projectId: string;
  /** sha256 of the one-time pollToken issued at submit. Only the submitter holds the plaintext. */
  pollTokenHash: string;
  /** 申请方名称(body 传入),用户审批时可见。 */
  agentName: string;
  /** 申请理由,用户审批时可见。 */
  purpose: string;
  /** Lifecycle: starts 'pending', moves to 'approved' or 'rejected'. */
  status: 'pending' | 'approved' | 'rejected';
  /** ISO submit time. */
  createdAt: string;
  /** Set when status flips away from 'pending'. */
  decidedAt?: string;
  /** GitHub login / 'cookie' / 'global-key' — who decided. */
  decidedBy?: string;
  /** 拒绝原因(status='rejected' 时可选)。 */
  rejectReason?: string;
  /** 批准时签发的授权密钥(项目 AgentKey)的 id,留作审计/吊销。 */
  issuedKeyId?: string;
  /**
   * 批准时签发的授权密钥**明文**,仅在「已批准未交付」窗口存在。agent 轮询取走
   * 一次后清空 —— 一次性交付,不长期持久化明文。
   */
  issuedKeyPlaintext?: string;
  /** agent 轮询取走授权密钥明文的时间。置位后再轮询不再返回明文。 */
  deliveredAt?: string;
}

/**
 * Global (bootstrap-equivalent) Agent Key — NOT scoped to any project.
 *
 * Project-scoped AgentKey (`cdsp_<slug12>_<suffix>`) can't create projects
 * (see routes/projects.ts POST handler → 403 project_key_cannot_create),
 * which creates a chicken-and-egg problem: an AI assistant needs a key to
 * call POST /api/projects, but the only keys it can obtain from the UI
 * are project-scoped.
 *
 * GlobalAgentKey solves that by issuing a prefix-distinct `cdsg_<suffix>`
 * key that behaves like the bootstrap AI_ACCESS_KEY: no project scope
 * enforcement, can create/delete projects and work across project boundaries.
 *
 * Security note: because this is bootstrap-equivalent, the UI that issues
 * it MUST show a loud warning ("don't hand this out casually"). The user
 * is expected to mint one, hand it to a specific Agent, and revoke it
 * after that Agent finishes provisioning.
 *
 * Storage parallels AgentKey: only sha256 of the plaintext is persisted;
 * plaintext is shown once at signing time.
 */
export interface GlobalAgentKey {
  /** Random 8-hex id, used for revocation by keyId. */
  id: string;
  /** Human-readable label, e.g. "bootstrap for prd-agent Claude 2026-04-18". */
  label: string;
  /** sha256 hex of the plaintext key (`cdsg_<base64url suffix>`). */
  hash: string;
  /** Permission scope. Always 'rw' — a placeholder for future tiers. */
  scope: 'rw';
  /** ISO timestamp of sign time. */
  createdAt: string;
  /** GitHub login of the signer if github auth mode, else undefined. */
  createdBy?: string;
  /** ISO timestamp updated (best-effort) each time the key authenticates. */
  lastUsedAt?: string;
  /** ISO timestamp set by DELETE — revoked keys stay in state for audit. */
  revokedAt?: string;
}

/**
 * A trusted remote CDS instance. Used as the source or target of a data
 * migration without having to copy around hostnames, ports, and mongo auth —
 * the remote CDS exposes its local infra MongoDB via authenticated
 * streaming endpoints (see /api/data-migrations/local-dump / local-restore).
 *
 * Auth = the remote CDS's AI_ACCESS_KEY (same key used by the AI bridge).
 * Transport = HTTPS (preview.miduo.org terminates TLS), so the stream is
 * encrypted end-to-end without any manual SSH/tunnel setup.
 */
export interface CdsPeer {
  id: string;
  /** Human-readable name, e.g. "生产 CDS" */
  name: string;
  /** Base URL of the remote CDS API, e.g. "https://main.miduo.org" */
  baseUrl: string;
  /** AI_ACCESS_KEY of the remote CDS (sent as X-AI-Access-Key header) */
  accessKey: string;
  createdAt: string;
  /** Last verified connection timestamp */
  lastVerifiedAt?: string;
  /** Remote infra MongoDB label captured during last verify (for display) */
  remoteLabel?: string;
}

/** SSH tunnel configuration for data migration */
export interface SshTunnelConfig {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  /** Private key path on CDS host, or 'agent' for ssh-agent */
  privateKeyPath?: string;
  /** Password auth (less secure, prefer key-based) */
  password?: string;
  /**
   * Optional: when set, the mongodump/mongorestore command on the remote
   * jump host is wrapped in `docker exec <container> sh -c '...'`. Use this
   * when the remote host only has MongoDB inside a container and the tools
   * aren't on the jump host's PATH. Matches the manual recipe:
   *   ssh root@host "docker exec mongo-container sh -c 'mongodump --archive --gzip'"
   */
  dockerContainer?: string;
}

/** MongoDB connection configuration for data migration */
export interface MongoConnectionConfig {
  /**
   * Connection mode:
   * - 'local'  : the CDS infra MongoDB running on this host
   * - 'remote' : a custom host:port (optional SSH tunnel)
   * - 'cds'    : a registered remote CDS peer (auto-auth via X-AI-Access-Key)
   */
  type: 'local' | 'remote' | 'cds';
  host: string;
  port: number;
  /** Database name (empty = all databases) */
  database?: string;
  /** Auth username */
  username?: string;
  /** Auth password */
  password?: string;
  /** Auth source database */
  authDatabase?: string;
  /** SSH tunnel for this connection (only used when type === 'remote') */
  sshTunnel?: SshTunnelConfig;
  /** CDS peer id (only used when type === 'cds') */
  cdsPeerId?: string;
}

/** A data migration task */
export interface DataMigration {
  id: string;
  /** Display name */
  name: string;
  /** Database type (extensible: 'mongodb', future: 'redis', 'postgres', etc.) */
  dbType: 'mongodb';
  /** Source connection */
  source: MongoConnectionConfig;
  /** Target connection */
  target: MongoConnectionConfig;
  /** Specific collections to migrate (empty/undefined = all collections) */
  collections?: string[];
  /** Migration status */
  status: 'pending' | 'running' | 'completed' | 'failed';
  /** Progress percentage 0-100 */
  progress: number;
  /** Current step description */
  progressMessage?: string;
  /** Error message if failed */
  errorMessage?: string;
  createdAt: string;
  /** Last modification timestamp (set by PUT /:id) */
  updatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  /** Migration log output */
  log?: string;
}

/** Volume mount for an infrastructure service */
export interface InfraVolume {
  /** Docker named volume name (e.g., 'cds-mongodb-data') or host path for bind mounts */
  name: string;
  /** Mount path inside the container */
  containerPath: string;
  /** Mount type: 'volume' (Docker named volume) or 'bind' (host path) */
  type?: 'volume' | 'bind';
  /** Read-only mount flag */
  readOnly?: boolean;
}

/** Health check configuration for infrastructure service */
export interface InfraHealthCheck {
  /** Command to run inside the container */
  command: string;
  /** Interval in seconds (default: 10) */
  interval: number;
  /** Number of retries before marking unhealthy */
  retries: number;
}

/** An infrastructure service managed by CDS (e.g., MongoDB, Redis) */
export interface InfraService {
  /** Unique identifier (e.g., 'mongodb', 'redis'). 2nd+ same-type instance: '<preset>-2'. */
  id: string;
  /**
   * Visibility and ownership scope.
   *
   * project: user/project-owned infrastructure that belongs on project cards
   * system: CDS control-plane infrastructure, such as its own state store
   */
  scope?: 'project' | 'system';
  /**
   * Project this infra service belongs to. PR_B.1 起为必填 —
   * migrateProjectScoping() 启动时只把 project scope 服务补齐到 legacy project。
   */
  projectId: string;
  /** Display name */
  name: string;
  /** Docker image to use */
  dockerImage: string;
  /** Port the service listens on inside the container */
  containerPort: number;
  /** Host port mapped to the container */
  hostPort: number;
  /** Docker container name */
  containerName: string;
  /** Current status */
  status: 'running' | 'stopped' | 'error';
  /** Error message if status is 'error' */
  errorMessage?: string;
  /** Base catalog preset id this instance derives from (e.g. 'postgres' for both 'postgres' and 'postgres-2'). */
  basePresetId?: string;
  /** User-chosen database name for schemaful stores (default "app"). Threaded into env + connection strings. */
  dbName?: string;
  /** Initialization SQL/commands configured at creation; run against the store via the data panel. */
  initSql?: string;
  /** Persistent volumes */
  volumes: InfraVolume[];
  /** Environment variables for the container itself */
  env: Record<string, string>;
  /** Health check configuration */
  healthCheck?: InfraHealthCheck;
  /**
   * 2026-05-28:容器启动命令(yaml `command:`)。docker run 时拼到 image 之后。
   * 历史漏掉这个字段导致 minio/elasticsearch 这类需要子命令的 image 无法启动。
   */
  command?: string | string[];
  /** Docker `--entrypoint` 覆盖,与 image 默认 ENTRYPOINT 不一致时使用 */
  entrypoint?: string | string[];
  /**
   * Docker `--restart` 策略。默认 `on-failure:3`(2026-05-28 起,从旧硬编码
   * `unless-stopped` 改来)。可在 yaml 用 `restart:` 字段覆盖。
   */
  restartPolicy?: string;
  /** When this service was created */
  createdAt: string;
}

/** CDS running mode */
export type CdsMode = 'standalone' | 'scheduler' | 'executor';

/** An executor node (remote or local) that runs containers */
export interface ExecutorNode {
  id: string;
  host: string;
  port: number;
  status: 'online' | 'offline' | 'draining';
  /**
   * Node capacity. `maxBranches` is historically named but now represents
   * "max container slots" — a single branch can have 1..N containers
   * (API + admin + DB + ...) so counting branches understates capacity.
   * Formula: `(totalMemGB - 1) * 2`, matching the existing local dashboard.
   */
  capacity: { maxBranches: number; memoryMB: number; cpuCores: number };
  load: { memoryUsedMB: number; cpuPercent: number };
  labels: string[];
  /** Branch IDs deployed on this executor */
  branches: string[];
  /**
   * Total number of running containers across all branches on this executor.
   * Computed from the heartbeat's `branches[id].services` map — each service
   * entry with status=running contributes one container. Undefined for a
   * freshly-registered node that hasn't sent a heartbeat yet.
   */
  runningContainers?: number;
  lastHeartbeat: string;
  registeredAt: string;
  /**
   * Role of this executor in the cluster:
   *   - `embedded`: the master itself, deploys via local standalone path (no HTTP)
   *   - `remote`:   a separately-hosted executor reached via /exec/deploy HTTP API
   * Default: `remote` (backward compatible).
   * See `doc/design.cds.cluster-bootstrap.md` §4.3.
   */
  role?: 'embedded' | 'remote';
}

/**
 * Aggregated capacity of all online executors. Exposed via
 * `GET /api/executors/capacity` so Dashboard and external monitors can see
 * how cluster-wide resources grow as executors join.
 *
 * See `doc/design.cds.cluster-bootstrap.md` §4.3.
 */
export interface ClusterCapacity {
  online: number;
  offline: number;
  total: { maxBranches: number; memoryMB: number; cpuCores: number };
  used: { branches: number; memoryMB: number; cpuPercent: number };
  /** Overall free capacity (0-100), weighted average of mem + cpu + branch slots. */
  freePercent: number;
  nodes: Array<{
    id: string;
    role: 'embedded' | 'remote';
    host: string;
    status: ExecutorNode['status'];
    capacity: ExecutorNode['capacity'];
    load: ExecutorNode['load'];
    branchCount: number;
  }>;
}

/**
 * Janitor (Phase 2) config — worktree TTL cleanup + disk watermark warning.
 * See `doc/design.cds.resilience.md` Phase 2.
 */
export interface JanitorConfig {
  /** Enable the janitor. Default: true. */
  enabled: boolean;
  /** Remove worktrees and local containers not touched in this many days. Default: 7, max: 7. */
  worktreeTTLDays: number;
  /** Emit warning when disk usage exceeds this percent. Default: 80. */
  diskWarnPercent: number;
  /** How often to run the sweep. Default: 3600 (hourly). */
  sweepIntervalSeconds: number;
}

/**
 * Warm-pool scheduler configuration.
 * When `enabled=false`, the scheduler becomes a no-op and CDS behaves exactly
 * like pre-v3.1 (all branches stay running until manually stopped).
 * See `doc/design.cds.resilience.md` for the design rationale.
 */
export interface SchedulerConfig {
  /** Enable warm-pool scheduling. Default: false (backward compatible). */
  enabled: boolean;
  /**
   * Maximum number of HOT branches allowed simultaneously.
   * When exceeded, the LRU non-pinned branch is cooled.
   * 0 = unlimited (scheduler only handles idle TTL).
   */
  maxHotBranches: number;
  /** Idle time (seconds) after which a HOT branch is auto-cooled. Default: 900 (15 min). */
  idleTTLSeconds: number;
  /** Background tick interval (seconds) for idle + capacity checks. Default: 60. */
  tickIntervalSeconds: number;
  /** Branch slugs that are always pinned (in addition to the default branch). */
  pinnedBranches: string[];
}

/** Application configuration */
export interface CdsConfig {
  repoRoot: string;
  /**
   * Base directory that houses every per-project git clone for the
   * multi-repo flow introduced in P4 Part 18 (G1). Each project's
   * repo lives at `${reposBase}/${projectId}`. When undefined (the
   * pre-G1 default), every project falls back to the top-level
   * `repoRoot`, preserving legacy single-repo behavior.
   *
   * Typically wired from `CDS_REPOS_BASE=/repos` in exec_cds.sh and
   * mounted as a persistent host volume so cloned repos survive
   * container rebuilds (self-update). When neither `CDS_REPOS_BASE` nor
   * a stored config value is present, CDS auto-defaults to
   * `${repoRoot}/.cds-repos` so fresh installs work without manual
   * configuration.
   */
  reposBase?: string;
  /** How `reposBase` was resolved: explicit env var, loaded from config file,
   *  or auto-defaulted. Surfaced in `GET /api/config` for UI display. */
  reposBaseSource?: 'env' | 'file' | 'default';
  worktreeBase: string;
  /** Master dashboard port */
  masterPort: number;
  /** Worker proxy port (all traffic) */
  workerPort: number;
  /** Docker network name */
  dockerNetwork: string;
  /** Port range start for branch services */
  portStart: number;
  /** Shared environment variables (reserved, currently empty) */
  sharedEnv: Record<string, string>;
  /** Switch domain for branch switching (e.g., "switch.example.com") */
  switchDomain?: string;
  /** Main domain to redirect to after switching (e.g., "example.com") */
  mainDomain?: string;
  /** Dashboard domain for CDS UI (e.g., "cds.example.com" or "example.com") */
  dashboardDomain?: string;
  /** Root domains handled by nginx. Exact root -> dashboard, any subdomain -> preview. */
  rootDomains?: string[];
  /** Preview domain suffix for subdomain-based preview (e.g., "preview.example.com").
   *  Each branch gets its own subdomain: <slug>.preview.example.com */
  previewDomain?: string;
  /** JWT settings (passed through to branch services) */
  jwt: {
    secret: string;
    issuer: string;
  };
  /** CDS running mode: standalone (default), scheduler, or executor */
  mode: CdsMode;
  /** (executor mode) URL of the scheduler to register with */
  schedulerUrl?: string;
  /** (executor mode) Port for the executor agent API */
  executorPort: number;
  /** Permanent shared token for scheduler ↔ executor authentication (post-bootstrap). */
  executorToken?: string;
  /**
   * One-shot bootstrap token used by a fresh executor to register with the master.
   * Generated by `./exec_cds.sh issue-token` on the master, handed to the new
   * executor via `./exec_cds.sh connect <master> <token>`, and consumed on the
   * first successful `/api/executors/register` call. Default TTL: 15 minutes.
   * See `doc/design.cds.cluster-bootstrap.md` §4.2.
   */
  bootstrapToken?: {
    /** Random hex token value. */
    value: string;
    /** ISO timestamp when this token stops being accepted. */
    expiresAt: string;
  };
  /**
   * (executor mode only) URL of the master node the executor connects to.
   * Distinct from `schedulerUrl`: `masterUrl` is the user-facing external URL
   * written to `.cds.env` by `./exec_cds.sh connect`, while `schedulerUrl` is
   * the internal field consumed by `ExecutorAgent`. We keep both so the
   * env-file format stays intuitive while internal code stays stable.
   */
  masterUrl?: string;
  /**
   * Warm-pool scheduler config (v3.1). Optional; absent or enabled=false keeps
   * legacy behavior where all branches stay running.
   */
  scheduler?: SchedulerConfig;
  /**
   * Janitor config (v3.1 Phase 2). Optional; absent or enabled=false disables
   * TTL cleanup (disk warnings still work if enabled).
   */
  janitor?: JanitorConfig;
  /**
   * GitHub App credentials powering the Railway-style check-run
   * integration. When every field is set, CDS:
   *   1. Accepts webhook events at POST /api/github/webhook
   *   2. Auto-creates+deploys branches for pushes on linked projects
   *   3. Posts "CDS Deploy" check runs back to GitHub so the PR's
   *      Checks panel shows the preview URL + success/failure
   *
   * Partially-set config (e.g. appId without privateKey) leaves the
   * feature dormant — the webhook route returns 503 not_configured
   * and deploys skip check-run creation silently.
   */
  githubApp?: GitHubAppConfig;
  /**
   * Public base URL of this CDS install (e.g. "https://cds.miduo.org").
   * Used as the `details_url` in GitHub check runs and for the
   * GitHub App install-callback redirect. Falls back to the
   * CDS_PUBLIC_BASE_URL env var consumed by auth.ts.
   */
  publicBaseUrl?: string;
}

/**
 * GitHub App credentials. `appId` + `privateKey` together mint
 * installation access tokens (RS256 JWT → POST /app/installations/
 * {id}/access_tokens), which write check runs. `webhookSecret` is
 * the HMAC-SHA256 secret configured in the App settings and used to
 * verify X-Hub-Signature-256 on every incoming webhook.
 *
 * `appSlug` is the lowercase App slug (e.g. "cds-deploy") used only
 * for rendering the install URL on the Settings page. Optional
 * because GitHub doesn't require it for any API call — it's UI sugar.
 */
export interface GitHubAppConfig {
  /** Numeric App ID from https://github.com/settings/apps/<slug>. */
  appId: string;
  /** RSA private key in PEM format (BEGIN RSA PRIVATE KEY …). */
  privateKey: string;
  /** Webhook signing secret configured in the App settings. */
  webhookSecret: string;
  /** Lowercase App slug, used only for `https://github.com/apps/<slug>/installations/new` links. */
  appSlug?: string;
}

/** Shell execution result */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Merge stdout + stderr */
export function combinedOutput(result: { stdout: string; stderr: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join('\n');
}

export interface ExecOptions {
  cwd?: string;
  timeout?: number;
  onData?: (chunk: string) => void;
  /** 环境变量覆盖。提供时与 process.env 合并(本字段后写覆盖)。
   *  2026-05-06 起 self-update / web build 不再下发 NODE_OPTIONS 上限,V8 自适应主机 RAM。 */
  env?: Record<string, string>;
}

export interface IShellExecutor {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
}
