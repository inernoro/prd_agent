import type { BranchEntry, BuildProfile, InfraService, ResourceCloneTask, ResourceExternalAccessPolicy, ServiceState } from '../types.js';

export type UnifiedResourceKind = 'app' | 'database' | 'cache' | 'queue' | 'storage' | 'service';
export type UnifiedResourceStatus = ServiceState['status'] | 'stopped';
export type UnifiedResourceAccess = 'internal' | 'external';

export interface UnifiedResourceExternalAccess {
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
}

export interface UnifiedResourceCapabilitySet {
  control: boolean;
  connection: boolean;
  data: boolean;
  backups: boolean;
  clone: boolean;
  externalAccess: boolean;
  variables: boolean;
  metrics: boolean;
  logs: boolean;
  dangerousActions: boolean;
}

export interface UnifiedBranchResource {
  id: string;
  source: 'app' | 'infra';
  kind: UnifiedResourceKind;
  runtime: string;
  displayName: string;
  serviceName: string;
  branchId: string;
  branchName: string;
  projectId: string;
  port?: number;
  containerPort?: number;
  status: UnifiedResourceStatus;
  access: UnifiedResourceAccess;
  externalUrl?: string;
  internalUrl?: string;
  connectionString?: string;
  externalAccess: UnifiedResourceExternalAccess;
  envKeys: string[];
  dependsOn: string[];
  consumers: string[];
  isolation: 'branch' | 'project-shared';
  capabilities: UnifiedResourceCapabilitySet;
  cloneTasks?: ResourceCloneTask[];
  containerName?: string;
  errorMessage?: string;
  raw: ServiceState | InfraService;
}

export interface BuildUnifiedResourcesInput {
  branch: BranchEntry;
  profiles: BuildProfile[];
  infraServices: InfraService[];
  externalAccessPolicies?: ResourceExternalAccessPolicy[];
  cloneTasks?: ResourceCloneTask[];
  branchEnv?: Record<string, string>;
  previewUrl?: string;
  publicHost?: string;
}

function text(parts: Array<string | number | undefined | null>): string {
  return parts.filter((part) => part !== undefined && part !== null && String(part).trim()).join(' ').toLowerCase();
}

function normalizeStatus(status?: string): UnifiedResourceStatus {
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

export function inferAppRuntime(profile?: BuildProfile, service?: ServiceState): string {
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

export function inferInfraRuntime(service: InfraService): { runtime: string; kind: UnifiedResourceKind; envKeys: string[] } {
  const raw = text([service.id, service.name, service.dockerImage, service.basePresetId]);
  if (/mysql|mariadb/.test(raw)) return { runtime: 'MySQL', kind: 'database', envKeys: ['MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_DATABASE', 'DATABASE_URL'] };
  if (/postgres|postgresql|postgis|pgvector/.test(raw)) return { runtime: 'PostgreSQL', kind: 'database', envKeys: ['POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_DB', 'DATABASE_URL'] };
  if (/mongo/.test(raw)) return { runtime: 'MongoDB', kind: 'database', envKeys: ['MONGODB_HOST', 'MONGODB_PORT', 'MONGODB_URL'] };
  if (/redis/.test(raw)) return { runtime: 'Redis', kind: 'cache', envKeys: ['REDIS_HOST', 'REDIS_PORT', 'REDIS_URL'] };
  if (/rabbit/.test(raw)) return { runtime: 'RabbitMQ', kind: 'queue', envKeys: ['RABBITMQ_HOST', 'RABBITMQ_PORT', 'RABBITMQ_URL'] };
  if (/minio|s3/.test(raw)) return { runtime: 'MinIO', kind: 'storage', envKeys: ['S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'] };
  return { runtime: service.name || service.id || 'Service', kind: 'service', envKeys: [] };
}

function publicTcpAddress(publicHost: string | undefined, port: number | undefined): string {
  if (!publicHost || !port) return '';
  const host = publicHost.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return host ? `tcp://${host}:${port}` : '';
}

function internalInfraAddress(service: InfraService): string {
  return service.containerPort ? `${service.id}:${service.containerPort}` : service.id;
}

function infraConnectionString(runtime: string, service: InfraService, host: string, branchEnv: Record<string, string> = {}): string {
  const env = service.env || {};
  const port = service.hostPort || service.containerPort || 0;
  if (runtime === 'MySQL') {
    const db = branchEnv.MYSQL_DATABASE || service.dbName || env.MYSQL_DATABASE || env.MARIADB_DATABASE || 'app';
    const user = branchEnv.MYSQL_USER || env.MYSQL_USER || env.MARIADB_USER || 'user';
    return `mysql://${user}:******@${host}:${port}/${db}`;
  }
  if (runtime === 'PostgreSQL') {
    const db = branchEnv.POSTGRES_DB || service.dbName || env.POSTGRES_DB || 'postgres';
    const user = branchEnv.POSTGRES_USER || env.POSTGRES_USER || 'postgres';
    return `postgres://${user}:******@${host}:${port}/${db}`;
  }
  if (runtime === 'MongoDB') {
    const db = branchEnv.MONGODB_DATABASE || branchEnv.MONGO_INITDB_DATABASE || service.dbName || env.MONGO_INITDB_DATABASE || 'app';
    const branchUser = branchEnv.MONGODB_USERNAME || branchEnv.MONGO_USERNAME || '';
    const user = branchEnv.MONGO_INITDB_ROOT_USERNAME
      || branchUser
      || env.MONGO_INITDB_ROOT_USERNAME
      || env.MONGO_USERNAME
      || env.MONGODB_USERNAME
      || 'user';
    const authSource = branchEnv.MONGODB_AUTH_SOURCE || branchEnv.MONGO_AUTH_SOURCE || (branchUser ? db : 'admin');
    return `mongodb://${user}:******@${host}:${port}/${db}?authSource=${authSource}`;
  }
  if (runtime === 'Redis') return `redis://:******@${host}:${port}`;
  if (runtime === 'RabbitMQ') return `amqp://${env.RABBITMQ_DEFAULT_USER || 'user'}:******@${host}:${port}`;
  return port ? `${host}:${port}` : '';
}

function appCapabilities(): UnifiedResourceCapabilitySet {
  return {
    control: false,
    connection: true,
    data: false,
    backups: false,
    clone: false,
    externalAccess: true,
    variables: true,
    metrics: true,
    logs: true,
    dangerousActions: false,
  };
}

function infraCapabilities(kind: UnifiedResourceKind): UnifiedResourceCapabilitySet {
  const stateful = kind === 'database' || kind === 'cache' || kind === 'queue' || kind === 'storage';
  return {
    control: true,
    connection: true,
    data: kind === 'database' || kind === 'cache',
    backups: stateful,
    clone: kind === 'database',
    externalAccess: true,
    variables: true,
    metrics: true,
    logs: true,
    dangerousActions: stateful,
  };
}

export function buildUnifiedBranchResources(input: BuildUnifiedResourcesInput): UnifiedBranchResource[] {
  const profilesById = new Map(input.profiles.map((profile) => [profile.id, profile]));
  const policyByResourceId = new Map((input.externalAccessPolicies || []).map((policy) => [policy.resourceId, policy]));
  const cloneTasksByResourceId = new Map<string, ResourceCloneTask[]>();
  for (const task of input.cloneTasks || []) {
    const list = cloneTasksByResourceId.get(task.resourceId) || [];
    list.push(task);
    cloneTasksByResourceId.set(task.resourceId, list);
  }
  const publicHost = input.publicHost?.replace(/^https?:\/\//, '').replace(/\/+$/, '') || '';
  const consumerNamesByInfraId = new Map<string, string[]>();
  for (const service of Object.values(input.branch.services || {})) {
    const profile = profilesById.get(service.profileId);
    const appName = profile?.name || service.profileId;
    for (const dep of profile?.dependsOn || []) {
      const key = dep.replace(/^infra:/, '');
      const consumers = consumerNamesByInfraId.get(key) || [];
      consumers.push(appName);
      consumerNamesByInfraId.set(key, consumers);
    }
  }

  const appResources = Object.values(input.branch.services || {}).map((service) => {
    const profile = profilesById.get(service.profileId);
    const runtime = inferAppRuntime(profile, service);
    const port = service.hostPort || profile?.containerPort;
    const resourceId = `app:${service.profileId}`;
    const policy = policyByResourceId.get(resourceId);
    const externalUrl = policy?.enabled && policy.address ? policy.address : input.previewUrl || '';
    return {
      id: resourceId,
      source: 'app' as const,
      kind: 'app' as const,
      runtime,
      displayName: `${runtime} :${port || '?'}`,
      serviceName: profile?.name || service.profileId,
      branchId: input.branch.id,
      branchName: input.branch.branch,
      projectId: input.branch.projectId || 'default',
      port: service.hostPort,
      containerPort: profile?.containerPort,
      status: normalizeStatus(service.status),
      access: externalUrl ? 'external' as const : 'internal' as const,
      externalUrl,
      internalUrl: service.hostPort ? `http://127.0.0.1:${service.hostPort}` : '',
      connectionString: '',
      externalAccess: {
        enabled: policy?.enabled ?? Boolean(externalUrl),
        kind: 'https' as const,
        address: policy?.address || externalUrl,
        host: policy?.host,
        port: policy?.port,
        allowlist: policy?.allowlist || [],
        expiresAt: policy?.expiresAt ?? null,
      },
      envKeys: [],
      dependsOn: profile?.dependsOn || [],
      consumers: [],
      isolation: 'branch' as const,
      capabilities: appCapabilities(),
      cloneTasks: cloneTasksByResourceId.get(resourceId) || [],
      containerName: service.containerName,
      errorMessage: service.errorMessage,
      raw: service,
    };
  });

  const infraResources = input.infraServices.map((service) => {
    const inferred = inferInfraRuntime(service);
    const port = service.hostPort || service.containerPort;
    const resourceId = `infra:${service.id}`;
    const policy = policyByResourceId.get(resourceId);
    const tcpAddress = publicTcpAddress(publicHost, service.hostPort);
    return {
      id: resourceId,
      source: 'infra' as const,
      kind: inferred.kind,
      runtime: inferred.runtime,
      displayName: port ? `${inferred.runtime} :${port}` : inferred.runtime,
      serviceName: service.name || service.id,
      branchId: input.branch.id,
      branchName: input.branch.branch,
      projectId: input.branch.projectId || 'default',
      port,
      containerPort: service.containerPort,
      status: normalizeStatus(service.status),
      access: policy?.enabled ? 'external' as const : 'internal' as const,
      externalUrl: policy?.enabled ? policy.address || '' : '',
      internalUrl: internalInfraAddress(service),
      connectionString: policy?.enabled && policy.connectionString
        ? policy.connectionString
        : infraConnectionString(inferred.runtime, service, service.id || '127.0.0.1', input.branchEnv),
      externalAccess: {
        enabled: policy?.enabled || false,
        kind: 'tcp' as const,
        address: policy?.address || tcpAddress || undefined,
        host: policy?.host || publicHost || undefined,
        port: policy?.port || service.hostPort,
        connectionString: policy?.connectionString,
        proxyContainerName: policy?.proxyContainerName,
        targetHost: policy?.targetHost,
        targetPort: policy?.targetPort,
        allowlistEnforced: policy?.allowlistEnforced,
        firewallChain: policy?.firewallChain,
        allowlist: policy?.allowlist || [],
        expiresAt: policy?.expiresAt ?? null,
      },
      envKeys: inferred.envKeys,
      dependsOn: [],
      consumers: consumerNamesByInfraId.get(service.id) || [],
      isolation: 'project-shared' as const,
      capabilities: infraCapabilities(inferred.kind),
      cloneTasks: cloneTasksByResourceId.get(resourceId) || [],
      containerName: service.containerName,
      errorMessage: service.errorMessage,
      raw: service,
    };
  });

  const rank: Record<UnifiedResourceKind, number> = { app: 0, database: 1, cache: 2, queue: 3, storage: 4, service: 5 };
  return [...appResources, ...infraResources].sort((left, right) => (
    rank[left.kind] - rank[right.kind] || left.displayName.localeCompare(right.displayName)
  ));
}
