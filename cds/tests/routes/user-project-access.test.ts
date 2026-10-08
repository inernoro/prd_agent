import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from '../../src/server.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { MemoryAuthStore } from '../../src/infra/auth-store/memory-store.js';
import { humanPrincipalId } from '../../src/services/human-project-access.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import { branchEvents } from '../../src/services/branch-events.js';
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

  async function call(method: string, url: string, cookie = owner, body?: unknown) {
    const res = await fetch(base + url, {
      method, headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] || '' };
  }
  const grant = (ids: string[]) => call('PUT', `/api/auth/users/${memberId}/projects`, owner, { projectIds: ids });

  beforeEach(async () => {
    vi.stubEnv('CDS_AUTH_MODE', 'basic');
    vi.stubEnv('CDS_USERNAME', 'owner');
    vi.stubEnv('CDS_PASSWORD', 'test-owner-password');
    vi.stubEnv('CDS_PUBLIC_BASE_URL', 'http://localhost');
    vi.stubEnv('CDS_SSO_ENABLED', 'false');
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
    const shell = new MockShellExecutor();
    const config: CdsConfig = { repoRoot: dir, worktreeBase: path.join(dir, 'worktrees'),
      masterPort: 9900, workerPort: 5500, dockerNetwork: 'cds', portStart: 10001,
      sharedEnv: {}, jwt: { secret: 'test', issuer: 'test' }, rootDomains: ['example.test'] };
    const app = createServer({ stateService: state, worktreeService: new WorktreeService(shell, dir),
      shell, config, authStore: store, bridgeService: {} as any,
      containerService: { getRunningContainerNames: async () => new Set(), getTotalMemoryGB: async () => 8 } as any,
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
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await flushAllJsonStateStores();
    fs.rmSync(dir, { recursive: true, force: true });
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

  it('blocks cross-project reads, writes, query overrides, derivation and system/credential escalation', async () => {
    await grant(['project-a']);
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
      ['DELETE', '/api/projects/project-a', {}],
    ] as const) {
      expect((await call(method, url, member, body)).status, `${method} ${url}`).toBe(403);
    }
    expect((await call('PATCH', '/api/branches/branch-project-a', member, { notes: 'guest edited' })).status).toBe(200);
    expect(state.getBranch('branch-project-a')?.notes).toBe('guest edited');
    const profiles = await call('GET', '/api/branches/branch-project-a/profile-overrides', member);
    expect(profiles.status).toBe(200);
    expect(JSON.stringify(profiles.body)).not.toContain('test-project-secret');
    expect(JSON.stringify(profiles.body)).not.toContain('test-mode-secret');
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
