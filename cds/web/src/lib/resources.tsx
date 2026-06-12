import type { ReactNode } from 'react';
import {
  Braces,
  Cable,
  Code2,
  Database,
  ExternalLink,
  HardDrive,
  KeyRound,
  Network,
} from 'lucide-react';
import dotnetIconUrl from 'devicon/icons/dot-net/dot-net-original.svg';
import goIconUrl from 'devicon/icons/go/go-original.svg';
import javaIconUrl from 'devicon/icons/java/java-original.svg';
import mongoIconUrl from 'devicon/icons/mongodb/mongodb-original.svg';
import mysqlIconUrl from 'devicon/icons/mysql/mysql-original.svg';
import sqlServerIconUrl from 'devicon/icons/microsoftsqlserver/microsoftsqlserver-plain.svg';
import nodeIconUrl from 'devicon/icons/nodejs/nodejs-original.svg';
import phpIconUrl from 'devicon/icons/php/php-original.svg';
import postgresIconUrl from 'devicon/icons/postgresql/postgresql-original.svg';
import pythonIconUrl from 'devicon/icons/python/python-original.svg';
import rabbitIconUrl from 'devicon/icons/rabbitmq/rabbitmq-original.svg';
import redisIconUrl from 'devicon/icons/redis/redis-original.svg';
import rustIconUrl from 'devicon/icons/rust/rust-original.svg';

export type ResourceKind = 'app' | 'database' | 'cache' | 'queue' | 'storage' | 'service';
export type ResourceStatus = 'idle' | 'building' | 'starting' | 'running' | 'restarting' | 'stopping' | 'stopped' | 'error';
export type ResourceAccess = 'internal' | 'external';

export interface BranchResourceServiceInput {
  profileId: string;
  containerName: string;
  hostPort: number;
  status: ResourceStatus;
  errorMessage?: string;
}

export interface BranchResourceProfileInput {
  id: string;
  name?: string;
  dockerImage?: string;
  command?: string;
  workDir?: string;
  containerPort?: number;
  pathPrefixes?: string[];
  dependsOn?: string[];
}

export interface BranchResourceInfraInput {
  id: string;
  name?: string;
  dockerImage?: string;
  containerPort?: number;
  hostPort?: number;
  containerName?: string;
  status?: 'running' | 'stopped' | 'error';
  errorMessage?: string;
  dbName?: string;
  env?: Record<string, string>;
  volumes?: Array<{ name?: string; containerPath: string; type?: string }>;
}

export interface BranchResource {
  id: string;
  source: 'app' | 'infra';
  kind: ResourceKind;
  runtime: string;
  displayName: string;
  serviceName: string;
  branchId?: string;
  branchName?: string;
  projectId?: string;
  port?: number;
  containerPort?: number;
  status: ResourceStatus;
  access: ResourceAccess;
  externalUrl?: string;
  internalUrl?: string;
  connectionString?: string;
  externalAccess?: {
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
    allowlist?: string[];
    expiresAt?: string | null;
  };
  envKeys: string[];
  dependsOn: string[];
  consumers: string[];
  isolation?: 'branch' | 'project-shared';
  capabilities?: Record<string, boolean>;
  cloneTasks?: BranchResourceCloneTask[];
  containerName?: string;
  errorMessage?: string;
  raw: BranchResourceServiceInput | BranchResourceInfraInput;
}

export interface BranchResourceCloneTask {
  id: string;
  projectId: string;
  branchId: string;
  resourceId: string;
  runtime: 'mysql' | 'postgres' | 'sqlserver' | 'mongodb' | 'redis' | 'rabbitmq' | 'unknown';
  mode: 'empty' | 'clone-main' | 'restore-backup' | 'connect-existing';
  strategy: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  progressMessage?: string;
  targetDatabase?: string;
  injectedEnv?: Record<string, string>;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

interface BuildBranchResourcesInput {
  branchId: string;
  branchName: string;
  services: Record<string, BranchResourceServiceInput>;
  profiles?: BranchResourceProfileInput[];
  infraServices?: BranchResourceInfraInput[];
  previewUrl?: string;
}

const RUNTIME_TONE: Record<string, string> = {
  'Node.js': 'text-emerald-500',
  '.NET': 'text-violet-500',
  Python: 'text-blue-500',
  Java: 'text-orange-500',
  Go: 'text-cyan-500',
  Rust: 'text-amber-600',
  PHP: 'text-indigo-500',
  Static: 'text-lime-500',
  MySQL: 'text-cyan-600',
  PostgreSQL: 'text-sky-600',
  'SQL Server': 'text-red-500',
  MongoDB: 'text-emerald-600',
  Redis: 'text-red-500',
  RabbitMQ: 'text-orange-500',
  MinIO: 'text-zinc-500',
};

const iconByRuntime: Record<string, string> = {
  'Node.js': nodeIconUrl,
  '.NET': dotnetIconUrl,
  Python: pythonIconUrl,
  Java: javaIconUrl,
  Go: goIconUrl,
  Rust: rustIconUrl,
  PHP: phpIconUrl,
  MySQL: mysqlIconUrl,
  PostgreSQL: postgresIconUrl,
  'SQL Server': sqlServerIconUrl,
  MongoDB: mongoIconUrl,
  Redis: redisIconUrl,
  RabbitMQ: rabbitIconUrl,
};

function text(parts: Array<string | number | undefined | null>): string {
  return parts.filter((part) => part !== undefined && part !== null && String(part).trim()).join(' ').toLowerCase();
}

function normalizeStatus(status?: string): ResourceStatus {
  if (
    status === 'idle' ||
    status === 'building' ||
    status === 'starting' ||
    status === 'running' ||
    status === 'restarting' ||
    status === 'stopping' ||
    status === 'stopped' ||
    status === 'error'
  ) {
    return status;
  }
  return status === 'running' ? 'running' : 'stopped';
}

export function inferAppRuntime(profile?: BranchResourceProfileInput, service?: BranchResourceServiceInput): string {
  const raw = text([
    profile?.id,
    profile?.name,
    profile?.dockerImage,
    profile?.command,
    profile?.workDir,
    service?.profileId,
    service?.containerName,
  ]);
  if (/dotnet|aspnet|\.net|csharp|csproj/.test(raw)) return '.NET';
  if (/node|pnpm|npm |yarn|vite|next|react|express|nestjs/.test(raw)) return 'Node.js';
  if (/python|pip |uvicorn|fastapi|django|flask/.test(raw)) return 'Python';
  if (/java|maven|gradle|spring/.test(raw)) return 'Java';
  if (/\bgolang\b|\bgo[:\s-]|go run|go build/.test(raw)) return 'Go';
  if (/rust|cargo/.test(raw)) return 'Rust';
  if (/php|composer|laravel/.test(raw)) return 'PHP';
  if (/nginx|caddy|static/.test(raw)) return 'Static';
  return 'App';
}

export function inferInfraRuntime(service: BranchResourceInfraInput): { runtime: string; kind: ResourceKind; envKeys: string[] } {
  const raw = text([service.id, service.name, service.dockerImage]);
  if (/mysql|mariadb/.test(raw)) return { runtime: 'MySQL', kind: 'database', envKeys: ['MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_DATABASE', 'DATABASE_URL'] };
  if (/postgres|postgresql|postgis|pgvector/.test(raw)) return { runtime: 'PostgreSQL', kind: 'database', envKeys: ['POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_DB', 'DATABASE_URL'] };
  if (/mssql|sqlserver|sql-server|microsoft.*sql/.test(raw)) return { runtime: 'SQL Server', kind: 'database', envKeys: ['MSSQL_HOST', 'MSSQL_PORT', 'MSSQL_DATABASE', 'DATABASE_URL'] };
  if (/mongo/.test(raw)) return { runtime: 'MongoDB', kind: 'database', envKeys: ['MONGODB_HOST', 'MONGODB_PORT', 'MONGODB_URL'] };
  if (/redis/.test(raw)) return { runtime: 'Redis', kind: 'cache', envKeys: ['REDIS_HOST', 'REDIS_PORT', 'REDIS_URL'] };
  if (/rabbit/.test(raw)) return { runtime: 'RabbitMQ', kind: 'queue', envKeys: ['RABBITMQ_HOST', 'RABBITMQ_PORT', 'RABBITMQ_URL'] };
  if (/minio|s3/.test(raw)) return { runtime: 'MinIO', kind: 'storage', envKeys: ['S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'] };
  return { runtime: service.name || service.id || 'Service', kind: 'service', envKeys: [] };
}

function externalTcpUrl(service: BranchResourceInfraInput): string {
  const port = service.hostPort || service.containerPort;
  if (!port || typeof window === 'undefined') return '';
  const host = window.location.hostname || '127.0.0.1';
  return `tcp://${host}:${port}`;
}

function infraConnectionString(runtime: string, service: BranchResourceInfraInput): string {
  const env = service.env || {};
  const db = service.dbName || env.MYSQL_DATABASE || env.POSTGRES_DB || env.MONGO_INITDB_DATABASE || 'app';
  const port = service.hostPort || service.containerPort || 0;
  const host = typeof window === 'undefined' ? '127.0.0.1' : window.location.hostname || '127.0.0.1';
  if (runtime === 'MySQL') return `mysql://${env.MYSQL_USER || 'user'}:******@${host}:${port}/${db}`;
  if (runtime === 'PostgreSQL') return `postgres://${env.POSTGRES_USER || 'user'}:******@${host}:${port}/${db}`;
  if (runtime === 'SQL Server') return `sqlserver://${env.MSSQL_USER || env.SA_USER || 'sa'}:******@${host}:${port}/${env.MSSQL_DATABASE || db}`;
  if (runtime === 'MongoDB') return `mongodb://${env.MONGO_INITDB_ROOT_USERNAME || 'user'}:******@${host}:${port}/${db}`;
  if (runtime === 'Redis') return `redis://:******@${host}:${port}`;
  if (runtime === 'RabbitMQ') return `amqp://${env.RABBITMQ_DEFAULT_USER || 'user'}:******@${host}:${port}`;
  return port ? `${host}:${port}` : '';
}

export function buildBranchResources(input: BuildBranchResourcesInput): BranchResource[] {
  const profilesById = new Map((input.profiles || []).map((profile) => [profile.id, profile]));
  const consumerNamesByInfraId = new Map<string, string[]>();
  for (const service of Object.values(input.services || {})) {
    const profile = profilesById.get(service.profileId);
    const appName = profile?.name || service.profileId;
    for (const dep of profile?.dependsOn || []) {
      const key = dep.replace(/^infra:/, '');
      const consumers = consumerNamesByInfraId.get(key) || [];
      consumers.push(appName);
      consumerNamesByInfraId.set(key, consumers);
    }
  }
  const appResources = Object.values(input.services || {}).map((service) => {
    const profile = profilesById.get(service.profileId);
    const runtime = inferAppRuntime(profile, service);
    const displayName = `${runtime} :${service.hostPort || profile?.containerPort || '?'}`;
    return {
      id: `app:${service.profileId}`,
      source: 'app' as const,
      kind: 'app' as const,
      runtime,
      displayName,
      serviceName: profile?.name || service.profileId,
      port: service.hostPort,
      containerPort: profile?.containerPort,
      status: normalizeStatus(service.status),
      access: input.previewUrl ? 'external' as const : 'internal' as const,
      externalUrl: input.previewUrl,
      internalUrl: service.hostPort ? `http://127.0.0.1:${service.hostPort}` : '',
      connectionString: '',
      envKeys: [],
      dependsOn: profile?.dependsOn || [],
      consumers: [],
      cloneTasks: [],
      containerName: service.containerName,
      errorMessage: service.errorMessage,
      raw: service,
    };
  });
  const infraResources = (input.infraServices || []).map((service) => {
    const inferred = inferInfraRuntime(service);
    const port = service.hostPort || service.containerPort;
    return {
      id: `infra:${service.id}`,
      source: 'infra' as const,
      kind: inferred.kind,
      runtime: inferred.runtime,
      displayName: port ? `${inferred.runtime} :${port}` : inferred.runtime,
      serviceName: service.name || service.id,
      port,
      containerPort: service.containerPort,
      status: normalizeStatus(service.status),
      access: 'internal' as const,
      externalUrl: externalTcpUrl(service),
      internalUrl: service.containerPort ? `${service.id}:${service.containerPort}` : '',
      connectionString: infraConnectionString(inferred.runtime, service),
      envKeys: inferred.envKeys,
      dependsOn: [],
      consumers: consumerNamesByInfraId.get(service.id) || [],
      cloneTasks: [],
      containerName: service.containerName,
      errorMessage: service.errorMessage,
      raw: service,
    };
  });
  return [...appResources, ...infraResources].sort((left, right) => {
    const rank: Record<ResourceKind, number> = { app: 0, database: 1, cache: 2, queue: 3, storage: 4, service: 5 };
    return rank[left.kind] - rank[right.kind] || left.displayName.localeCompare(right.displayName);
  });
}

export function resourceKindLabel(kind: ResourceKind): string {
  return ({
    app: '应用',
    database: '数据库',
    cache: '缓存',
    queue: '队列',
    storage: '存储',
    service: '服务',
  } as Record<ResourceKind, string>)[kind];
}

export function resourceStatusLabel(status: ResourceStatus): string {
  return ({
    idle: '未运行',
    building: '构建中',
    starting: '启动中',
    running: '运行中',
    restarting: '重启中',
    stopping: '停止中',
    stopped: '已停止',
    error: '异常',
  } as Record<ResourceStatus, string>)[status] || status;
}

export function ResourceIcon({ resource, className = 'h-4 w-4' }: { resource: Pick<BranchResource, 'runtime' | 'kind'>; className?: string }): JSX.Element {
  const src = iconByRuntime[resource.runtime];
  if (src) return <img src={src} alt="" aria-hidden className={`${className} object-contain`} />;
  const iconClass = `${className} ${RUNTIME_TONE[resource.runtime] || 'text-muted-foreground'}`;
  if (resource.kind === 'database') return <Database className={iconClass} />;
  if (resource.kind === 'cache') return <HardDrive className={iconClass} />;
  if (resource.kind === 'queue') return <Network className={iconClass} />;
  if (resource.kind === 'storage') return <HardDrive className={iconClass} />;
  if (resource.runtime === 'Static') return <Braces className={iconClass} />;
  return <Code2 className={iconClass} />;
}

export function resourceAccessIcon(resource: BranchResource, className = 'h-3 w-3'): ReactNode {
  if (resource.access === 'external') return <ExternalLink className={className} aria-hidden />;
  if ((resource.externalUrl || resource.externalAccess?.address) && resource.source === 'infra') return <Cable className={className} aria-hidden />;
  return <KeyRound className={className} aria-hidden />;
}
