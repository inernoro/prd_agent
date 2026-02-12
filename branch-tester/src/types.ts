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
}

export interface IShellExecutor {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
}
