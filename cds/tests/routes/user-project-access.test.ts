import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { createServer } from '../../src/server.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { MemoryAuthStore } from '../../src/infra/auth-store/memory-store.js';
import { humanPrincipalId, humanProjectGrantUpdateStatus, beginHumanProjectGrantUpdate } from '../../src/services/human-project-access.js';
import { createIdentityRouter, resolveUserCredential } from '../../src/routes/identity.js';
import { DeploymentRunService } from '../../src/services/deployment-run.js';
import { multiPreviewUrl } from '../../web/src/lib/previewUrl.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import { branchEvents } from '../../src/services/branch-events.js';
import { ExecutorRegistry } from '../../src/scheduler/executor-registry.js';
import type { CdsConfig } from '../../src/types.js';

describe('human project grants through the production server', () => {
  let dir: string;
  let server: http.Server;
  let state: StateService;
  let base: string;
  let owner: string;
  let member: string;
  let memberId: string;
  let store: MemoryAuthStore;
  let registry: ExecutorRegistry;
  let shell: MockShellExecutor;
  let container: { getRunningContainerNames: () => Promise<Set<string>>; getTotalMemoryGB: () => Promise<number>;
    getLogs: () => Promise<string>; isRunning?: (name: string) => Promise<boolean> };

  async function call(method: string, url: string, cookie = owner, body?: unknown) {
    const res = await fetch(base + url, {
      method, headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] || '' };
  }
  const grant = (ids: string[]) => call('PUT', `/api/auth/users/${memberId}/projects`, owner, { projectIds: ids });
  async function credentialCall(method: string, url: string, key: string, body?: unknown) {
    const res = await fetch(base + url, { method,
      headers: { 'x-ai-access-key': key, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json() };
  }

  beforeEach(async () => {
    vi.stubEnv('CDS_AUTH_MODE', 'basic');
    vi.stubEnv('CDS_USERNAME', 'owner');
    vi.stubEnv('CDS_PASSWORD', 'test-owner-password');
    vi.stubEnv('CDS_PUBLIC_BASE_URL', 'http://localhost');
    vi.stubEnv('CDS_SSO_ENABLED', 'false');
    vi.stubEnv('CDS_GRANT_RECONCILE_MS', '20');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-human-grants-'));
    state = new StateService(path.join(dir, 'state.json'), dir);
    state.load();
    for (const id of ['project-a', 'project-b']) {
      state.addProject({ id, slug: id, name: id, dockerNetwork: id, repoPath: dir,
        kind: 'git', legacyFlag: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      state.addBranch({ id: `branch-${id}`, projectId: id, branch: 'feature', status: 'idle',
        worktreePath: dir, services: {}, createdAt: new Date().toISOString() });
      state.addBuildProfile({ id: `profile-${id}`, projectId: id, name: id, dockerImage: 'node:20',
        command: '', workDir: '.', containerPort: 3000, env: { API_TOKEN: 'test-project-secret', NODE_ENV: 'test' },
        deployModes: { alternate: { label: 'alternate', env: { API_TOKEN: 'test-mode-secret' } } } });
    }
    store = new MemoryAuthStore();
    registry = new ExecutorRegistry(state);
    shell = new MockShellExecutor();
    const config: CdsConfig = { repoRoot: dir, worktreeBase: path.join(dir, 'worktrees'),
      masterPort: 9900, workerPort: 5500, dockerNetwork: 'cds', portStart: 10001,
      sharedEnv: {}, jwt: { secret: 'test', issuer: 'test' }, rootDomains: ['example.test'] };
    container = { getRunningContainerNames: async () => new Set(), getTotalMemoryGB: async () => 8,
      getLogs: async () => 'PASSWORD=fake-diagnostic-secret\nbooting\n' };
    const app = createServer({ stateService: state, worktreeService: new WorktreeService(shell, dir),
      shell, config, authStore: store, registry, bridgeService: {} as any,
      containerService: container as any,
      proxyService: { getProxyLog: () => [], setOnProxyLog: () => {}, handleSwitchFromExpress: () => {} } as any });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    owner = (await call('POST', '/api/auth/login', '', { username: 'owner', password: 'test-owner-password' })).cookie;
    const user = await call('POST', '/api/auth/users', owner, { username: 'guest', password: 'test-guest-password' });
    memberId = user.body.user.id;
    member = (await call('POST', '/api/auth/login', '', { username: 'guest', password: 'test-guest-password' })).cookie;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (let attempt = 0; attempt < 20 && humanProjectGrantUpdateStatus(state, humanPrincipalId(memberId)); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await flushAllJsonStateStores();
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('isolates project, cached branch and build-profile lists; old owner keeps global access', async () => {
    expect((await call('GET', '/api/projects', member)).body).toMatchObject({ projects: [], canManageProjects: false });
    // Warm the all-project cache as owner before the member request.
    expect((await call('GET', '/api/branches')).body.branches).toHaveLength(2);
    expect((await grant(['project-a'])).status).toBe(200);
    expect((await call('GET', '/api/projects', member)).body.projects.map((p: any) => p.id)).toEqual(['project-a']);
    const branches = await call('GET', '/api/branches', member);
    expect(branches.body.branches.map((b: any) => b.projectId)).toEqual(['project-a']);
    expect(branches.body.capacity).toBeUndefined();
    expect((await call('GET', '/api/build-profiles', member)).body.profiles.map((p: any) => p.projectId)).toEqual(['project-a']);
    expect((await call('GET', '/api/projects')).body.projects).toHaveLength(2);
    expect((await call('GET', '/api/projects')).body.canManageProjects).toBe(true);
  });

  it('returns only public preview inputs to members, preserving the owner config', async () => {
    const visible = await call('GET', '/api/config', member);
    expect(visible.status).toBe(200);
    expect(Object.keys(visible.body).sort()).toEqual(['previewDomain', 'workerPort']);
    expect(multiPreviewUrl({ id: 'branch-project-a', previewSlug: 'fixture-preview' }, visible.body,
      { protocol: 'https:', hostname: 'example.test' })).toBe('https://fixture-preview.example.test');
    expect(visible.body).not.toHaveProperty('jwt');
    expect(visible.body).not.toHaveProperty('sharedEnv');
    expect((await call('GET', '/api/config')).body).toHaveProperty('repoRoot', dir);
  });

  it('filters secondary CDS references and URL matches by target grants without hiding the source branch', async () => {
    await grant(['project-a']);
    state.updateProject('project-b', { gitDefaultBranch: 'feature' });
    Object.assign(state.getBranch('branch-project-b')!, {
      status: 'running', previewSlug: 'private-target-preview',
      services: { 'profile-project-b': { profileId: 'profile-project-b', containerName: 'target', hostPort: 10002, status: 'running' } },
    });
    state.setBranchProfileOverride('branch-project-a', 'profile-project-a', {
      env: { TARGET_BASE: '${CDS_REF:project-b/profile-project-b}' },
    });
    const resolvedUrl = (await call('GET', '/api/branches/branch-project-a/references')).body.references
      .find((ref: any) => ref.key === 'TARGET_BASE').resolved[0].url;
    expect(resolvedUrl).toEqual(expect.any(String));
    state.setBranchProfileOverride('branch-project-a', 'profile-project-a', {
      env: { TARGET_BASE: '${CDS_REF:project-b/profile-project-b}', TARGET_LITERAL_URL: resolvedUrl },
    });
    for (const route of ['references', 'service-graph']) {
      const url = `/api/branches/branch-project-a/${route}`;
      const view = await call('GET', url, member);
      expect(view.status).toBe(200);
      const refs = Object.fromEntries(view.body.references.map((ref: any) => [ref.key, ref]));
      expect(refs.TARGET_BASE.resolved[0]).toMatchObject({ url: null, status: 'restricted', target: { serviceId: 'profile-project-b' } });
      expect(refs.TARGET_BASE.resolved[0].target).not.toHaveProperty('projectId');
      expect(refs.TARGET_BASE.resolved[0].target).not.toHaveProperty('branchId');
      expect(refs.TARGET_BASE.value).toBe('${CDS_REF:project-b/profile-project-b}');
      expect(refs.TARGET_LITERAL_URL.matchedBranch).toBeNull();
      expect(refs.TARGET_LITERAL_URL.suggestion).toBeUndefined();
      expect(JSON.stringify(view.body)).not.toContain('branch-project-b');
      const ownerRefs = Object.fromEntries((await call('GET', url)).body.references.map((ref: any) => [ref.key, ref]));
      expect(ownerRefs.TARGET_BASE.resolved[0]).toMatchObject({ status: 'running', target: { projectId: 'project-b', branchId: 'branch-project-b' } });
      expect(ownerRefs.TARGET_LITERAL_URL.matchedBranch).toMatchObject({ branchId: 'branch-project-b' });
    }
    await grant(['project-a', 'project-b']);
    const grantedRefs = Object.fromEntries((await call('GET', '/api/branches/branch-project-a/references', member))
      .body.references.map((ref: any) => [ref.key, ref]));
    expect(grantedRefs.TARGET_BASE.resolved[0]).toMatchObject({ status: 'running', target: { branchId: 'branch-project-b' } });
    expect(grantedRefs.TARGET_LITERAL_URL.matchedBranch).toMatchObject({ branchId: 'branch-project-b' });
  });

  it('scopes deployment lists, detail, diagnosis and streams without leaking credentials', async () => {
    await grant(['project-a']);
    const runs = new DeploymentRunService(state);
    const a = await runs.begin({ projectId: 'project-a', branchId: 'branch-project-a', trigger: 'manual',
      message: 'PASSWORD=fake-run-secret' });
    const b = await runs.begin({ projectId: 'project-b', branchId: 'branch-project-b', trigger: 'manual' });
    const list = await call('GET', '/api/deployment-runs?project=project-a&branch=branch-project-a', member);
    expect(list.status).toBe(200);
    expect(list.body.runs.map((run: any) => run.id)).toEqual([a.id]);
    expect(JSON.stringify(list.body)).not.toContain('fake-run-secret');
    for (const url of [`/api/deployment-runs/${a.id}`, `/api/deployment-runs/${a.id}/diagnosis`]) {
      const result = await call('GET', url, member);
      expect(result.status).toBe(200);
      expect(JSON.stringify(result.body)).not.toContain('fake-run-secret');
    }
    for (const url of ['/api/deployment-runs', '/api/deployment-runs?project=project-b',
      `/api/deployment-runs/${b.id}`, `/api/deployment-runs/${b.id}/diagnosis`, `/api/deployment-runs/${b.id}/stream`]) {
      expect((await call('GET', url, member)).status).toBe(403);
    }
    const abort = new AbortController();
    const stream = await fetch(base + `/api/deployment-runs/${a.id}/stream`, { headers: { Cookie: member }, signal: abort.signal });
    const reader = stream.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('snapshot');
    expect(first).not.toContain('fake-run-secret');
    await grant([]);
    runs.append(a.id, { phase: 'build', level: 'info', message: 'after-revocation' });
    const next = await reader.read();
    expect(next.done).toBe(true);
    abort.abort();
    expect(JSON.stringify((await call('GET', `/api/deployment-runs/${a.id}`)).body)).toContain('fake-run-secret');
  });

  it('bounds a stalled grant response and restores late writes before releasing the gate', async () => {
    await grant(['project-a']);
    vi.stubEnv('CDS_GRANT_FLUSH_TIMEOUT_MS', '20');
    let finish!: () => void;
    const stalled = new Promise<void>(resolve => { finish = resolve; });
    const flush = vi.spyOn(state, 'flush').mockImplementationOnce(() => stalled);
    const response = await grant(['project-b']);
    expect(response.status).toBe(500);
    expect(response.body.error).toContain('持久化状态无法确认');
    const status = await call('GET', `/api/auth/users/${memberId}/projects`);
    expect(status.status).toBe(409);
    expect(status.body.update.reconciling).toBe(true);
    expect((await call('GET', '/api/projects', member)).status).toBe(409);
    finish();
    for (let attempt = 0; attempt < 20 && humanProjectGrantUpdateStatus(state, humanPrincipalId(memberId)); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(humanProjectGrantUpdateStatus(state, humanPrincipalId(memberId))).toBeUndefined();
    expect(flush).toHaveBeenCalledTimes(2);
    expect((await call('GET', '/api/projects', member)).body.projects.map((p: any) => p.id)).toEqual(['project-a']);
    fs.copyFileSync(path.join(dir, 'state.json'), path.join(dir, 'late-write-restored.json'));
    const restored = new StateService(path.join(dir, 'late-write-restored.json'));
    restored.load();
    expect(restored.getProjectGrants().filter(g => !g.revokedAt).map(g => g.projectId)).toEqual(['project-a']);
    expect((await grant(['project-b'])).status).toBe(200);
  });

  it('blocks cross-project reads, writes, query overrides, derivation and system/credential escalation', async () => {
    await grant(['project-a']);
    state.getBuildProfilesForProject('project-a')[0].command = 'API_TOKEN=fake-command-env-secret redis-server --requirepass fake-command-flag-secret';
    const memberProfiles = JSON.stringify((await call('GET', '/api/build-profiles', member)).body);
    expect(memberProfiles).not.toContain('fake-command-env-secret');
    expect(memberProfiles).not.toContain('fake-command-flag-secret');
    expect(JSON.stringify((await call('GET', '/api/build-profiles')).body)).toContain('fake-command-env-secret');
    state.setBranchExtraProfiles('branch-project-a', [{ id: 'extra', name: 'extra', dockerImage: 'node:20',
      command: '', workDir: '.', containerPort: 3001,
      deployModes: { alternate: { label: 'alternate', env: { API_TOKEN: 'extra-mode-secret' } } } }]);
    for (const [method, url, body] of [
      ['GET', '/api/projects/project-b'], ['GET', '/api/branches/branch-project-b'],
      ['POST', '/api/branches/branch-project-b/stop', {}],
      ['PATCH', '/api/branches/branch-project-a', { projectId: 'project-b' }],
      ['POST', '/api/branches/branch-project-a/copy-config-from/branch-project-b', {}],
      ['POST', '/api/branches', { branch: 'new', sourceBranchId: 'branch-project-b', projectId: 'project-a' }],
      ['POST', '/api/branches?project=project-a', { branch: 'default-bypass' }],
      ['GET', '/api/branches?project=project-b'], ['GET', '/api/branches?project=project-a&project=project-b'],
      ['GET', '/api/cds-system/operator/ops'], ['GET', '/api/env?scope=_all'],
      ['POST', '/api/identity/grants', { principalId: humanPrincipalId(memberId), projectId: 'project-b' }],
      ['POST', '/api/branches/branch-project-a/container-env', {}],
      ['GET', '/api/branches/branch-project-a/container-logs-stream/profile-project-a?unmask=1'],
      ['PUT', '/api/branches/branch-project-a/profile-overrides/profile-project-a', { command: 'arbitrary host command' }],
      ['PUT', '/api/branches/branch-project-a/custom-domains', { domains: ['other.example.test'] }],
      ['GET', '/api/projects/project-a/agent-keys'], ['POST', '/api/projects', {}],
      ['GET', '/api/projects/project-a/compose'], ['GET', '/api/projects/project-a/status-page'],
      ['GET', '/api/projects/project-a/storage'],
      ['DELETE', '/api/projects/project-a', {}],
    ] as const) {
      expect((await call(method, url, member, body)).status, `${method} ${url}`).toBe(403);
    }
    expect((await call('PATCH', '/api/branches/branch-project-a', member, { notes: 'guest edited' })).status).toBe(200);
    expect(state.getBranch('branch-project-a')?.notes).toBe('guest edited');
    state.setBranchProfileOverride('branch-project-a', 'profile-project-a', {
      command: 'redis-server --requirepass test-override-command-secret',
    });
    const profiles = await call('GET', '/api/branches/branch-project-a/profile-overrides', member);
    expect(profiles.status).toBe(200);
    expect(JSON.stringify(profiles.body)).not.toContain('test-project-secret');
    expect(JSON.stringify(profiles.body)).not.toContain('test-mode-secret');
    expect(JSON.stringify(profiles.body)).not.toContain('test-override-command-secret');
    expect(state.getBranch('branch-project-a')?.profileOverrides?.['profile-project-a'].command)
      .toContain('test-override-command-secret');
    expect(JSON.stringify((await call('GET', '/api/branches/branch-project-a/profile-overrides')).body))
      .toContain('test-override-command-secret');
    expect(profiles.body.profiles[0].effective.env.NODE_ENV).toBe('test');
    for (const url of ['/api/branches', '/api/branches/branch-project-a', '/api/branches/branch-project-a/extra-services']) {
      const view = await call('GET', url, member);
      expect(view.status).toBe(200);
      expect(JSON.stringify(view.body)).not.toContain('extra-mode-secret');
    }
    expect(state.getBranch('branch-project-a')?.extraProfiles?.[0].deployModes?.alternate.env?.API_TOKEN).toBe('extra-mode-secret');
    state.setBranchExtraProfiles('branch-project-a', []);
    expect((await call('POST', '/api/branches/branch-project-a/stop', member, {})).status).toBe(200);
    expect(state.getBranch('branch-project-a')?.stopCount).toBe(1);
  });

  it('projects member summaries through safe metadata while preserving owner and stored credentials', async () => {
    state.updateProject('project-a', {
      gitRepoUrl: 'https://x-access-token:fake-repo-pat@github.com/example/repo.git',
      serviceEnv: { API_TOKEN: 'fake-service-secret' }, statusPageToken: 'fake-status-secret',
      composeYaml: 'PASSWORD: fake-compose-secret', cloneStatus: 'error', cloneError: 'fake-clone-secret',
      customEnv: { TOKEN: 'fake-custom-secret' }, defaultEnv: { PASSWORD: 'fake-default-secret' },
    });
    await grant(['project-a']);
    for (const url of ['/api/projects', '/api/projects/project-a']) {
      const result = await call('GET', url, member);
      expect(result.status).toBe(200);
      const text = JSON.stringify(result.body);
      for (const secret of ['fake-repo-pat', 'fake-service-secret', 'fake-status-secret', 'fake-compose-secret', 'fake-clone-secret', 'fake-custom-secret', 'fake-default-secret']) {
        expect(text, url).not.toContain(secret);
        expect(JSON.stringify((await call('GET', url)).body), url).toContain(secret);
      }
      const project = result.body.projects?.[0] || result.body;
      expect(project.gitRepoUrl).toBe('https://github.com/example/repo.git');
      expect(project.name).toBe('project-a');
      expect(project.serviceEnv).toBeUndefined();
      expect(project.statusPageToken).toBeUndefined();
      expect(project.recovery).toBeUndefined();
    }
    expect(state.getProject('project-a')?.gitRepoUrl).toContain('fake-repo-pat');
    expect(state.getProject('project-a')?.serviceEnv?.API_TOKEN).toBe('fake-service-secret');
  });

  it.each(['mysql', 'mongo'] as const)('allows only existing read-only %s commands in authorized resources', async runtime => {
    const mongo = runtime === 'mongo';
    state.addInfraService({ id: runtime, projectId: 'project-a', name: runtime, dockerImage: mongo ? 'mongo:7' : 'mysql:8',
      containerPort: mongo ? 27017 : 3306, hostPort: mongo ? 27017 : 3306, containerName: `fixture-${runtime}`, status: 'running',
      dbName: 'app', env: mongo ? { MONGO_INITDB_ROOT_USERNAME: 'app', MONGO_INITDB_ROOT_PASSWORD: 'fake-db-password', MONGO_INITDB_DATABASE: 'app' }
        : { MYSQL_DATABASE: 'app', MYSQL_USER: 'app', MYSQL_PASSWORD: 'fake-db-password', MYSQL_ROOT_PASSWORD: 'fake-root-password' },
      volumes: [], createdAt: new Date().toISOString() });
    shell.addResponsePattern(mongo ? /fixture-mongo.*mongosh/s : /docker exec.* mysql /s, () => ({
      stdout: mongo ? '[{"_id":"u1","name":"Ann"}]\n' : 'answer\n1\n', stderr: '', exitCode: 0,
    }));
    await grant(['project-a']);
    const suffix = `/resources/infra%3A${runtime}/data/${mongo ? 'mongo/command' : 'query'}`;
    const body = mongo ? { database: 'app', command: 'db.getCollection("users").find({}).limit(50);' } : { sql: 'SELECT 1 AS answer' };
    const url = '/api/branches/branch-project-a' + suffix;
    const ownerView = await call('POST', url, owner, body);
    expect(ownerView.status).toBe(200);
    const view = await call('POST', url, member, body);
    expect(view.status).toBe(200);
    expect(view.body).toEqual(ownerView.body);
    expect(JSON.stringify(view.body)).toContain(mongo ? 'Ann' : 'answer');
    const callsBeforeWrite = shell.commands.length;
    const writeBody = mongo ? { database: 'app', command: 'db.getCollection("users").deleteMany({});' } : { sql: 'DELETE FROM users' };
    expect((await call('POST', url, member, writeBody)).status).toBe(400);
    expect(shell.commands.length).toBe(callsBeforeWrite);
    const writeUrl = '/api/branches/branch-project-a' + `/resources/infra%3A${runtime}/data/${mongo ? 'mongo/write' : 'query-write'}`;
    expect((await call('POST', writeUrl, member, writeBody)).status).toBe(403);
    expect((await call('POST', '/api/branches/branch-project-b' + suffix, member, body)).status).toBe(403);
    expect((await call('POST', url + '/unexpected', member, body)).status).toBe(403);
    await grant([]);
    expect((await call('POST', url, member, body)).status).toBe(403);
    expect((await call('POST', url, owner, body)).status).toBe(200);
  });

  it('hides resource connection credentials in cached lists and direct resource reads without mutating owner data', async () => {
    state.addInfraService({ id: 'redis', projectId: 'project-a', name: 'Redis', dockerImage: 'redis:7',
      containerPort: 6379, hostPort: 16379, containerName: 'test-redis', status: 'stopped',
      volumes: [], env: { REDIS_PASSWORD: 'fake-resource-env-secret' },
      command: ['env', 'API_TOKEN=fake-resource-command-env-secret', 'redis-server', '--requirepass', 'fake-resource-command-secret'], createdAt: new Date().toISOString() });
    state.upsertResourceExternalAccess({ projectId: 'project-a', branchId: 'branch-project-a',
      resourceId: 'infra:redis', enabled: true, kind: 'tcp', allowlist: [],
      connectionString: 'redis://:fake-resource-connection-secret@redis.example.test:16379/0' });
    await grant(['project-a']);
    for (const url of ['/api/branches', '/api/branches/branch-project-a/resources']) {
      // Warm the owner cache first; member projections must never mutate it.
      const ownerView = await call('GET', url);
      expect(JSON.stringify(ownerView.body)).toContain('fake-resource-connection-secret');
      const view = await call('GET', url, member);
      expect(view.status).toBe(200);
      const resources = view.body.resources || view.body.branches.find((b: any) => b.id === 'branch-project-a').resources;
      const redis = resources.find((r: any) => r.id === 'infra:redis');
      expect(redis.serviceName).toBe('Redis');
      expect(redis.connectionString).toBeUndefined();
      expect(redis.externalAccess.connectionString).toBeUndefined();
      for (const secret of ['fake-resource-connection-secret', 'fake-resource-env-secret', 'fake-resource-command-secret', 'fake-resource-command-env-secret']) {
        expect(JSON.stringify(view.body), url).not.toContain(secret);
      }
      expect(JSON.stringify((await call('GET', url)).body)).toContain('fake-resource-connection-secret');
    }
    expect(state.getResourceExternalAccessForBranch('project-a', 'branch-project-a')[0].connectionString)
      .toContain('fake-resource-connection-secret');
    expect(state.getInfraServiceForProjectAndId('project-a', 'redis')?.command)
      .toContain('fake-resource-command-secret');
  });

  it('denies raw container streams and owner-unmasked archives but preserves owner archive reads', async () => {
    state.appendContainerLogArchive('branch-project-a', { projectId: 'project-a', profileId: 'profile-project-a',
      source: 'container-logs-api', masked: false, logs: 'PASSWORD=fake-owner-archive-secret' });
    await grant(['project-a']);
    for (const url of [
      '/api/branches/branch-project-a/container-logs-stream/profile-project-a',
      '/api/branches/branch-project-a/container-logs-stream/profile-project-a?unmask=1',
      '/api/branches/branch-project-a/container-log-archives',
      '/api/branches/branch-project-a/container-log-archives?includeLogs=1',
    ]) {
      const view = await call('GET', url, member);
      expect(view.status, url).toBe(403);
      expect(JSON.stringify(view.body)).not.toContain('fake-owner-archive-secret');
    }
    const ownerView = await call('GET', '/api/branches/branch-project-a/container-log-archives?includeLogs=1');
    expect(ownerView.status).toBe(200);
    expect(ownerView.body.archives[0].logs).toContain('fake-owner-archive-secret');
    expect(state.getContainerLogArchives('branch-project-a')[0].masked).toBe(false);
  });

  it('masks derived branch creation success and flush-failure responses without changing stored or owner credentials', async () => {
    vi.spyOn(WorktreeService.prototype, 'create').mockResolvedValue();
    state.setBranchExtraProfiles('branch-project-a', [{ id: 'extra', name: 'extra', dockerImage: 'node:20',
      command: 'redis-server --requirepass fake-derived-command-secret', workDir: '.', containerPort: 3001,
      env: { API_TOKEN: 'fake-derived-env-secret' },
      deployModes: { alternate: { label: 'alternate', env: { PASSWORD: 'fake-derived-mode-secret' } } } }]);
    state.setBranchProfileOverride('branch-project-a', 'profile-project-a', {
      command: 'redis-server --requirepass fake-derived-override-secret', env: { TOKEN: 'fake-derived-override-env' },
    });
    await grant(['project-a']);
    const secrets = ['fake-derived-command-secret', 'fake-derived-env-secret', 'fake-derived-mode-secret',
      'fake-derived-override-secret', 'fake-derived-override-env'];
    const created = await call('POST', '/api/branches', member, {
      branch: 'member-derived', projectId: 'project-a', sourceBranchId: 'branch-project-a',
    });
    expect(created.status).toBe(201);
    for (const secret of secrets) expect(JSON.stringify(created.body)).not.toContain(secret);
    expect(state.getBranch(created.body.branch.id)?.extraProfiles?.[0].env?.API_TOKEN).toBe('fake-derived-env-secret');
    const ownerCreated = await call('POST', '/api/branches', owner, {
      branch: 'owner-derived', projectId: 'project-a', sourceBranchId: 'branch-project-a',
    });
    expect(ownerCreated.status).toBe(201);
    for (const secret of secrets) expect(JSON.stringify(ownerCreated.body)).toContain(secret);
    vi.spyOn(state, 'flush').mockRejectedValueOnce(new Error('fake state flush failure'));
    const failed = await call('POST', '/api/branches', member, {
      branch: 'member-derived-flush-error', projectId: 'project-a', sourceBranchId: 'branch-project-a',
    });
    expect(failed.status).toBe(500);
    expect(failed.body.error).toBe('state_flush_failed');
    for (const secret of secrets) expect(JSON.stringify(failed.body)).not.toContain(secret);
    expect(state.getBranch(failed.body.branch.id)?.profileOverrides?.['profile-project-a'].command)
      .toContain('fake-derived-override-secret');
  });

  it('masks member diagnostics, operation history and embedded service logs while retaining owner and stored output', async () => {
    const branch = state.getBranch('branch-project-a')!;
    branch.status = 'error';
    branch.services['profile-project-a'] = { profileId: 'profile-project-a', containerName: 'fake-container',
      hostPort: 13000, status: 'error', buildLog: 'TOKEN=fake-service-log-secret' };
    state.appendLog(branch.id, { type: 'build', startedAt: new Date().toISOString(), status: 'error',
      events: [{ step: 'build', status: 'error', log: 'API_TOKEN=fake-operation-secret',
        detail: { env: { API_TOKEN: 'fake-structured-log-secret' }, command: 'redis-server --requirepass fake-log-command-secret' },
        timestamp: new Date().toISOString() }] });
    state.appendActivityLog('project-a', { type: 'resource-data-query', branchId: branch.id,
      branchName: branch.branch, actor: 'owner', resourceId: 'app:profile-project-a', resourceName: 'App',
      result: 'success', note: 'API_TOKEN=fake-activity-secret' });
    await grant(['project-a']);
    for (const [url, secret] of [
      ['/api/branches/branch-project-a/failure-diagnosis', 'fake-diagnostic-secret'],
      ['/api/branches/branch-project-a/logs', 'fake-operation-secret'],
      ['/api/branches/branch-project-a', 'fake-service-log-secret'],
      ['/api/branches', 'fake-service-log-secret'],
      ['/api/branches/branch-project-a/resources', 'fake-service-log-secret'],
      ['/api/branches/branch-project-a/activity-logs', 'fake-activity-secret'],
      ['/api/branches/branch-project-a/resources/app%3Aprofile-project-a/audit', 'fake-activity-secret'],
    ]) {
      expect(JSON.stringify((await call('GET', url)).body), url).toContain(secret);
      const view = await call('GET', url, member);
      expect(view.status, url).toBe(200);
      expect(JSON.stringify(view.body), url).not.toContain(secret);
      expect(JSON.stringify((await call('GET', url)).body), url).toContain(secret);
    }
    expect(state.getLogs(branch.id)[0].events[0].log).toContain('fake-operation-secret');
    const memberLogs = JSON.stringify((await call('GET', '/api/branches/branch-project-a/logs', member)).body);
    expect(memberLogs).not.toContain('fake-structured-log-secret');
    expect(memberLogs).not.toContain('fake-log-command-secret');
    const ownerLogs = JSON.stringify((await call('GET', '/api/branches/branch-project-a/logs')).body);
    expect(ownerLogs).toContain('fake-structured-log-secret');
    expect(ownerLogs).toContain('fake-log-command-secret');
    expect(branch.services['profile-project-a'].buildLog).toContain('fake-service-log-secret');
  });

  it('projects runtime verification logs for members while preserving owner diagnostics and the log source', async () => {
    await grant(['project-a']);
    const sourceLog = ['runtime healthy', 'PASSWORD=fake-runtime-env-secret', 'API_TOKEN=fake-runtime-token-secret',
      'mongodb://runtime-user:fake-runtime-uri-secret@db.example.test/app', 'redis-server --requirepass fake-runtime-cli-secret'].join('\n');
    const branch = state.getBranch('branch-project-a')!;
    branch.services['profile-project-a'] = { profileId: 'profile-project-a', containerName: 'runtime-fixture', hostPort: 10001, status: 'running' };
    container.isRunning = async () => true;
    const readLogs = vi.spyOn(container, 'getLogs').mockResolvedValue(sourceLog);
    const url = '/api/branches/branch-project-a/verify-runtime/profile-project-a';
    expect((await call('POST', url, owner, {})).body.recentLogs).toBe(sourceLog);
    const view = await call('POST', url, member, {});
    expect(view.status).toBe(200);
    expect(view.body.container).toBe('runtime-fixture');
    expect(view.body.recentLogs).toContain('runtime healthy');
    expect(view.body.warnings.length).toBeGreaterThan(0);
    for (const secret of ['fake-runtime-env-secret', 'fake-runtime-token-secret', 'fake-runtime-uri-secret', 'fake-runtime-cli-secret']) {
      expect(JSON.stringify(view.body)).not.toContain(secret);
    }
    expect((await call('POST', url, owner, {})).body.recentLogs).toBe(sourceLog);
    expect(await readLogs()).toBe(sourceLog);
    expect((await call('POST', '/api/branches/branch-project-b/verify-runtime/profile-project-b', member, {})).status).toBe(403);
  });

  it.each([
    ['GET', '/resources/app%3Aprofile-project-a/logs', undefined],
    ['POST', '/container-logs', { profileId: 'profile-project-a' }],
  ] as const)('projects CLI credentials in member log snapshots through %s %s', async (method, suffix, body) => {
    await grant(['project-a']);
    const sourceLog = 'runtime healthy\nredis-server --requirepass fake-snapshot-cli-secret';
    state.getBranch('branch-project-a')!.services['profile-project-a'] = {
      profileId: 'profile-project-a', containerName: 'snapshot-fixture', hostPort: 10001, status: 'running',
    };
    container.isRunning = async () => true;
    vi.spyOn(container, 'getLogs').mockResolvedValue(sourceLog);
    const url = '/api/branches/branch-project-a' + suffix;
    expect((await call(method, url + '?unmask=1', owner, body)).body.logs).toBe(sourceLog);
    const view = await call(method, url, member, body);
    expect(view.status).toBe(200);
    expect(view.body.logs).toContain('runtime healthy');
    expect(view.body.logs).not.toContain('fake-snapshot-cli-secret');
    expect((await call(method, url + '?unmask=1', member, body)).status).toBe(403);
    expect((await call(method, url + '?unmask=1', owner, body)).body.logs).toBe(sourceLog);
    expect(await container.getLogs()).toBe(sourceLog);
  });

  it('projects complete executor frames for members without forwarding split raw credentials; owner keeps raw output', async () => {
    const remote = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: step\ndata: {"step":"build","status":"running","title":"safe progress","detail":{"env":{"PASSWORD":"fake-remote-map-secret"}}}\n\n');
        res.write('event: log\ndata: {"profileId":"profile-project-a","chunk":"API_TOKEN=fake-remote-');
        setImmediate(() => res.end('chunk-secret"}\n\nevent: complete\ndata: {"ok":true,"services":{}}\n\n'));
      });
    });
    remote.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => remote.once('listening', resolve));
    registry.register({ id: 'test-remote', host: '127.0.0.1', port: (remote.address() as { port: number }).port,
      role: 'remote', capacity: { maxBranches: 10, memoryMB: 8192, cpuCores: 4 } });
    await grant(['project-a']);
    try {
      for (const cookie of [member, owner]) {
        const res = await fetch(base + '/api/branches/branch-project-a/deploy', {
          method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetExecutorId: 'test-remote' }),
        });
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('safe progress');
        if (cookie === member) {
          expect(text).not.toContain('fake-remote-map-secret');
          expect(text).not.toContain('fake-remote-chunk-secret');
          expect(text).toContain('原始输出仅系统所有者可查看');
        } else {
          expect(text).toContain('fake-remote-map-secret');
          expect(text).toContain('fake-remote-chunk-secret');
        }
      }
    } finally {
      remote.closeAllConnections();
      await new Promise<void>(resolve => remote.close(() => resolve()));
    }
  });

  it('does not offer or accept unsupported shared-service grants or expose old grants', async () => {
    state.addProject({ id: 'shared', slug: 'shared', name: 'shared', kind: 'shared-service',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await grant(['project-a']);
    const available = await call('GET', `/api/auth/users/${memberId}/projects`);
    expect(available.body.projects.map((p: any) => p.id)).toEqual(['project-a', 'project-b']);
    expect((await grant(['project-b', 'shared'])).status).toBe(400);
    expect((await call('GET', '/api/projects', member)).body.projects.map((p: any) => p.id)).toEqual(['project-a']);
    state.addProjectGrant({ id: 'old-shared', principalId: humanPrincipalId(memberId), projectId: 'shared',
      origin: 'approved', grantedAt: new Date().toISOString(), grantedBy: 'owner' });
    expect((await call('GET', '/api/projects/shared', member)).status).toBe(403);
    expect((await call('GET', '/api/projects')).body.projects.some((p: any) => p.id === 'shared')).toBe(true);
  });

  it('validates the full set before mutation, deduplicates, persists and audits revocation', async () => {
    await grant(['project-a', 'project-a']);
    const before = state.getProjectGrants().length;
    expect((await grant(['project-b', 'missing'])).status).toBe(400);
    expect((await grant(['project-a'])).status).toBe(200);
    expect(state.getProjectGrants()).toHaveLength(before);
    fs.copyFileSync(path.join(dir, 'state.json'), path.join(dir, 'restored.json'));
    const restored = new StateService(path.join(dir, 'restored.json'));
    restored.load();
    expect(restored.getProjectGrants().some(g => g.principalId === humanPrincipalId(memberId) && !g.revokedAt)).toBe(true);
    expect((await grant([])).status).toBe(200);
    expect((await call('GET', '/api/branches/branch-project-a', member)).status).toBe(403);
    expect((await call('GET', '/api/projects', member)).body.projects).toEqual([]);
    const actions = await store.listActivity({ limit: 50 });
    expect(actions.filter(a => a.targetId === memberId).map(a => a.action)).toEqual(expect.arrayContaining(['grant-project', 'revoke-project']));
    expect(state.getProjectGrants().find(g => g.principalId === humanPrincipalId(memberId))?.revokedBy).toBe('owner');
  });

  it('restores failed additions, revocations and new principals before later snapshots can persist them', async () => {
    const principalId = humanPrincipalId(memberId);
    const actionsBefore = await store.listActivity({ limit: 100 });
    const flush = vi.spyOn(state, 'flush').mockRejectedValueOnce(new Error('fake grant persistence failure'));
    expect((await grant(['project-a'])).status).toBe(500);
    expect(state.getPrincipal(principalId)).toBeUndefined();
    expect(state.getProjectGrants().filter(g => g.principalId === principalId)).toEqual([]);
    expect((await call('GET', '/api/projects', member)).body.projects).toEqual([]);
    expect((await store.listActivity({ limit: 100 })).length).toBe(actionsBefore.length);
    await state.flush();
    fs.copyFileSync(path.join(dir, 'state.json'), path.join(dir, 'failed-addition-restored.json'));
    const reload = new StateService(path.join(dir, 'failed-addition-restored.json'));
    reload.load();
    expect(reload.getProjectGrants().filter(g => g.principalId === principalId)).toEqual([]);
    expect((await grant(['project-a'])).status).toBe(200);
    const before = JSON.stringify(state.getProjectGrants().filter(g => g.principalId === principalId));
    flush.mockRejectedValueOnce(new Error('fake revocation persistence failure'));
    expect((await grant([])).status).toBe(500);
    expect(JSON.stringify(state.getProjectGrants().filter(g => g.principalId === principalId))).toBe(before);
    expect((await call('GET', '/api/projects', member)).body.projects.map((p: any) => p.id)).toEqual(['project-a']);
    expect((await store.listActivity({ limit: 100 })).filter(a => a.action === 'revoke-project')).toEqual([]);
    await state.flush();
    fs.copyFileSync(path.join(dir, 'state.json'), path.join(dir, 'failed-revocation-restored.json'));
    const restored = new StateService(path.join(dir, 'failed-revocation-restored.json'));
    restored.load();
    expect(JSON.stringify(restored.getProjectGrants().filter(g => g.principalId === principalId))).toBe(before);
    flush.mockRejectedValueOnce(new Error('fake sustained failure')).mockRejectedValueOnce(new Error('fake compensation failure'));
    const uncertain = await grant(['project-b']);
    expect(uncertain.status).toBe(500);
    expect(uncertain.body.error).toContain('持久化状态无法确认');
    expect(JSON.stringify(state.getProjectGrants().filter(g => g.principalId === principalId))).toBe(before);
    expect(humanProjectGrantUpdateStatus(state, principalId)?.reconciling).toBe(true);
    await vi.waitFor(() => expect(humanProjectGrantUpdateStatus(state, principalId)).toBeUndefined(), { timeout: 500 });
    expect((await grant(['project-b'])).status).toBe(200);
  });

  it('blocks pending grants and conflicting replacements while failure compensation preserves independent writes', async () => {
    let rejectFlush!: (error: Error) => void;
    let started!: () => void;
    const pending = new Promise<void>((_, reject) => { rejectFlush = reject; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    vi.spyOn(state, 'flush').mockImplementationOnce(() => { started(); return pending; });
    const saving = grant(['project-a']);
    await entered;
    expect((await call('GET', '/api/branches/branch-project-a', member)).status).toBe(409);
    expect((await call('GET', `/api/auth/users/${memberId}/projects`)).status).toBe(409);
    expect((await grant(['project-b'])).status).toBe(409);
    // Independent identity operations must not be overwritten by rollback.
    state.addProjectGrant({ id: 'independent', principalId: humanPrincipalId(memberId), projectId: 'project-b',
      origin: 'approved', grantedAt: new Date().toISOString(), grantedBy: 'other-owner' });
    rejectFlush(new Error('fake pending persistence failure'));
    expect((await saving).status).toBe(500);
    expect(state.getProjectGrants().filter(g => g.principalId === humanPrincipalId(memberId)).map(g => g.id)).toEqual(['independent']);
    expect(state.getPrincipal(humanPrincipalId(memberId))).toBeDefined();
    expect((await call('GET', '/api/projects', member)).body.projects.map((p: any) => p.id)).toEqual(['project-b']);
  });

  it('rejects competing identity grant mutations until replacement compensation finishes', async () => {
    await grant(['project-a']);
    const principalId = humanPrincipalId(memberId);
    const original = state.getProjectGrants().find(g => g.principalId === principalId)!;
    let rejectFlush!: (error: Error) => void;
    let started!: () => void;
    const pending = new Promise<void>((_, reject) => { rejectFlush = reject; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    vi.spyOn(state, 'flush').mockImplementationOnce(() => { started(); return pending; });
    const saving = grant([]);
    await entered;
    const revocation = await call('POST', `/api/identity/grants/${original.id}/revoke`, owner, {});
    const addition = await call('POST', '/api/identity/grants', owner, { principalId, projectId: 'project-b' });
    rejectFlush(new Error('fake replacement persistence failure'));
    expect((await saving).status).toBe(500);
    expect(revocation.status).toBe(409);
    expect(addition.status).toBe(409);
    expect(original.revokedAt).toBeUndefined();
    expect((await call('POST', `/api/identity/grants/${original.id}/revoke`, owner, {})).status).toBe(200);
    expect((await call('GET', '/api/projects', member)).body.projects).toEqual([]);
  });

  it.each(['success', 'failure'] as const)('gates bound credentials during a slow grant replacement ending in %s', async (outcome) => {
    await grant(['project-a']);
    state.setCustomEnv({ API_TOKEN: 'test-transient-project-secret' }, 'project-b');
    const principalId = humanPrincipalId(memberId);
    const userKey = (await call('POST', '/api/identity/user-credentials', owner, { principalId })).body.plaintext;
    const issue = (key: string, projectId: string) => credentialCall('POST', '/api/identity/project-credentials', key, { projectId });
    const existing = await issue(userKey, 'project-a');
    expect(existing.status).toBe(201);
    const existingKey = existing.body.plaintext;
    expect((await credentialCall('GET', '/api/build-profiles?project=project-a', existingKey)).status).toBe(200);
    const other = await call('POST', '/api/identity/user-credentials', owner, { name: 'unrelated machine' });
    await call('POST', '/api/identity/grants', owner, { principalId: other.body.principal.id, projectId: 'project-b' });
    const unrelated = await issue(other.body.plaintext, 'project-b');
    expect(unrelated.status).toBe(201);
    let finish!: () => void;
    let reject!: (error: Error) => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve, fail) => { finish = resolve; reject = fail; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(state, 'flush').mockImplementationOnce(() => { entered(); return pending; });
    const saving = grant(['project-a', 'project-b']);
    await started;
    let result!: Awaited<ReturnType<typeof grant>>;
    try {
      const transient = await issue(userKey, 'project-b');
      const secretRead = transient.status === 201
        ? await credentialCall('GET', '/api/env?scope=project-b', transient.body.plaintext) : undefined;
      expect({ issue: transient.status, secretRead: !!secretRead && JSON.stringify(secretRead.body).includes('test-transient-project-secret') })
        .toEqual({ issue: 401, secretRead: false });
      expect((await credentialCall('GET', '/api/projects', userKey)).status).toBe(401);
      expect((await credentialCall('GET', '/api/build-profiles?project=project-a', existingKey)).status).toBe(401);
      // A different principal and the owner must still work during recovery.
      expect((await credentialCall('GET', '/api/projects', other.body.plaintext)).status).toBe(200);
      expect((await credentialCall('GET', '/api/build-profiles?project=project-b', unrelated.body.plaintext)).status).toBe(200);
      expect((await call('GET', '/api/config')).status).toBe(200);
    } finally {
      if (outcome === 'success') finish(); else reject(new Error('fake slow grant write failure'));
      result = await saving;
    }
    expect(result.status).toBe(outcome === 'success' ? 200 : 500);
    expect(humanProjectGrantUpdateStatus(state, principalId)).toBeUndefined();
    expect((await credentialCall('GET', '/api/projects', userKey)).status).toBe(200);
    expect((await credentialCall('GET', '/api/build-profiles?project=project-a', existingKey)).status).toBe(200);
    const settled = await issue(userKey, 'project-b');
    expect(settled.status).toBe(outcome === 'success' ? 201 : 403);
    if (outcome === 'success') {
      expect((await credentialCall('GET', '/api/build-profiles?project=project-b', settled.body.plaintext)).status).toBe(200);
    }
  });

  it('rechecks the grant gate before issuance even for a previously resolved credential context', async () => {
    await grant(['project-a']);
    const principalId = humanPrincipalId(memberId);
    const userKey = (await call('POST', '/api/identity/user-credentials', owner, { principalId })).body.plaintext;
    const context = resolveUserCredential(state, userKey);
    expect(context).not.toBeNull();
    const release = beginHumanProjectGrantUpdate(state, principalId)!;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as unknown as { cdsPrincipal: typeof context }).cdsPrincipal = context; next(); });
    app.use('/api', createIdentityRouter({ stateService: state }));
    const captured = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => captured.once('listening', resolve));
    const issue = () => fetch(`http://127.0.0.1:${(captured.address() as { port: number }).port}/api/identity/project-credentials`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: 'project-a' }),
    });
    try {
      const pending = await issue();
      expect(pending.status).toBe(409);
      expect(await pending.json()).not.toHaveProperty('plaintext');
      release();
      expect((await issue()).status).toBe(201);
    } finally {
      release();
      captured.closeAllConnections();
      await new Promise<void>(resolve => captured.close(() => resolve()));
    }
  });

  it('rejects member self-grants and preserves owner/disabled-user invariants', async () => {
    expect((await call('PUT', `/api/auth/users/${memberId}/projects`, member, { projectIds: ['project-a'] })).status).toBe(403);
    expect((await call('GET', '/api/auth/users/not-a-user/projects')).status).toBe(404);
    const elevated = await call('POST', '/api/auth/users', owner, { username: 'other-owner', password: 'owner-password', isSystemOwner: true });
    expect((await call('PUT', `/api/auth/users/${elevated.body.user.id}/projects`, owner, { projectIds: [] })).status).toBe(400);
    await grant(['project-a']);
    await call('PATCH', `/api/auth/users/${memberId}`, owner, { status: 'disabled' });
    expect((await call('GET', '/api/projects', member)).status).toBe(401);
  });

  it('filters stream snapshot and live events, rechecking grants after subscription', async () => {
    await grant(['project-a']);
    const abort = new AbortController();
    const res = await fetch(base + '/api/branches/stream', { headers: { Cookie: member }, signal: abort.signal });
    const reader = res.body!.getReader();
    try {
      const decoder = new TextDecoder();
      const first = decoder.decode((await reader.read()).value);
      expect(first).toContain('branch-project-a');
      expect(first).not.toContain('branch-project-b');
      branchEvents.emit('any', { type: 'branch.status', payload: { branchId: 'branch-project-b', projectId: 'project-b', status: 'building', ts: 'hidden' } });
      branchEvents.emit('any', { type: 'branch.status', payload: { branchId: 'branch-project-a', projectId: 'project-a', status: 'building', ts: 'allowed' } });
      const event = decoder.decode((await reader.read()).value);
      expect(event).toContain('allowed');
      expect(event).not.toContain('hidden');
      branchEvents.emit('any', { type: 'branch.deploy-step', payload: {
        branchId: 'branch-project-a', projectId: 'project-a', log: 'API_TOKEN=fake-live-log-secret', ts: 'live-step',
      } });
      const live = decoder.decode((await reader.read()).value);
      expect(live).toContain('live-step');
      expect(live).not.toContain('fake-live-log-secret');
      await grant([]);
      branchEvents.emit('any', { type: 'branch.status', payload: { branchId: 'branch-project-a', projectId: 'project-a', status: 'idle', ts: 'revoked' } });
      // An owner-independent marker establishes that no revoked event was queued.
      await grant(['project-b']);
      branchEvents.emit('any', { type: 'branch.status', payload: { branchId: 'branch-project-b', projectId: 'project-b', status: 'idle', ts: 'new-grant' } });
      const after = decoder.decode((await reader.read()).value);
      expect(after).toContain('new-grant');
      expect(after).not.toContain('revoked');
    } finally { abort.abort(); await reader.cancel().catch(() => {}); }
  });
});
