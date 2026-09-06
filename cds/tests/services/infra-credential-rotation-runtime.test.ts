import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BranchEntry, InfraService } from '../../src/types.js';
import {
  CdsRotationConsumerCoordinator,
  ProjectSharedCredentialRotationBackend,
  rotatedCredentialEnv,
  rotatedProjectCredentialEnv,
} from '../../src/services/infra-credential-rotation-runtime.js';
import { isSealedSecret } from '../../src/infra/secret-seal.js';

function infra(): InfraService {
  return {
    id: 'mongodb', projectId: 'project-a', name: 'MongoDB', dockerImage: 'mongo:7',
    containerPort: 27017, hostPort: 17017, containerName: 'cds-mongodb', status: 'running',
    volumes: [], env: {}, createdAt: '2026-09-06T00:00:00.000Z',
  };
}

describe('共享凭据轮换真实消费者适配', () => {
  it('drain 枚举持久短作业、资源任务与 Mongo 迁移，非零时返回阻断证据', async () => {
    const state = {
      listActiveInfraMaintenanceJobs: () => [{ id: 'imj-1' }],
      listResourceCloneTasks: () => [{ id: 'clone-1', status: 'running' }, { id: 'clone-done', status: 'completed' }],
      getDataMigrations: () => [{ id: 'migration-1', status: 'running' }],
    } as never;
    const backend = new ProjectSharedCredentialRotationBackend(
      state, {} as never, async () => { throw new Error('unused'); }, undefined, undefined, { timeoutMs: 0 },
    );

    await expect(backend.waitForQuiescence(infra())).resolves.toEqual({
      activeJobIds: ['maintenance:imj-1', 'migration:migration-1', 'resource:clone-1'],
    });
  });

  it('drain 在有界等待内观察到作业结束后放行', async () => {
    let active = true;
    const state = {
      listActiveInfraMaintenanceJobs: () => active ? [{ id: 'imj-1' }] : [],
      listResourceCloneTasks: () => [],
      getDataMigrations: () => [],
    } as never;
    const backend = new ProjectSharedCredentialRotationBackend(
      state, {} as never, async () => { throw new Error('unused'); }, undefined, undefined,
      { timeoutMs: 100, pollMs: 25, sleep: async () => { active = false; } },
    );

    await expect(backend.waitForQuiescence(infra())).resolves.toEqual({ activeJobIds: [] });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('只枚举显式 dependsOn 目标资源且已有运行实例的 profile', async () => {
    const branches = {
      branch1: {
        id: 'branch1', projectId: 'project-a', status: 'running', services: {
          api: { profileId: 'api', containerName: 'api-1', hostPort: 1, status: 'running' },
          web: { profileId: 'web', containerName: 'web-1', hostPort: 2, status: 'running' },
          admin: { profileId: 'admin', containerName: 'admin-1', hostPort: 6, status: 'running' },
          worker: { profileId: 'worker', containerName: 'worker-1', hostPort: 3, status: 'running' },
          legacy: { profileId: 'legacy', containerName: 'legacy-1', hostPort: 5, status: 'running' },
        },
      },
      dormant: { id: 'dormant', projectId: 'project-a', status: 'stopped', services: {
        api: { profileId: 'api', containerName: 'api-old', hostPort: 4, status: 'stopped' },
      } },
      foreign: { id: 'foreign', projectId: 'project-b', status: 'running', services: { api: { profileId: 'api', containerName: 'api-2' } } },
    } as unknown as Record<string, BranchEntry>;
    const state = {
      getState: () => ({ branches }),
      getEffectiveProfilesForBranch: (branch: BranchEntry) => branch.id === 'branch1'
        ? [{ id: 'api', dependsOn: ['mongodb'] }, { id: 'web', dependsOn: [] }, { id: 'admin', dependsOn: [] }, {
          id: 'worker', dependsOn: [], env: { DATABASE: '${CDS_MONGODB_URL}' },
        }, { id: 'legacy', dependsOn: [], env: { MongoDB__ConnectionString: 'runtime-owned' } }]
        : [{ id: 'api', dependsOn: ['mongodb'] }],
      getCustomEnv: () => ({}),
    } as never;
    const target = { ...infra(), env: { MONGO_INITDB_ROOT_USERNAME: 'root', MONGO_INITDB_ROOT_PASSWORD: 'current-secret' } };
    const coordinator = new CdsRotationConsumerCoordinator(state, { masterPort: 9900 } as never, {
      inspectContainerEnv: vi.fn(async (containerName) => containerName === 'legacy-1'
        ? {
          CDS_MONGODB_URL: 'mongodb://root:current-secret@mongodb:27017/app',
          MongoDB__ConnectionString: 'mongodb://root:current-secret@mongodb:27017/app',
        }
        : { CDS_MONGODB_URL: 'mongodb://root:current-secret@mongodb:27017/app' }),
      fetch: vi.fn(),
    });
    expect(await coordinator.enumerate(target)).toEqual(['branch1/api', 'branch1/worker', 'branch1/legacy']);
  });

  it('同一分支多个消费者只触发一次 CDS 全量部署并等待 complete 事件', async () => {
    const branch = {
      id: 'branch1', projectId: 'project-a', githubCommitSha: 'a'.repeat(40), lastReadyAt: '2026-09-06T01:00:00Z', services: {},
    } as unknown as BranchEntry;
    const fetchMock = vi.fn(async () => new Response('event: complete\ndata: {"ok":true}\n\n', { status: 200 }));
    const progress = vi.fn(async () => undefined);
    vi.stubGlobal('fetch', fetchMock);
    const coordinator = new CdsRotationConsumerCoordinator({ getBranch: () => branch } as never, { masterPort: 9900 } as never);
    const result = await coordinator.deploy(infra(), ['branch1/api', 'branch1/worker'], progress);
    expect(result.revision).toMatch(/^[0-9a-f]{16}$/);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenCalledWith(['branch1/api', 'branch1/worker']);
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.headers).toMatchObject({
      'X-CDS-Internal': '1',
      'X-CDS-Source-Project-Id': 'project-a',
      'X-CDS-Source-Branch-Id': 'branch1',
    });
  });

  it.each([
    {
      profileId: 'api', hostPort: 15000, readinessPath: '/health/ready', status: 'healthy',
      components: [{ name: 'mongodb', ready: true }, { name: 'redis', ready: true }, { name: 'asset-storage', ready: true }],
    },
    {
      profileId: 'llmgw', hostPort: 18090, readinessPath: '/gw/readyz', status: 'ready',
      components: [{ name: 'mongodb', ready: true }],
    },
    {
      profileId: 'llmgw-serve', hostPort: 18091, readinessPath: '/gw/v1/readyz', status: 'ready',
      components: [{ name: 'gateway-mongo', ready: true }, { name: 'asset-storage', ready: true }, { name: 'router', ready: true }],
    },
  ])('$profileId 接受真实 readiness components 数组形状', async ({
    profileId, hostPort, readinessPath, status, components,
  }) => {
    const branch = {
      id: 'branch1', projectId: 'project-a', status: 'running', services: {
        [profileId]: { profileId, containerName: `${profileId}-1`, hostPort, status: 'running' },
      },
    } as unknown as BranchEntry;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const probeDeps = {
      inspectContainerEnv: vi.fn(async () => ({
        MongoDB__ConnectionString: 'mongodb://next-secret@mongodb',
        LlmGwServe__ApiKey: 'gateway-internal-key',
      })),
      fetch: vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ status, components }), { status: 200 });
      }),
    };
    const coordinator = new CdsRotationConsumerCoordinator({
      getBranch: () => branch,
      getEffectiveProfilesForBranch: () => [{ id: profileId, readinessProbe: { path: readinessPath } }],
    } as never, { masterPort: 9900 } as never, probeDeps);
    await coordinator.verify(infra(), [`branch1/${profileId}`], {
      runtime: 'mongodb', previousUser: 'old', previousSecret: 'old-secret', nextUser: 'next', nextSecret: 'next-secret',
      originalServiceEnv: {}, originalProjectEnv: {}, resolvedServiceEnv: {},
    } as never);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`http://127.0.0.1:${hostPort}${readinessPath}`);
    if (profileId === 'llmgw-serve') {
      expect(calls[0].init?.headers).toMatchObject({ 'X-Gateway-Key': 'gateway-internal-key' });
    }
  });

  it.each([
    {
      label: 'serving 401', profileId: 'llmgw-serve', path: '/gw/v1/readyz', httpStatus: 401,
      body: { status: 'ready', components: [{ name: 'gateway-mongo', ready: true }] },
      error: 'rotation.business_readiness_auth_failed',
    },
    {
      label: 'API 403', profileId: 'api', path: '/health/ready', httpStatus: 403,
      body: { status: 'healthy', components: [{ name: 'mongodb', ready: true }, { name: 'redis', ready: true }, { name: 'asset-storage', ready: true }] },
      error: 'rotation.consumer_readiness_failed',
    },
    {
      label: 'API wrong status', profileId: 'api', path: '/health/ready', httpStatus: 200,
      body: { status: 'ready', components: [{ name: 'mongodb', ready: true }, { name: 'redis', ready: true }, { name: 'asset-storage', ready: true }] },
      error: 'rotation.consumer_readiness_invalid',
    },
    {
      label: 'API 缺少 required component', profileId: 'api', path: '/health/ready', httpStatus: 200,
      body: { status: 'healthy', components: [{ name: 'mongodb', ready: true }, { name: 'redis', ready: true }] },
      error: 'rotation.consumer_dependency_not_ready',
    },
  ])('$label 必须失败', async ({ profileId, path: readinessPath, httpStatus, body, error }) => {
    const branch = {
      id: 'branch1', projectId: 'project-a', status: 'running', services: {
        [profileId]: { profileId, containerName: `${profileId}-1`, hostPort: 18091, status: 'running' },
      },
    } as unknown as BranchEntry;
    const coordinator = new CdsRotationConsumerCoordinator({
      getBranch: () => branch,
      getEffectiveProfilesForBranch: () => [{ id: profileId, readinessProbe: { path: readinessPath } }],
    } as never, { masterPort: 9900 } as never, {
      inspectContainerEnv: vi.fn(async () => ({
        MongoDB__ConnectionString: 'mongodb://next-secret@mongodb',
        LlmGwServe__ApiKey: 'gateway-internal-key',
      })),
      fetch: vi.fn(async () => new Response(JSON.stringify(body), { status: httpStatus })),
    });
    await expect(coordinator.verify(infra(), [`branch1/${profileId}`], {
      runtime: 'mongodb', previousUser: 'old', previousSecret: 'old-secret', nextUser: 'next', nextSecret: 'next-secret',
      originalServiceEnv: {}, originalProjectEnv: {}, resolvedServiceEnv: {},
    } as never)).rejects.toThrow(error);
  });

  it('全局 CDS 新凭据不能掩盖应用连接仍为旧凭据，即使 readiness 返回 200', async () => {
    const branch = {
      id: 'branch1', projectId: 'project-a', status: 'running', services: {
        api: { profileId: 'api', containerName: 'api-1', hostPort: 15000, status: 'running' },
      },
    } as unknown as BranchEntry;
    const readiness = vi.fn(async () => new Response(JSON.stringify({
      status: 'healthy',
      components: [{ name: 'mongodb', ready: true }, { name: 'redis', ready: true }, { name: 'asset-storage', ready: true }],
    }), { status: 200 }));
    const coordinator = new CdsRotationConsumerCoordinator({
      getBranch: () => branch,
      getEffectiveProfilesForBranch: () => [{ id: 'api', readinessProbe: { path: '/health/ready' } }],
    } as never, { masterPort: 9900 } as never, {
      inspectContainerEnv: vi.fn(async () => ({
        CDS_MONGODB_URL: 'mongodb://next:next-secret@mongodb:27017/app',
        MongoDB__ConnectionString: 'mongodb://old:old-secret@mongodb:27017/app',
      })),
      fetch: readiness,
    });

    await expect(coordinator.verify(infra(), ['branch1/api'], {
      runtime: 'mongodb', previousUser: 'old', previousSecret: 'old-secret', nextUser: 'next', nextSecret: 'next-secret',
      originalServiceEnv: {}, originalProjectEnv: {}, resolvedServiceEnv: {},
    } as never)).rejects.toThrow('rotation.consumer_new_credential_not_loaded');
    expect(readiness).not.toHaveBeenCalled();
  });

  it('API 的 Redis 轮换只以 Redis__ConnectionString 加载新凭据为准', async () => {
    const branch = {
      id: 'branch1', projectId: 'project-a', status: 'running', services: {
        api: { profileId: 'api', containerName: 'api-1', hostPort: 15000, status: 'running' },
      },
    } as unknown as BranchEntry;
    const coordinator = new CdsRotationConsumerCoordinator({
      getBranch: () => branch,
      getEffectiveProfilesForBranch: () => [{ id: 'api', readinessProbe: { path: '/health/ready' } }],
    } as never, { masterPort: 9900 } as never, {
      inspectContainerEnv: vi.fn(async () => ({
        CDS_REDIS_URL: 'redis://:old-secret@redis:6379',
        Redis__ConnectionString: 'redis://:next%20secret@redis:6379',
      })),
      fetch: vi.fn(async () => new Response(JSON.stringify({
        status: 'healthy',
        components: [{ name: 'mongodb', ready: true }, { name: 'redis', ready: true }, { name: 'asset-storage', ready: true }],
      }), { status: 200 })),
    });
    await expect(coordinator.verify(infra(), ['branch1/api'], {
      runtime: 'redis', previousUser: 'default', previousSecret: 'old-secret', nextUser: 'default', nextSecret: 'next secret',
      originalServiceEnv: {}, originalProjectEnv: {}, resolvedServiceEnv: {},
    } as never)).resolves.toBeUndefined();
  });

  it('Mongo 与 Redis 只改凭据相关键，连接串编码特殊字符', () => {
    const mongo = rotatedCredentialEnv('mongodb', {
      MONGODB_USERNAME: 'old', MONGODB_PASSWORD: 'old-pass',
      MONGODB_URL: 'mongodb://old:old-pass@mongo:27017/app?authSource=admin', KEEP: 'yes',
    }, 'new-user', 'new pass/@');
    expect(mongo.KEEP).toBe('yes');
    expect(mongo.MONGODB_USERNAME).toBe('new-user');
    expect(mongo.MONGODB_PASSWORD).toBe('new pass/@');
    expect(mongo.MONGODB_URL).toContain('new-user:new%20pass%2F%40@mongo:27017');

    const redis = rotatedCredentialEnv('redis', {
      REDIS_PASSWORD: 'old', REDIS_URL: 'redis://:old@redis:6379/0', KEEP: 'yes',
    }, 'default', 'next secret');
    expect(redis.KEEP).toBe('yes');
    expect(redis.REDIS_PASSWORD).toBe('next secret');
    expect(redis.REDIS_URL).toContain(':next%20secret@redis:6379');

    const primaryMongo = {
      ...infra(),
      env: {
        MONGO_INITDB_ROOT_USERNAME: '${CDS_MONGO_USER}',
        MONGO_INITDB_ROOT_PASSWORD: '${CDS_MONGO_PASSWORD}',
      },
    };
    const project = rotatedProjectCredentialEnv(primaryMongo, 'mongodb', {
      CDS_MONGO_USER: 'old', CDS_MONGO_PASSWORD: 'old',
      CDS_MONGODB_URL: 'mongodb://old:old@mongodb:27017/admin?authSource=admin',
    }, 'rotated', 'new-secret');
    expect(project.CDS_MONGO_USER).toBe('rotated');
    expect(project.CDS_MONGO_PASSWORD).toBe('new-secret');
    expect(project.CDS_MONGODB_USER).toBe('rotated');
    expect(project.CDS_MONGODB_PASSWORD).toBe('new-secret');
    expect(project.CDS_MONGODB_URL).toContain('rotated:new-secret@mongodb:27017');
    expect(project.CDS_MONGODB_URL).toContain('/admin?authSource=admin');

    const secondary = rotatedProjectCredentialEnv({ ...infra(), id: 'mongodb-2' }, 'mongodb', {
      CDS_MONGO_USER: 'primary', CDS_MONGO_PASSWORD: 'primary-secret',
      CDS_MONGODB_URL: 'mongodb://primary:primary-secret@mongodb:27017',
      MONGODB_PASSWORD: 'primary-generic-secret',
      MONGODB_URL: 'mongodb://primary:primary-generic-secret@mongodb:27017',
    }, 'secondary', 'secondary-secret');
    expect(secondary.CDS_MONGO_USER).toBe('primary');
    expect(secondary.CDS_MONGO_PASSWORD).toBe('primary-secret');
    expect(secondary.CDS_MONGODB_URL).toContain('@mongodb:27017');
    expect(secondary.CDS_MONGODB_2_PASSWORD).toBe('secondary-secret');
    expect(secondary.MONGODB_PASSWORD).toBe('primary-generic-secret');
    expect(secondary.MONGODB_URL).toContain('@mongodb:27017');
  });

  it('prepare 解析 project customEnv 模板并持久化可跨进程恢复的密封上下文', async () => {
    vi.stubEnv('CDS_SECRET_KEY', 'a'.repeat(64));
    const target = { ...infra(), id: 'redis', dockerImage: 'redis:7', containerPort: 6379, hostPort: 16379,
      env: { REDIS_USERNAME: '${CDS_REDIS_USER}', REDIS_PASSWORD: '${CDS_REDIS_PASSWORD}' },
      command: ['redis-server', '--aclfile', '/run/redis/users.acl'] } as InfraService;
    const customEnv = { CDS_REDIS_USER: 'map-agent', CDS_REDIS_PASSWORD: 'old-template-secret' };
    let flushes = 0;
    const state = {
      getCustomEnv: () => customEnv,
      getCustomEnvScope: () => customEnv,
      updateInfraService: (_id: string, updates: Partial<InfraService>) => Object.assign(target, updates),
      save: () => undefined,
      flush: async () => { flushes += 1; },
    } as never;
    const coordinator = {} as never;
    const firstBackend = new ProjectSharedCredentialRotationBackend(state, coordinator, async () => { throw new Error('unused'); });
    const first = await firstBackend.prepare(target, { operationId: 'icr-restart', idempotencyKey: 'request-restart' });
    expect((first.opaque as any).previousUser).toBe('map-agent');
    expect((first.opaque as any).previousSecret).toBe('old-template-secret');
    expect(isSealedSecret(target.credentialRotationVault?.payload)).toBe(true);
    expect(JSON.stringify(target.credentialRotationVault)).not.toContain('old-template-secret');
    expect(flushes).toBe(1);

    const secondBackend = new ProjectSharedCredentialRotationBackend(state, coordinator, async () => { throw new Error('unused'); });
    const resumed = await secondBackend.prepare(target, { operationId: 'icr-restart', idempotencyKey: 'request-restart' });
    expect(resumed.previousFingerprint).toBe(first.previousFingerprint);
    expect(resumed.nextFingerprint).toBe(first.nextFingerprint);
  });

  it('Redis ACL 每次变更都持久化并在容器重启后复验新旧口令', async () => {
    const target = { ...infra(), id: 'redis', dockerImage: 'redis:7', containerPort: 6379, hostPort: 16379,
      env: { REDIS_USERNAME: 'map-agent', REDIS_PASSWORD: 'old-secret' },
      command: ['redis-server', '--aclfile', '/run/redis/users.acl'] } as InfraService;
    const commandLog: string[][][] = [];
    const restart = vi.fn(async () => undefined);
    const runtimeOps = {
      restartContainer: restart,
      redisCommands: vi.fn(async (_port: number, commands: readonly (readonly string[])[]) => {
        commandLog.push(commands.map((row) => [...row]));
        if (commands.some((row) => row[0] === 'CONFIG')) return ['OK', ['aclfile', '/run/redis/users.acl']];
        if (commands.some((row) => row[0] === 'SET')) return ['OK', 'OK', commands[1][2], 1];
        if (restart.mock.calls.length > 0 && commands[0]?.[2] === 'old-secret') throw new Error('WRONGPASS');
        return commands.map(() => 'OK');
      }),
    };
    const state = {
      getInfraServiceForProjectAndId: () => target,
      getCustomEnv: () => target.env,
    } as never;
    const consumers = { verify: vi.fn(async () => undefined) } as never;
    const recovery = vi.fn(async () => ({
      backupId: 'backup-after', backupSha256: 'a'.repeat(64), drillId: 'drill-after',
      restoredItemCount: 0, verifiedAt: '2026-09-06T00:00:00.000Z',
    }));
    const backend = new ProjectSharedCredentialRotationBackend(state, consumers, recovery, runtimeOps);
    const prepared = {
      previousFingerprint: '1'.repeat(16), nextFingerprint: '2'.repeat(16),
      opaque: {
        runtime: 'redis', previousUser: 'map-agent', previousSecret: 'old-secret',
        nextUser: 'map-agent', nextSecret: 'new-secret', originalServiceEnv: target.env,
        originalProjectEnv: target.env, resolvedServiceEnv: target.env, aclFile: '/run/redis/users.acl',
        redisPersistence: 'aclfile',
      },
    };
    await backend.issue(target, prepared);
    await backend.revoke(target, prepared);
    await backend.verify(target, prepared, ['branch/api'], 'after-revoke');
    expect(commandLog.filter((batch) => batch.some((row) => row[0] === 'ACL' && row[1] === 'SAVE'))).toHaveLength(2);
    expect(restart).toHaveBeenCalledWith('cds-mongodb');
    expect(recovery).toHaveBeenCalledOnce();
  });

  it('Redis requirepass 通过重建权威容器持久化新口令', async () => {
    vi.stubEnv('CDS_SECRET_KEY', 'b'.repeat(64));
    const target = { ...infra(), id: 'redis', dockerImage: 'redis:7', containerPort: 6379, hostPort: 16379,
      env: { REDIS_PASSWORD: 'old-secret' },
      command: ['sh', '-c', 'exec redis-server --requirepass "${CDS_REDIS_PASSWORD}"'] } as InfraService;
    let projectEnv = { REDIS_PASSWORD: 'old-secret', CDS_REDIS_PASSWORD: 'old-secret' };
    const state = {
      getCustomEnv: () => projectEnv,
      getCustomEnvScope: () => projectEnv,
      updateInfraService: (_id: string, updates: Partial<InfraService>) => Object.assign(target, updates),
      setCustomEnv: (env: Record<string, string>) => { projectEnv = env as typeof projectEnv; },
      save: () => undefined,
      flush: async () => undefined,
    } as never;
    const consumers = { deploy: vi.fn(async () => ({ revision: 'revision-new' })) } as never;
    const runtimeOps = {
      restartContainer: vi.fn(async () => undefined),
      redisCommands: vi.fn(async (_port: number, commands: readonly (readonly string[])[]) => commands.map(() => 'OK')),
    };
    const restarter = { recreate: vi.fn(async () => undefined) };
    const backend = new ProjectSharedCredentialRotationBackend(
      state, consumers, async () => { throw new Error('unused'); }, runtimeOps, restarter,
    );
    const prepared = await backend.prepare(target, { operationId: 'icr-requirepass', idempotencyKey: 'request-requirepass' });
    await backend.issue(target, prepared);
    await backend.deploy(target, prepared, ['branch/api']);
    await backend.revoke(target, prepared);
    expect(restarter.recreate).toHaveBeenCalledOnce();
    expect(target.env.REDIS_PASSWORD).not.toBe('old-secret');
    expect(projectEnv.CDS_REDIS_PASSWORD).toBe(target.env.REDIS_PASSWORD);
    expect(runtimeOps.redisCommands.mock.calls.flatMap((call) => call[1]).some((row) => row[0] === 'ACL' && row[1] === 'SAVE')).toBe(false);
  });

  it('Redis requirepass 回滚先耐久恢复旧配置再重建，不依赖已停止实例 AUTH', async () => {
    const order: string[] = [];
    const target = { ...infra(), id: 'redis', dockerImage: 'redis:7', containerPort: 6379, hostPort: 16379,
      env: { REDIS_PASSWORD: 'new-secret' }, command: ['redis-server', '--requirepass', '${CDS_REDIS_PASSWORD}'] } as InfraService;
    let projectEnv = { CDS_REDIS_PASSWORD: 'new-secret' };
    const state = {
      updateInfraService: (_id: string, updates: Partial<InfraService>) => {
        order.push('restore-service-env');
        Object.assign(target, updates);
      },
      setCustomEnv: (env: Record<string, string>) => { order.push('restore-project-env'); projectEnv = env as typeof projectEnv; },
      save: () => { order.push('save'); },
      flush: async () => { order.push('flush'); },
    } as never;
    const runtimeOps = {
      restartContainer: vi.fn(async () => undefined),
      redisCommands: vi.fn(async () => { throw new Error('stopped redis must not be contacted'); }),
    };
    const restarter = { recreate: vi.fn(async (restored: InfraService) => {
      order.push('recreate');
      expect(restored.env.REDIS_PASSWORD).toBe('old-secret');
    }) };
    const consumers = { deploy: vi.fn(async () => ({ revision: 'rollback-revision' })) } as never;
    const backend = new ProjectSharedCredentialRotationBackend(
      state, consumers, async () => { throw new Error('unused'); }, runtimeOps, restarter,
    );
    await backend.rollback(target, {
      previousFingerprint: '1'.repeat(16), nextFingerprint: '2'.repeat(16), opaque: {
        runtime: 'redis', previousUser: 'default', previousSecret: 'old-secret',
        nextUser: 'default', nextSecret: 'new-secret', originalServiceEnv: { REDIS_PASSWORD: 'old-secret' },
        originalProjectEnv: { CDS_REDIS_PASSWORD: 'old-secret' }, resolvedServiceEnv: { REDIS_PASSWORD: 'old-secret' },
        redisPersistence: 'recreate',
      },
    }, ['issued'], []);

    expect(runtimeOps.redisCommands).not.toHaveBeenCalled();
    expect(order.indexOf('flush')).toBeLessThan(order.indexOf('recreate'));
    expect(target.env.REDIS_PASSWORD).toBe('old-secret');
    expect(projectEnv.CDS_REDIS_PASSWORD).toBe('old-secret');
  });
});
