// ── Cloud Development Suite (CDS) — Core Types ──

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
   * Example: 'API listening on: ["http://0.0.0.0:5000"]' for .NET, '➜  Network:' for Vite.
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
   * UI 上带 🔥 标识提醒用户。
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
   * 通过 entrypoint='sh -c' 让我们的 command 直接以 shell 方式执行,绕过 image
   * 的 wrapper。
   *
   * 空字符串(""):等同 docker run --entrypoint="" — 清空 ENTRYPOINT,只跑
   * 我们的 command(被 docker 解释为新的 ENTRYPOINT)。少用。
   *
   * 设置来源:cds-compose 的 `cds.entrypoint` label。
   *
   * 例:
   *   labels:
   *     cds.entrypoint: "sh -c"   # 强制用 sh -c 当 entrypoint
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
 *   ⚠ MSBuild 的 incremental compile 和 dotnet watch 的 hot reload 在我们这个
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
 *   如果还不生效：点 Profile 卡片的「💥 强制干净重建」—— 额外物理删掉 bin/obj，
 *   避免文件系统缓存干扰。
 */
export interface HotReloadConfig {
  /** 是否启用。即使配置了 mode/command，也要 enabled=true 才生效。 */
  enabled: boolean;
  /**
   * 热更新模式预设。
   *   dotnet-run     — ★ 推荐默认（快）：纯 `dotnet run` 走 MSBuild 增量编译，文件变 → kill + 重跑。
   *                    相信 MSBuild 增量；绝大多数场景最快。如偶尔撒谎点 🧹 清理按钮即可。
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
  /** Override Docker image (replaces profile.dockerImage when this mode is active) */
  dockerImage?: string;
  /** Extra/override environment variables merged on top of profile.env */
  env?: Record<string, string>;
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
 * See `doc/design.cds-resilience.md` Phase 2.
 */
export interface ResourceLimits {
  /** Max memory in MB. Docker flag: --memory <N>m */
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
 * See `doc/design.cds-resilience.md` for the full state machine.
 */
export type BranchHeatState = 'hot' | 'warming' | 'cooling' | 'cold';

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
   * See `doc/design.cds-resilience.md` §三.
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
  githubCheckRunId?: number;
  githubInstallationId?: number;
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
  /** 最近一次成功部署完成的 ISO 时间戳。 */
  lastDeployAt?: string;
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

/** A complete operation log */
export interface OperationLog {
  type: 'build' | 'run' | 'auto-build';
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'completed' | 'error';
  events: OperationLogEvent[];
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
  /** Data migration task history */
  dataMigrations?: DataMigration[];
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
   * See doc/design.cds-multi-project.md, doc/spec.cds-project-model.md.
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
    | 'colormark-on'   // 标记调试中
    | 'colormark-off'  // 取消调试中
    | 'ai-occupy'      // AI agent 开始操作
    | 'ai-release'     // AI agent 释放
    | 'branch-deleted' // DELETE /branches/:id
    | 'branch-created' // POST /branches
  ;
  /** 关联分支（如有）。 */
  branchId?: string;
  /** 关联分支的可读名（缓存避免 join）。 */
  branchName?: string;
  /** 触发者：用户名 / agent 标识 / "system"。 */
  actor?: string;
  /** 自由文本，可空。展示用，<= 200 字符。 */
  note?: string;
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
   * Project kind. 'git' is the only value Part 1 creates; 'manual'
   * lands in P6 when users can upload their own compose.
   */
  kind: 'git' | 'manual';
  /** Optional Git repository URL; populated for auto-created legacy projects from CdsConfig.repoRoot. */
  gitRepoUrl?: string;
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
  /** 最近一次成功部署完成的 ISO 时间戳（不是触发时间）。 */
  lastDeployAt?: string;
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
  /** Unique identifier (e.g., 'mongodb', 'redis') */
  id: string;
  /**
   * Project this infra service belongs to. PR_B.1 起为必填 —
   * migrateProjectScoping() 启动时把所有 pre-P4 服务补齐到 legacy project。
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
  /** Persistent volumes */
  volumes: InfraVolume[];
  /** Environment variables for the container itself */
  env: Record<string, string>;
  /** Health check configuration */
  healthCheck?: InfraHealthCheck;
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
   * See `doc/design.cds-cluster-bootstrap.md` §4.3.
   */
  role?: 'embedded' | 'remote';
}

/**
 * Aggregated capacity of all online executors. Exposed via
 * `GET /api/executors/capacity` so Dashboard and external monitors can see
 * how cluster-wide resources grow as executors join.
 *
 * See `doc/design.cds-cluster-bootstrap.md` §4.3.
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
 * See `doc/design.cds-resilience.md` Phase 2.
 */
export interface JanitorConfig {
  /** Enable the janitor. Default: false (backward compatible). */
  enabled: boolean;
  /** Remove worktrees not accessed in this many days. Default: 30. */
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
 * See `doc/design.cds-resilience.md` for the design rationale.
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
   * container rebuilds (self-update).
   */
  reposBase?: string;
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
   * See `doc/design.cds-cluster-bootstrap.md` §4.2.
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
}

export interface IShellExecutor {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
}
