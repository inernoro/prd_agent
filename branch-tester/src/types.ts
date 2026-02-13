export interface BranchEntry {
  id: string;
  branch: string;
  worktreePath: string;

  // ── Deploy mode (artifact-based, via nginx gateway) ──
  containerName: string;
  imageName: string;
  dbName: string;
  status: 'idle' | 'building' | 'built' | 'running' | 'stopped' | 'error';
  buildLog?: string;
  lastActivatedAt?: string;

  // ── Run mode (source-based, direct port access) ──
  runContainerName?: string;
  runStatus?: 'idle' | 'running' | 'stopped';
  hostPort?: number;

  createdAt: string;
}

export interface BtState {
  activeBranchId: string | null;
  history: string[];
  branches: Record<string, BranchEntry>;
  nextPortIndex: number;
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
