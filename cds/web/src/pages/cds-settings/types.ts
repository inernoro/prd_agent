export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'ok'; data: T }
  | { status: 'error'; message: string };

export interface MeResponse {
  username?: string;
  login?: string;
  user?: string;
  authMode?: string;
  authEnabled?: boolean;
  session?: {
    createdAt?: string;
    expiresAt?: string;
  };
}

export interface AuthStatusResponse {
  mode?: 'disabled' | 'basic' | 'github' | string;
  enabled?: boolean;
  logoutEndpoint?: string | null;
  user?: {
    username?: string;
    githubLogin?: string;
    name?: string;
    email?: string;
  } | null;
}

export interface ClusterStatus {
  mode?: string;
  effectiveRole?: string;
  masterUrl?: string;
  remoteExecutorCount?: number;
  strategy?: string;
  capacity?: {
    online?: number;
    offline?: number;
    freePercent?: number;
    total?: {
      maxBranches?: number;
      memoryMB?: number;
      cpuCores?: number;
    };
    used?: {
      branches?: number;
      memoryMB?: number;
      cpuPercent?: number;
    };
    totalSlots?: number;
    usedSlots?: number;
  };
}

export interface ExecutorNode {
  id?: string;
  host?: string;
  port?: number;
  role?: string;
  status?: string;
  branchCount?: number;
  runningContainers?: number;
  lastHeartbeat?: string;
  labels?: string[];
  capacity?: {
    maxBranches?: number;
    memoryMB?: number;
    cpuCores?: number;
  };
  load?: {
    memoryUsedMB?: number;
    cpuPercent?: number;
  };
}

export interface ExecutorsResponse {
  executors?: ExecutorNode[];
}

export interface HostStatsResponse {
  mem: {
    totalMB: number;
    freeMB: number;
    usedPercent: number;
  };
  cpu: {
    cores: number;
    loadAvg1: number;
    loadAvg5: number;
    loadAvg15: number;
    loadPercent: number;
  };
  uptimeSeconds: number;
  timestamp: string;
}

export interface GitHubAppResponse {
  configured?: boolean;
  appId?: string | number;
  appSlug?: string;
  installUrl?: string | null;
  publicBaseUrl?: string | null;
  webhookUrl?: string;
}

export interface StorageModeResponse {
  mode?: string;
  kind?: string;
  mongoHealthy?: boolean;
  mongoUri?: string;
  mongoDb?: string;
  targetMode?: string;
  splitCollections?: Array<{
    name: string;
    role: string;
    documents: number;
    note?: string;
  }>;
  startupEnv?: {
    processEnvStorageMode?: string;
    processEnvMongoUriSet?: boolean;
    processEnvMongoDb?: string;
  };
  envFile?: {
    path?: string;
    exists?: boolean;
    hasStorageMode?: boolean;
    storageModeValue?: string;
    hasMongoUri?: boolean;
  };
}

export interface EnvResponse {
  env?: Record<string, string>;
}

export interface ProjectSummary {
  id: string;
  name?: string;
}

export interface ProjectsResponse {
  projects?: ProjectSummary[];
}

export interface CategorizeResponse {
  targetProjectId?: string;
  groups?: Record<string, string[]>;
  summary?: {
    duplicatedCount?: number;
    movedCount?: number;
    duplicateSkippedCount?: number;
    moveSkippedCount?: number;
    globalOnlyCount?: number;
    changeCount?: number;
  };
}

export interface MirrorResponse {
  enabled?: boolean;
}

export interface TabTitleResponse {
  enabled?: boolean;
}
