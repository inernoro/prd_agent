export interface BranchEntry {
  id: string;
  branch: string;
  worktreePath: string;

  // ── Deploy mode (artifact-based, via nginx gateway) ──
  containerName: string;
  imageName: string;
  dbName: string;
  /** Original isolated DB name (saved when switching to main DB, for switching back) */
  originalDbName?: string;
  status: 'idle' | 'building' | 'built' | 'running' | 'stopped' | 'error';
  buildLog?: string;
  lastActivatedAt?: string;
  /** Human-readable error message when status === 'error' */
  errorMessage?: string;

  // ── Run mode (source-based, direct port access) ──
  runContainerName?: string;
  runStatus?: 'idle' | 'running' | 'stopped' | 'error';
  hostPort?: number;
  /** Human-readable error message when runStatus === 'error' */
  runErrorMessage?: string;

  createdAt: string;
}

/** A single event recorded during an operation (deploy/run/rerun) */
export interface OperationLogEvent {
  step: string;
  status: string;
  title?: string;
  detail?: Record<string, unknown>;
  log?: string;
  chunk?: string;
  timestamp: string;
}

/** A complete operation log (one deploy or run session) */
export interface OperationLog {
  type: 'deploy' | 'run' | 'rerun';
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'completed' | 'error';
  events: OperationLogEvent[];
}

export interface BtState {
  activeBranchId: string | null;
  history: string[];
  branches: Record<string, BranchEntry>;
  nextPortIndex: number;
  /** Per-branch operation logs (keyed by branch id, most recent last, max 10 per branch) */
  logs: Record<string, OperationLog[]>;
}

export interface BtConfig {
  repoRoot: string;
  worktreeBase: string;
  deployDir: string;
  gateway: {
    containerName: string;
    port: number;
  };
  docker: {
    network: string;
    apiDockerfile: string;
    apiImagePrefix: string;
    containerPrefix: string;
  };
  mongodb: {
    containerHost: string;
    port: number;
    defaultDbName: string;
  };
  redis: {
    connectionString: string;
  };
  jwt: {
    secret: string;
    issuer: string;
  };
  dashboard: {
    port: number;
  };
  /** Run mode settings (source-based running, optional, defaults applied if omitted) */
  run?: {
    /** First host port to allocate (default: 9001) */
    portStart?: number;
    /** SDK base image for running from source (default: mcr.microsoft.com/dotnet/sdk:8.0) */
    baseImage?: string;
    /** Command to run inside the container (default: dotnet run --project src/PrdAgent.Api) */
    command?: string;
    /** Subdirectory of worktree to mount as /src (default: prd-api) */
    sourceDir?: string;
  };
}

/** Options for running a container from source code */
export interface RunFromSourceOptions {
  hostPort: number;
  baseImage: string;
  command: string;
  sourceDir: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Merge stdout + stderr — many CLI tools write to either stream unpredictably */
export function combinedOutput(result: { stdout: string; stderr: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join('\n');
}

export interface ExecOptions {
  cwd?: string;
  timeout?: number;
  /** Called with each chunk of stdout/stderr output in real-time */
  onData?: (chunk: string) => void;
}

export interface IShellExecutor {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
}
