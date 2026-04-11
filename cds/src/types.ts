// ── Cloud Development Suite (CDS) — Core Types ──

/** A routing rule that maps incoming requests to a branch */
export interface RoutingRule {
  id: string;
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
}

/** Readiness probe configuration for app services */
export interface ReadinessProbe {
  /** HTTP path to check (e.g., "/health", "/api/health"). Default: "/" */
  path?: string;
  /** Seconds between checks (default: 5) */
  intervalSeconds?: number;
  /** Max seconds to wait for readiness (default: 300 = 5min) */
  timeoutSeconds?: number;
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
  /** Original git branch name */
  branch: string;
  worktreePath: string;
  /** Per-profile container state */
  services: Record<string, ServiceState>;
  /** Overall branch status */
  status: 'idle' | 'building' | 'starting' | 'running' | 'stopping' | 'error';
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
}

/** State of a single service (one build profile instance) within a branch */
export interface ServiceState {
  profileId: string;
  containerName: string;
  /** Host port allocated for this service */
  hostPort: number;
  status: 'idle' | 'building' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error';
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
  /** Default branch (used when no routing rule matches) */
  defaultBranch: string | null;
  /** User-defined environment variables (sent to containers on deploy) */
  customEnv: Record<string, string>;
  /** CDS-managed infrastructure services (databases, caches, etc.) */
  infraServices: InfraService[];
  /** Mirror acceleration enabled (npm/docker registry mirrors for faster builds in China) */
  mirrorEnabled?: boolean;
  /** Tab title override enabled (updates browser tab title with tag or branch short name) */
  tabTitleEnabled?: boolean;
  /** Preview mode: 'simple' (cookie switch + main domain), 'port' (dynamic preview port), 'multi' (subdomain per branch). Default: 'multi' */
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
