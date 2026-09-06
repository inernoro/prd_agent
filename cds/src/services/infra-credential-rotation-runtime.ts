import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { MongoClient } from 'mongodb';
import type { CdsConfig, InfraCredentialRotationRecord, InfraService } from '../types.js';
import { isSealedSecret, isSealingEnabled, sealToken, unsealToken } from '../infra/secret-seal.js';
import type { StateService } from './state.js';
import { resolveCommandTemplate, resolveEnvTemplates } from './compose-parser.js';
import { cdsEnvPrefix } from './infra-credential-env.js';
import { readStartupFlagValue } from './infra-exposure-audit.js';
import {
  credentialFingerprint,
  generateRotationSecret,
  type InfraCredentialRotationBackend,
  type InfraCredentialRotationStore,
  type RotationDeploymentProgress,
  type RotationPreparedCredential,
  type RotationQuiescenceEvidence,
  type RotationRecoveryEvidence,
} from './infra-credential-rotation.js';
import {
  markRotationRecoveryArtifactsForCleanup,
  markRotationRecoveryArtifactsForManualReview,
  runLocalInfraRecoveryDrill,
} from './infra-local-recovery-drill.js';

interface RuntimeCredentialContext {
  runtime: 'mongodb' | 'redis';
  previousUser: string;
  previousSecret: string;
  nextUser: string;
  nextSecret: string;
  originalServiceEnv: Record<string, string>;
  originalProjectEnv: Record<string, string>;
  resolvedServiceEnv: Record<string, string>;
  aclFile?: string;
  redisPersistence?: 'aclfile' | 'recreate';
  oldMongoRoles?: unknown[];
}

function contextOf(prepared: RotationPreparedCredential): RuntimeCredentialContext {
  return prepared.opaque as RuntimeCredentialContext;
}

function runtimeOf(service: InfraService): 'mongodb' | 'redis' {
  return `${service.id} ${service.basePresetId || ''} ${service.dockerImage}`.toLowerCase().includes('mongo')
    ? 'mongodb'
    : 'redis';
}

function mongoCredential(env: Record<string, string>): { user: string; secret: string } {
  const user = String(env.MONGO_INITDB_ROOT_USERNAME || env.MONGO_USERNAME || env.MONGODB_USERNAME || '').trim();
  const secret = String(env.MONGO_INITDB_ROOT_PASSWORD || env.MONGO_PASSWORD || env.MONGODB_PASSWORD || '');
  if (!user || !secret) throw new Error('rotation.mongodb_credentials_missing');
  return { user, secret };
}

function redisCredential(env: Record<string, string>): { user: string; secret: string } {
  const user = String(env.REDIS_USERNAME || 'default').trim() || 'default';
  const secret = String(env.REDIS_PASSWORD || env.REDIS_PASS || '');
  if (!secret) throw new Error('rotation.redis_credentials_missing');
  return { user, secret };
}

function startupTokens(value: string | string[] | undefined): string[] {
  return Array.isArray(value) ? value.map(String) : value ? [value] : [];
}

function resolvedServiceConfig(state: StateService, service: InfraService): {
  env: Record<string, string>;
  command?: string | string[];
  entrypoint?: string | string[];
} {
  const projectEnv = state.getCustomEnv(service.projectId);
  return {
    env: resolveEnvTemplates(service.env || {}, projectEnv),
    command: resolveCommandTemplate(service.command, projectEnv),
    entrypoint: resolveCommandTemplate(service.entrypoint, projectEnv),
  };
}

function rewriteUrlCredential(value: string, user: string, secret: string): string {
  if (!value) return value;
  try {
    const url = new URL(value);
    url.username = user;
    url.password = secret;
    return url.toString();
  } catch {
    return value;
  }
}

export function rotatedCredentialEnv(runtime: 'mongodb' | 'redis', env: Record<string, string>, user: string, secret: string): Record<string, string> {
  const next = { ...env };
  if (runtime === 'mongodb') {
    for (const key of ['MONGO_INITDB_ROOT_USERNAME', 'MONGO_USERNAME', 'MONGODB_USERNAME']) {
      if (key in next || key === 'MONGO_INITDB_ROOT_USERNAME') next[key] = user;
    }
    for (const key of ['MONGO_INITDB_ROOT_PASSWORD', 'MONGO_PASSWORD', 'MONGODB_PASSWORD']) {
      if (key in next || key === 'MONGO_INITDB_ROOT_PASSWORD') next[key] = secret;
    }
    for (const key of ['MONGODB_URL', 'MONGO_URL', 'DATABASE_URL']) {
      if (key in next && /^mongodb(?:\+srv)?:/i.test(next[key])) next[key] = rewriteUrlCredential(next[key], user, secret);
    }
  } else {
    if ('REDIS_USERNAME' in next) next.REDIS_USERNAME = user;
    next.REDIS_PASSWORD = secret;
    if ('REDIS_PASS' in next) next.REDIS_PASS = secret;
    for (const key of ['REDIS_URL', 'CACHE_URL']) {
      if (key in next && /^rediss?:/i.test(next[key])) next[key] = rewriteUrlCredential(next[key], user === 'default' ? '' : user, secret);
    }
  }
  return next;
}

export function rotatedProjectCredentialEnv(
  service: InfraService,
  runtime: 'mongodb' | 'redis',
  env: Record<string, string>,
  user: string,
  secret: string,
): Record<string, string> {
  // project customEnv 是跨所有同类型实例的全局命名空间，不能套用容器 env 的
  // MONGODB_PASSWORD/REDIS_PASSWORD 泛化改写，否则旋转 mongodb-2 会覆盖主实例。
  const next = { ...env };
  const prefix = cdsEnvPrefix(service.id);
  const scheme = runtime === 'mongodb' ? 'mongodb' : 'redis';
  const uriUser = runtime === 'redis' && user === 'default' ? '' : encodeURIComponent(user);
  const auth = `${uriUser}:${encodeURIComponent(secret)}@`;
  const startup = JSON.stringify({ env: service.env || {}, command: service.command, entrypoint: service.entrypoint });
  const primaryId = runtime === 'mongodb' ? 'mongodb' : 'redis';
  const aliases = runtime === 'mongodb' ? ['CDS_MONGO_', 'CDS_MONGODB_'] : ['CDS_REDIS_'];
  const aliasUrl = runtime === 'mongodb' ? env.CDS_MONGODB_URL : env.CDS_REDIS_URL;
  let aliasHostMatches = false;
  try { aliasHostMatches = Boolean(aliasUrl) && new URL(aliasUrl).hostname === service.id; } catch { aliasHostMatches = false; }
  const ownsPrimaryAliases = service.id === primaryId
    && (aliases.some((alias) => startup.includes(alias)) || aliasHostMatches);
  if (service.id !== primaryId || ownsPrimaryAliases) {
    next[`CDS_${prefix}_USER`] = user;
    next[`CDS_${prefix}_PASSWORD`] = secret;
    const specificUrlKey = `CDS_${prefix}_URL`;
    next[specificUrlKey] = env[specificUrlKey]
      ? rewriteUrlCredential(env[specificUrlKey], user === 'default' ? '' : user, secret)
      : `${scheme}://${auth}${service.id}:${service.containerPort}`;
  }
  // compose 的 Mongo 容器模板历史上用 CDS_MONGO_*，消费方则用 CDS_MONGODB_*。
  // 两组必须同时推进，否则 customEnv 会以更高优先级把旧值重新盖回去。
  if (runtime === 'mongodb' && ownsPrimaryAliases) {
    next.CDS_MONGO_USER = user;
    next.CDS_MONGO_PASSWORD = secret;
    next.CDS_MONGODB_USER = user;
    next.CDS_MONGODB_PASSWORD = secret;
    next.CDS_MONGODB_URL = env.CDS_MONGODB_URL
      ? rewriteUrlCredential(env.CDS_MONGODB_URL, user, secret)
      : `mongodb://${auth}${service.id}:${service.containerPort}/admin?authSource=admin`;
  } else if (runtime === 'redis' && ownsPrimaryAliases) {
    next.CDS_REDIS_USER = user;
    next.CDS_REDIS_PASSWORD = secret;
    next.CDS_REDIS_URL = env.CDS_REDIS_URL
      ? rewriteUrlCredential(env.CDS_REDIS_URL, user === 'default' ? '' : user, secret)
      : `redis://${auth}${service.id}:${service.containerPort}/0`;
  }
  return next;
}

function mongoUri(service: InfraService, user: string, secret: string): string {
  return `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(secret)}@127.0.0.1:${service.hostPort}/admin?authSource=admin&directConnection=true`;
}

async function withMongo<T>(service: InfraService, user: string, secret: string, fn: (client: MongoClient) => Promise<T>): Promise<T> {
  const client = new MongoClient(mongoUri(service, user, secret), { serverSelectionTimeoutMS: 10_000 });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function encodeResp(command: readonly string[]): Buffer {
  const chunks = [Buffer.from(`*${command.length}\r\n`)];
  for (const value of command) {
    const data = Buffer.from(value, 'utf8');
    chunks.push(Buffer.from(`$${data.length}\r\n`), data, Buffer.from('\r\n'));
  }
  return Buffer.concat(chunks);
}

interface RespParseResult { value: unknown; bytes: number }

function parseResp(buffer: Buffer, offset = 0): RespParseResult | null {
  const end = buffer.indexOf('\r\n', offset);
  if (end < 0) return null;
  const prefix = String.fromCharCode(buffer[offset]);
  const line = buffer.subarray(offset + 1, end).toString('utf8');
  if (prefix === '+' || prefix === ':') return { value: prefix === ':' ? Number(line) : line, bytes: end + 2 - offset };
  if (prefix === '-') throw new Error('rotation.redis_command_rejected');
  if (prefix === '$') {
    const size = Number(line);
    if (size === -1) return { value: null, bytes: end + 2 - offset };
    const start = end + 2;
    if (!Number.isSafeInteger(size) || buffer.length < start + size + 2) return null;
    return { value: buffer.subarray(start, start + size).toString('utf8'), bytes: start + size + 2 - offset };
  }
  if (prefix === '*') {
    const count = Number(line);
    if (count === -1) return { value: null, bytes: end + 2 - offset };
    let cursor = end + 2;
    const values: unknown[] = [];
    for (let i = 0; i < count; i += 1) {
      const parsed = parseResp(buffer, cursor);
      if (!parsed) return null;
      values.push(parsed.value);
      cursor += parsed.bytes;
    }
    return { value: values, bytes: cursor - offset };
  }
  throw new Error('rotation.redis_response_invalid');
}

async function redisCommands(port: number, commands: readonly (readonly string[])[]): Promise<unknown[]> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const responses: unknown[] = [];
    let pending = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(new Error('rotation.redis_timeout')), 10_000);
    socket.on('connect', () => {
      for (const command of commands) socket.write(encodeResp(command));
    });
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (responses.length < commands.length) {
        try {
          const parsed = parseResp(pending);
          if (!parsed) break;
          responses.push(parsed.value);
          pending = pending.subarray(parsed.bytes);
        } catch {
          clearTimeout(timer);
          socket.destroy();
          reject(new Error('rotation.redis_command_rejected'));
          return;
        }
      }
      if (responses.length === commands.length) {
        clearTimeout(timer);
        socket.end();
        resolve(responses);
      }
    });
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

async function restartContainer(containerName: string): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(containerName)) throw new Error('rotation.container_name_invalid');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('docker', ['restart', containerName], { stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error('rotation.authority_restart_failed')));
  });
}

export interface RotationRuntimeOps {
  redisCommands(port: number, commands: readonly (readonly string[])[]): Promise<unknown[]>;
  restartContainer(containerName: string): Promise<void>;
}

export interface InfraCredentialAuthorityRestarter {
  recreate(service: InfraService): Promise<void>;
}

const DEFAULT_RUNTIME_OPS: RotationRuntimeOps = { redisCommands, restartContainer };

async function inspectContainerEnv(containerName: string): Promise<Record<string, string>> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(containerName)) throw new Error('rotation.consumer_container_invalid');
  return await new Promise((resolve, reject) => {
    const child = spawn('docker', ['inspect', '--format', '{{json .Config.Env}}', containerName], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) { reject(new Error('rotation.consumer_inspect_failed')); return; }
      try {
        const rows = JSON.parse(stdout) as string[];
        resolve(Object.fromEntries(rows.map((row) => {
          const at = row.indexOf('=');
          return at < 0 ? [row, ''] : [row.slice(0, at), row.slice(at + 1)];
        })));
      } catch {
        reject(new Error('rotation.consumer_inspect_invalid'));
      }
    });
  });
}

export interface RotationConsumerCoordinator {
  enumerate(service: InfraService): Promise<string[]>;
  deploy(
    service: InfraService,
    consumerIds: readonly string[],
    onProgress?: RotationDeploymentProgress,
  ): Promise<{ revision: string }>;
  verify(service: InfraService, consumerIds: readonly string[], expected: RuntimeCredentialContext): Promise<void>;
}

interface ConsumerProbeDeps {
  inspectContainerEnv(containerName: string): Promise<Record<string, string>>;
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

const DEFAULT_CONSUMER_PROBE_DEPS: ConsumerProbeDeps = {
  inspectContainerEnv,
  fetch: (input, init) => fetch(input, init),
};

/** 使用 CDS 自己的部署端点重建真实消费者，并以容器运行环境反查新凭据确已加载。 */
export class CdsRotationConsumerCoordinator implements RotationConsumerCoordinator {
  constructor(
    private readonly state: StateService,
    private readonly config: CdsConfig,
    private readonly probeDeps: ConsumerProbeDeps = DEFAULT_CONSUMER_PROBE_DEPS,
  ) {}

  async enumerate(service: InfraService): Promise<string[]> {
    const consumers: string[] = [];
    const runtime = runtimeOf(service);
    const resolved = resolvedServiceConfig(this.state, service);
    const currentSecret = runtime === 'mongodb'
      ? mongoCredential(resolved.env).secret
      : redisCredential({
        ...resolved.env,
        REDIS_PASSWORD: resolved.env.REDIS_PASSWORD
          || readStartupFlagValue(resolved.env, [
            ...startupTokens(resolved.command),
            ...startupTokens(resolved.entrypoint),
          ], '--requirepass'),
      }).secret;
    for (const branch of Object.values(this.state.getState().branches || {})) {
      if ((branch.projectId || 'default') !== service.projectId) continue;
      if (branch.status !== 'running') continue;
      for (const profile of this.state.getEffectiveProfilesForBranch(branch)) {
        const item = branch.services?.[profile.id];
        if (item?.status !== 'running') continue;
        const prefixes = [cdsEnvPrefix(service.id)];
        if (service.id === 'mongodb') prefixes.push('MONGO', 'MONGODB');
        if (service.id === 'redis') prefixes.push('REDIS');
        const referencesCredential = prefixes.some((prefix) => new RegExp(
          `\\$\\{CDS_${prefix}_(?:URL|USER|PASSWORD)\\}`,
        ).test(JSON.stringify(profile.env || {})));
        const liveEnv = await this.probeDeps.inspectContainerEnv(item.containerName);
        // project customEnv 与 CDS 派生键会被全量注入每个 profile，不能把容器里
        // 任意 CDS_MONGODB_URL/CDS_REDIS_* 的存在当成“该 profile 正在消费”。
        // legacy 运行态兜底只核对 profile 自己声明的应用连接键。
        const declaredApplicationKeys = Object.keys(profile.env || {}).filter((key) => {
          if (/^CDS_/i.test(key) || /(?:INITDB_ROOT|PASSWORD|USERNAME|\bUSER)$/i.test(key)) return false;
          return runtime === 'mongodb'
            ? /(MONGO|DATABASE_URL|CONNECTIONSTRING)/i.test(key)
            : /(REDIS|CACHE_URL|CONNECTIONSTRING)/i.test(key);
        });
        const liveCredentialMatch = declaredApplicationKeys.some((key) => {
          const value = liveEnv[key] || '';
          return value.includes(currentSecret) || value.includes(encodeURIComponent(currentSecret));
        });
        if (!(profile.dependsOn || []).includes(service.id) && !referencesCredential && !liveCredentialMatch) continue;
        consumers.push(`${branch.id}/${profile.id}`);
      }
    }
    return consumers;
  }

  async deploy(
    service: InfraService,
    consumerIds: readonly string[],
    onProgress?: RotationDeploymentProgress,
  ): Promise<{ revision: string }> {
    const branchIds = [...new Set(consumerIds.map((id) => id.split('/')[0]))];
    for (const branchId of branchIds) {
      const branch = this.state.getBranch(branchId);
      if (!branch || (branch.projectId || 'default') !== service.projectId) throw new Error('rotation.consumer_scope_changed');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20 * 60_000);
      try {
        const response = await fetch(
          `http://127.0.0.1:${this.config.masterPort}/api/branches/${encodeURIComponent(branchId)}/deploy?ignoreDeployLoopGuard=1`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-CDS-Internal': '1',
              'X-CDS-Trigger': 'credential-rotation',
              'X-CDS-Source-Project-Id': service.projectId,
              'X-CDS-Source-Branch-Id': branchId,
            },
            body: JSON.stringify({ commitSha: branch.githubCommitSha }),
            signal: controller.signal,
          },
        );
        const body = await response.text();
        if (!response.ok || !/(?:event:\s*complete|"ok"\s*:\s*true)/.test(body)) {
          throw new Error('rotation.consumer_deploy_failed');
        }
        await onProgress?.(consumerIds.filter((consumerId) => consumerId.split('/')[0] === branchId));
      } finally {
        clearTimeout(timer);
      }
    }
    const facts = branchIds.map((id) => {
      const branch = this.state.getBranch(id);
      return `${id}:${branch?.githubCommitSha || ''}:${branch?.lastReadyAt || ''}`;
    }).join('|');
    return { revision: crypto.createHash('sha256').update(facts).digest('hex').slice(0, 16) };
  }

  async verify(service: InfraService, consumerIds: readonly string[], expected: RuntimeCredentialContext): Promise<void> {
    for (const consumerId of consumerIds) {
      const [branchId, profileId] = consumerId.split('/');
      const branch = this.state.getBranch(branchId);
      if (!branch || branch.status !== 'running') throw new Error('rotation.consumer_not_running');
      const item = branch.services?.[profileId];
      if (!item || item.status !== 'running') {
        throw new Error('rotation.consumer_service_not_running');
      }
      const env = await this.probeDeps.inspectContainerEnv(item.containerName);
      const applicationKey = expected.runtime === 'mongodb'
        ? 'MongoDB__ConnectionString'
        : 'Redis__ConnectionString';
      const applicationConnection = env[applicationKey] || '';
      if (!applicationConnection.includes(expected.nextSecret)
        && !applicationConnection.includes(encodeURIComponent(expected.nextSecret))) {
        throw new Error('rotation.consumer_new_credential_not_loaded');
      }
      const profile = this.state.getEffectiveProfilesForBranch(branch).find((candidate) => candidate.id === profileId);
      const readinessPath = profile?.readinessProbe?.path;
      if (!readinessPath) throw new Error('rotation.consumer_readiness_contract_missing');
      await this.verifyReadiness(profileId, item.hostPort, env, readinessPath);
    }
  }

  private async verifyReadiness(
    profileId: string,
    hostPort: number,
    env: Record<string, string>,
    readinessPath: string,
  ): Promise<void> {
    const id = profileId.toLowerCase();
    const isServing = id === 'llmgw-serve' || id.startsWith('llmgw-serve-');
    const isConsole = !isServing && (id === 'llmgw' || id.startsWith('llmgw-'));
    const isApi = id === 'api' || id.startsWith('api-');
    if (!isServing && !isConsole && !isApi) throw new Error('rotation.consumer_readiness_contract_missing');
    const expectedPath = isServing ? '/gw/v1/readyz' : isConsole ? '/gw/readyz' : '/health/ready';
    if (readinessPath !== expectedPath) throw new Error('rotation.consumer_readiness_contract_mismatch');
    const headers: Record<string, string> = {};
    if (isServing) {
      const gatewayKey = env.LlmGwServe__ApiKey || env.LLMGW_SERVE_API_KEY || '';
      if (!gatewayKey) throw new Error('rotation.consumer_gateway_key_missing');
      headers['X-Gateway-Key'] = gatewayKey;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.probeDeps.fetch(`http://127.0.0.1:${hostPort}${readinessPath}`, { headers, signal: controller.signal });
      if (response.status === 401) throw new Error('rotation.business_readiness_auth_failed');
      if (response.status !== 200) throw new Error('rotation.consumer_readiness_failed');
      const body = await response.json() as {
        status?: unknown;
        components?: Array<{ name?: unknown; ready?: unknown }>;
      };
      const expectedStatus = isApi ? 'healthy' : 'ready';
      if (body.status !== expectedStatus || !Array.isArray(body.components)) {
        throw new Error('rotation.consumer_readiness_invalid');
      }
      const components = new Map(body.components
        .filter((component) => typeof component?.name === 'string')
        .map((component) => [String(component.name), component.ready === true]));
      const required = isApi ? ['mongodb', 'redis', 'asset-storage'] : isConsole ? ['mongodb'] : ['gateway-mongo'];
      const servingHasFailure = isServing && [...components.values()].some((ready) => !ready);
      if (required.some((key) => components.get(key) !== true) || servingHasFailure) {
        throw new Error('rotation.consumer_dependency_not_ready');
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

export class StateInfraCredentialRotationStore implements InfraCredentialRotationStore {
  constructor(private readonly state: StateService) {}
  getService(projectId: string, serviceId: string): InfraService | undefined {
    return this.state.getInfraServiceForProjectAndId(projectId, serviceId);
  }
  async saveRecord(projectId: string, serviceId: string, record: InfraCredentialRotationRecord): Promise<void> {
    this.state.updateInfraService(serviceId, { credentialRotation: record }, projectId);
    this.state.save();
    await this.state.flush();
  }
}

export class ProjectSharedCredentialRotationBackend implements InfraCredentialRotationBackend {
  constructor(
    private readonly state: StateService,
    private readonly consumers: RotationConsumerCoordinator,
    private readonly recoveryDrill: (service: InfraService) => Promise<RotationRecoveryEvidence> = (service) => runLocalInfraRecoveryDrill({
      service,
      recoveryDir: path.join(path.dirname(state.getCacheBase()), 'credential-rotation-recovery'),
    }),
    private readonly runtimeOps: RotationRuntimeOps = DEFAULT_RUNTIME_OPS,
    private readonly infraRestarter?: InfraCredentialAuthorityRestarter,
    private readonly quiescenceOptions: {
      timeoutMs?: number;
      pollMs?: number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {}

  enumerateConsumers(service: InfraService): Promise<string[]> { return this.consumers.enumerate(service); }

  private activeJobIds(service: InfraService): string[] {
    const runtime = runtimeOf(service);
    const maintenance = this.state.listActiveInfraMaintenanceJobs({
      projectId: service.projectId,
      serviceId: service.id,
      runtime,
    }).map((job) => `maintenance:${job.id}`);
    const clones = this.state.listResourceCloneTasks({
      projectId: service.projectId,
      resourceId: service.id,
    }).filter((task) => task.status === 'pending' || task.status === 'running')
      .map((task) => `resource:${task.id}`);
    // DataMigration 是历史全局模型，没有 project/service 归属；Mongo 轮换必须保守地
    // 阻断任意 running migration，不能靠猜连接串反推租户。
    const migrations = runtime === 'mongodb'
      ? this.state.getDataMigrations()
        .filter((migration) => migration.status === 'running')
        .map((migration) => `migration:${migration.id}`)
      : [];
    return [...new Set([...maintenance, ...clones, ...migrations])].sort();
  }

  async waitForQuiescence(service: InfraService): Promise<RotationQuiescenceEvidence> {
    const configuredTimeout = Number(process.env.CDS_ROTATION_DRAIN_TIMEOUT_MS || 30_000);
    const timeoutMs = Math.max(0, Math.min(5 * 60_000,
      this.quiescenceOptions.timeoutMs ?? (Number.isFinite(configuredTimeout) ? configuredTimeout : 30_000)));
    const pollMs = Math.max(25, Math.min(5_000, this.quiescenceOptions.pollMs ?? 500));
    const sleep = this.quiescenceOptions.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const deadline = Date.now() + timeoutMs;
    let activeJobIds = this.activeJobIds(service);
    while (activeJobIds.length > 0 && Date.now() < deadline) {
      await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
      activeJobIds = this.activeJobIds(service);
    }
    return { activeJobIds };
  }

  verifyRecovery(service: InfraService): Promise<RotationRecoveryEvidence> {
    const resolved = resolvedServiceConfig(this.state, service);
    return this.recoveryDrill({ ...service, env: resolved.env, command: resolved.command, entrypoint: resolved.entrypoint });
  }

  async prepare(
    service: InfraService,
    operation: { operationId: string; idempotencyKey: string },
  ): Promise<RotationPreparedCredential> {
    if (!isSealingEnabled()) throw new Error('rotation.sealing_key_required');
    const persisted = service.credentialRotationVault;
    if (persisted) {
      if (persisted.operationId !== operation.operationId || persisted.idempotencyKey !== operation.idempotencyKey) {
        throw new Error('rotation.vault_owned_by_another_operation');
      }
      if (!isSealedSecret(persisted.payload)) throw new Error('rotation.vault_not_sealed');
      const restored = JSON.parse(unsealToken(persisted.payload)) as RuntimeCredentialContext;
      return {
        previousFingerprint: credentialFingerprint(restored.previousUser, restored.previousSecret),
        nextFingerprint: credentialFingerprint(restored.nextUser, restored.nextSecret),
        opaque: restored,
      };
    }
    const runtime = runtimeOf(service);
    const resolved = resolvedServiceConfig(this.state, service);
    const startup = [...startupTokens(resolved.command), ...startupTokens(resolved.entrypoint)];
    const current = runtime === 'mongodb' ? mongoCredential(resolved.env) : redisCredential({
      ...resolved.env,
      REDIS_PASSWORD: resolved.env.REDIS_PASSWORD
        || readStartupFlagValue(resolved.env, startup, '--requirepass'),
    });
    const nextSecret = generateRotationSecret();
    const nextUser = runtime === 'mongodb'
      ? `cds_rotate_${crypto.randomBytes(8).toString('hex')}`
      : current.user;
    let oldMongoRoles: unknown[] | undefined;
    if (runtime === 'mongodb') {
      oldMongoRoles = await withMongo(service, current.user, current.secret, async (client) => {
        const result = await client.db('admin').command({ usersInfo: { user: current.user, db: 'admin' }, showPrivileges: false });
        return Array.isArray(result.users?.[0]?.roles) ? result.users[0].roles : [{ role: 'root', db: 'admin' }];
      });
    }
    const aclFile = runtime === 'redis' ? readStartupFlagValue(resolved.env, startup, '--aclfile') : '';
    const requirepass = runtime === 'redis' ? readStartupFlagValue(resolved.env, startup, '--requirepass') : '';
    if (runtime === 'redis' && !aclFile && (!requirepass || !this.infraRestarter)) {
      throw new Error('rotation.redis_persistence_unavailable');
    }
    const context: RuntimeCredentialContext = {
      runtime,
      previousUser: current.user,
      previousSecret: current.secret,
      nextUser,
      nextSecret,
      originalServiceEnv: { ...service.env },
      originalProjectEnv: this.state.getCustomEnvScope(service.projectId),
      resolvedServiceEnv: resolved.env,
      ...(aclFile ? { aclFile, redisPersistence: 'aclfile' as const } : {}),
      ...(runtime === 'redis' && !aclFile ? { redisPersistence: 'recreate' as const } : {}),
      ...(oldMongoRoles ? { oldMongoRoles } : {}),
    };
    const sealed = sealToken(JSON.stringify(context));
    if (!isSealedSecret(sealed)) throw new Error('rotation.vault_not_sealed');
    this.state.updateInfraService(service.id, {
      credentialRotationVault: {
        operationId: operation.operationId,
        idempotencyKey: operation.idempotencyKey,
        payload: sealed,
        sealedAt: new Date().toISOString(),
      },
    }, service.projectId);
    this.state.save();
    await this.state.flush();
    return {
      previousFingerprint: credentialFingerprint(current.user, current.secret),
      nextFingerprint: credentialFingerprint(nextUser, nextSecret),
      opaque: context,
    };
  }

  async issue(service: InfraService, prepared: RotationPreparedCredential): Promise<void> {
    const ctx = contextOf(prepared);
    if (ctx.runtime === 'mongodb') {
      await withMongo(service, ctx.previousUser, ctx.previousSecret, async (client) => {
        const admin = client.db('admin');
        const existing = await admin.command({ usersInfo: { user: ctx.nextUser, db: 'admin' } });
        if (Array.isArray(existing.users) && existing.users.length > 0) {
          await admin.command({ updateUser: ctx.nextUser, pwd: ctx.nextSecret, roles: ctx.oldMongoRoles });
        } else {
          await admin.command({ createUser: ctx.nextUser, pwd: ctx.nextSecret, roles: ctx.oldMongoRoles });
        }
      });
      return;
    }
    if (ctx.redisPersistence === 'aclfile') {
      const config = await this.runtimeOps.redisCommands(service.hostPort, [
        ['AUTH', ctx.previousUser, ctx.previousSecret],
        ['CONFIG', 'GET', 'aclfile'],
      ]);
      const configuredAclFile = Array.isArray(config[1]) ? String(config[1][1] || '') : '';
      if (!configuredAclFile || !ctx.aclFile) throw new Error('rotation.redis_aclfile_unavailable');
      if (path.posix.normalize(configuredAclFile) !== path.posix.normalize(ctx.aclFile)) {
        throw new Error('rotation.redis_aclfile_mismatch');
      }
    }
    const issueCommands: string[][] = [
      ['AUTH', ctx.previousUser, ctx.previousSecret],
      ['ACL', 'SETUSER', ctx.nextUser, 'on', `>${ctx.nextSecret}`],
    ];
    if (ctx.redisPersistence === 'aclfile') issueCommands.push(['ACL', 'SAVE']);
    issueCommands.push(['PING']);
    await this.runtimeOps.redisCommands(service.hostPort, issueCommands);
  }

  async deploy(
    service: InfraService,
    prepared: RotationPreparedCredential,
    consumerIds: readonly string[],
    onProgress?: RotationDeploymentProgress,
  ): Promise<{ revision: string }> {
    const ctx = contextOf(prepared);
    const nextServiceEnv = rotatedCredentialEnv(ctx.runtime, ctx.originalServiceEnv, ctx.nextUser, ctx.nextSecret);
    const nextProjectEnv = rotatedProjectCredentialEnv(service, ctx.runtime, ctx.originalProjectEnv, ctx.nextUser, ctx.nextSecret);
    this.state.updateInfraService(service.id, { env: nextServiceEnv }, service.projectId);
    this.state.setCustomEnv(nextProjectEnv, service.projectId);
    this.state.save();
    await this.state.flush();
    return await this.consumers.deploy(service, consumerIds, onProgress);
  }

  async verify(
    service: InfraService,
    prepared: RotationPreparedCredential,
    consumerIds: readonly string[],
    phase: 'before-revoke' | 'after-revoke',
  ): Promise<RotationRecoveryEvidence | void> {
    const ctx = contextOf(prepared);
    if (ctx.runtime === 'mongodb') {
      await withMongo(service, ctx.nextUser, ctx.nextSecret, async (client) => {
        const ping = await client.db('admin').command({ ping: 1 });
        if (ping.ok !== 1) throw new Error('rotation.mongodb_verify_failed');
        const canaryId = `cds-rotation-${crypto.randomBytes(8).toString('hex')}`;
        const canaries = client.db('admin').collection('_cds_rotation_canary');
        await canaries.insertOne({ _id: canaryId as never, at: new Date() });
        const found = await canaries.findOne({ _id: canaryId as never });
        await canaries.deleteOne({ _id: canaryId as never });
        if (!found) throw new Error('rotation.mongodb_canary_failed');
      });
    } else {
      const canaryKey = `cds:rotation:${crypto.randomBytes(8).toString('hex')}`;
      const canaryValue = crypto.randomBytes(12).toString('hex');
      const result = await this.runtimeOps.redisCommands(service.hostPort, [
        ['AUTH', ctx.nextUser, ctx.nextSecret],
        ['SET', canaryKey, canaryValue, 'EX', '60'],
        ['GET', canaryKey],
        ['DEL', canaryKey],
      ]);
      if (result[2] !== canaryValue || result[3] !== 1) throw new Error('rotation.redis_canary_failed');
    }
    await this.consumers.verify(service, consumerIds, ctx);
    if (phase === 'after-revoke') {
      if (ctx.runtime === 'redis') {
        await this.runtimeOps.restartContainer(service.containerName);
        let ready = false;
        for (let attempt = 0; attempt < 30; attempt += 1) {
          try {
            await this.runtimeOps.redisCommands(service.hostPort, [['AUTH', ctx.nextUser, ctx.nextSecret], ['PING']]);
            ready = true;
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
        if (!ready) throw new Error('rotation.redis_restart_verify_failed');
      }
      let oldAccepted = false;
      try {
        if (ctx.runtime === 'mongodb') {
          await withMongo(service, ctx.previousUser, ctx.previousSecret, async (client) => { await client.db('admin').command({ ping: 1 }); });
        } else {
          await this.runtimeOps.redisCommands(service.hostPort, [['AUTH', ctx.previousUser, ctx.previousSecret], ['PING']]);
        }
        oldAccepted = true;
      } catch {
        oldAccepted = false;
      }
      if (oldAccepted) throw new Error('rotation.previous_credential_still_accepted');
      const refreshed = this.state.getInfraServiceForProjectAndId(service.projectId, service.id);
      if (!refreshed) throw new Error('rotation.service_not_found_after_revoke');
      const resolved = resolvedServiceConfig(this.state, refreshed);
      const postRecovery = await this.recoveryDrill({
        ...refreshed,
        env: resolved.env,
        command: resolved.command,
        entrypoint: resolved.entrypoint,
      });
      const postCountValid = ctx.runtime === 'redis'
        ? postRecovery.restoredItemCount >= 0
        : postRecovery.restoredItemCount > 0;
      if (!postRecovery.backupId || !postRecovery.drillId
        || !/^[0-9a-f]{64}$/i.test(postRecovery.backupSha256) || !postCountValid) {
        throw new Error('rotation.post_revoke_recovery_failed');
      }
      return postRecovery;
    }
  }

  async revoke(service: InfraService, prepared: RotationPreparedCredential): Promise<void> {
    const ctx = contextOf(prepared);
    if (ctx.runtime === 'mongodb') {
      if (ctx.previousUser === ctx.nextUser) throw new Error('rotation.mongodb_user_not_rotated');
      await withMongo(service, ctx.nextUser, ctx.nextSecret, async (client) => {
        const admin = client.db('admin');
        const existing = await admin.command({ usersInfo: { user: ctx.previousUser, db: 'admin' } });
        if (Array.isArray(existing.users) && existing.users.length > 0) {
          await admin.command({ dropUser: ctx.previousUser });
        }
      });
      return;
    }
    const revokeCommands: string[][] = [
      ['AUTH', ctx.nextUser, ctx.nextSecret],
      ['ACL', 'SETUSER', ctx.nextUser, 'resetpass', `>${ctx.nextSecret}`],
    ];
    if (ctx.redisPersistence === 'aclfile') revokeCommands.push(['ACL', 'SAVE']);
    await this.runtimeOps.redisCommands(service.hostPort, revokeCommands);
    if (ctx.redisPersistence === 'recreate') {
      if (!this.infraRestarter) throw new Error('rotation.redis_recreate_unavailable');
      await this.infraRestarter.recreate(service);
    }
  }

  async rollback(
    service: InfraService,
    prepared: RotationPreparedCredential,
    _completedStages: readonly import('../types.js').InfraCredentialRotationStage[],
    consumerIds: readonly string[],
  ): Promise<void> {
    const ctx = contextOf(prepared);
    if (ctx.runtime === 'mongodb') {
      const restore = async (client: MongoClient): Promise<void> => {
        const admin = client.db('admin');
        const old = await admin.command({ usersInfo: { user: ctx.previousUser, db: 'admin' } });
        if (Array.isArray(old.users) && old.users.length > 0) {
          await admin.command({ updateUser: ctx.previousUser, pwd: ctx.previousSecret, roles: ctx.oldMongoRoles });
        } else {
          await admin.command({ createUser: ctx.previousUser, pwd: ctx.previousSecret, roles: ctx.oldMongoRoles });
        }
        const next = await admin.command({ usersInfo: { user: ctx.nextUser, db: 'admin' } });
        if (Array.isArray(next.users) && next.users.length > 0) await admin.command({ dropUser: ctx.nextUser });
      };
      try {
        await withMongo(service, ctx.nextUser, ctx.nextSecret, restore);
      } catch {
        await withMongo(service, ctx.previousUser, ctx.previousSecret, restore);
      }
    } else if (ctx.redisPersistence === 'aclfile') {
      const reset = async (user: string, secret: string): Promise<void> => {
        const commands: string[][] = [
          ['AUTH', user, secret],
          ['ACL', 'SETUSER', ctx.previousUser, 'on', 'resetpass', `>${ctx.previousSecret}`],
        ];
        if (ctx.redisPersistence === 'aclfile') commands.push(['ACL', 'SAVE']);
        await this.runtimeOps.redisCommands(service.hostPort, commands);
      };
      try { await reset(ctx.nextUser, ctx.nextSecret); }
      catch { await reset(ctx.previousUser, ctx.previousSecret); }
    }
    this.state.updateInfraService(service.id, { env: ctx.originalServiceEnv }, service.projectId);
    this.state.setCustomEnv(ctx.originalProjectEnv, service.projectId);
    this.state.save();
    await this.state.flush();
    if (ctx.runtime === 'redis' && ctx.redisPersistence === 'recreate') {
      if (!this.infraRestarter) throw new Error('rotation.redis_recreate_unavailable');
      await this.infraRestarter.recreate({ ...service, env: ctx.originalServiceEnv });
    }
    if (consumerIds.length > 0) {
      await this.consumers.deploy(service, consumerIds);
    }
  }

  async finalize(
    service: InfraService,
    _prepared: RotationPreparedCredential,
    outcome: 'success' | 'rollback-completed' | 'rollback-failed',
    record: InfraCredentialRotationRecord,
  ): Promise<void> {
    const recoveryDir = path.join(path.dirname(this.state.getCacheBase()), 'credential-rotation-recovery');
    const backupIds = record.events
      .map((event) => event.evidence?.backupId)
      .filter((backupId): backupId is string => typeof backupId === 'string' && backupId.startsWith('local:'));
    if (outcome === 'success') {
      const configuredRetentionHours = Number(process.env.CDS_ROTATION_BACKUP_RETENTION_HOURS || 168);
      const retentionHours = Number.isFinite(configuredRetentionHours)
        ? Math.max(1, Math.min(24 * 30, configuredRetentionHours))
        : 168;
      await markRotationRecoveryArtifactsForCleanup({
        recoveryDir,
        backupIds,
        retentionMs: retentionHours * 60 * 60 * 1_000,
      });
    } else {
      await markRotationRecoveryArtifactsForManualReview({
        recoveryDir,
        backupIds,
        operationId: record.id,
        reason: outcome,
      });
    }
    // rollback_failed 必须保留密封上下文供人工恢复，不得把唯一可续接材料清掉。
    if (outcome === 'rollback-failed') return;
    this.state.updateInfraService(service.id, { credentialRotationVault: undefined }, service.projectId);
    this.state.save();
    await this.state.flush();
  }
}
