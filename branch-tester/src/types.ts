export interface BranchEntry {
  id: string;
  branch: string;
  worktreePath: string;
  containerName: string;
  imageName: string;
  dbName: string;
  status: 'idle' | 'building' | 'built' | 'running' | 'stopped' | 'error';
  buildLog?: string;
  createdAt: string;
  lastActivatedAt?: string;
  /** Host port allocated for quick-run (direct access without nginx gateway) */
  hostPort?: number;
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
  /** Quick-run settings (optional, defaults applied if omitted) */
  run?: {
    /** First host port to allocate for quick-run containers (default: 9001) */
    portStart?: number;
    /** Mount path inside container for admin static files (default: /app/wwwroot) */
    adminMount?: string;
  };
}

/** Options for starting a container with extra Docker flags */
export interface StartOptions {
  /** Expose container port 8080 on this host port (-p flag) */
  exposePort?: number;
  /** Volume mounts (-v flag), e.g. ["/host/path:/container/path:ro"] */
  volumes?: string[];
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
