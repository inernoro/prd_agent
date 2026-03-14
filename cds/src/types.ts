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
}

/** A shared cache mount to avoid duplicating packages across branches */
export interface CacheMount {
  /** Host path (absolute) for the shared cache */
  hostPath: string;
  /** Container path where it gets mounted */
  containerPath: string;
}

/** Branch entry — simplified for CDS */
export interface BranchEntry {
  id: string;
  /** Original git branch name */
  branch: string;
  worktreePath: string;
  /** Per-profile container state */
  services: Record<string, ServiceState>;
  /** Overall branch status */
  status: 'idle' | 'building' | 'running' | 'error';
  errorMessage?: string;
  createdAt: string;
  lastAccessedAt?: string;
  /** User favorite flag — favorites are sorted to the top */
  isFavorite?: boolean;
  /** User notes — free-text annotation shown beside branch name */
  notes?: string;
  /** User tags — labels for filtering and categorization */
  tags?: string[];
}

/** State of a single service (one build profile instance) within a branch */
export interface ServiceState {
  profileId: string;
  containerName: string;
  /** Host port allocated for this service */
  hostPort: number;
  status: 'idle' | 'building' | 'running' | 'stopped' | 'error';
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
  /**
   * Environment variables to auto-inject into all branch containers.
   * Supports {{host}} and {{port}} template placeholders.
   * Standard compose services leave this empty — apps use ${CDS_<SERVICE>_PORT} env var references instead.
   */
  injectEnv: Record<string, string>;
  /** Health check configuration */
  healthCheck?: InfraHealthCheck;
  /** When this service was created */
  createdAt: string;
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
  /** Preview domain suffix for subdomain-based preview (e.g., "preview.example.com").
   *  Each branch gets its own subdomain: <slug>.preview.example.com */
  previewDomain?: string;
  /** JWT settings (passed through to branch services) */
  jwt: {
    secret: string;
    issuer: string;
  };
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
