import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAuthStore } from '../../src/infra/auth-store/memory-store.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import { createServer } from '../../src/server.js';
import { EngineeringPlanningService, FileEngineeringPlanningStore } from '../../src/services/engineering-planning.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import type { CdsConfig } from '../../src/types.js';
import { listenLoopbackFixture } from '../helpers/loopback-http-fixture.js';

const projectA = 'fixture-preview-approver-a';
const projectB = 'fixture-preview-approver-b';
const previewScope = '/api/auth/preview';
const settings = (project: string) => `${previewScope}/approvers/${project}`;
const accountProjects = (account: string) => `/api/auth/users/${account}/projects`;
const previewPath = '/members/?fixture=private-preview#role';
const parentUrl = 'http://localhost';
const previewDomain = 'preview.fixture.test';
const branch = (project: string) => `branch-${project}`;
const client = (project: string) => `client-${project}`;
const denied = [401, 403, 404];

type Member = { id: string; cookie: string; displayName: string };

describe('preview project approvers through the CDS server', () => {
  let dir: string;
  let app: ReturnType<typeof createServer>;
  let server: Server;
  let state: StateService;
  let base: string;
  let owner: string;
  let logs: { http: unknown[]; active: unknown[]; events: unknown[] };

  async function call(method: string, uri: string, auth: string | Record<string, string> = owner, body?: unknown) {
    const response = await fetch(base + uri, {
      method, redirect: 'manual',
      headers: { 'Content-Type': 'application/json', ...(typeof auth === 'string' ? { Cookie: auth } : auth) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const raw = await response.text();
    return {
      status: response.status, raw, body: response.headers.get('Content-Type')?.includes('application/json') ? JSON.parse(raw) : null,
      cookie: response.headers.get('set-cookie')?.split(';')[0] || '',
      requestId: response.headers.get('x-cds-request-id'),
    };
  }

  async function member(username: string, grants: string[]): Promise<Member> {
    const password = `isolated-fixture-pass-${username}`;
    const displayName = `Fixture ${username}`;
    const created = await call('POST', '/api/auth/users', owner, { username, password, name: displayName });
    expect(created.status).toBe(201);
    const user = created.body.user;
    expect((await call('PUT', accountProjects(user.id), owner, { projectIds: grants })).status).toBe(200);
    const entered = await call('POST', '/api/auth/login', '', { username, password });
    expect(entered.status).toBe(200);
    return { id: user.id, cookie: entered.cookie, displayName: user.name || username };
  }

  async function apply(project: string, member: Member) {
    const request = await call('POST', `${previewScope}/access`, member.cookie, { client: client(project), path: previewPath });
    expect(request.status).toBe(201);
    return request.body.id as string;
  }

  beforeEach(async () => {
    vi.stubEnv('CDS_AUTH_MODE', 'basic');
    vi.stubEnv('CDS_USERNAME', 'fixture-preview-owner');
    vi.stubEnv('CDS_PASSWORD', 'isolated-preview-owner-password');
    vi.stubEnv('CDS_PUBLIC_BASE_URL', parentUrl);
    vi.stubEnv('CDS_AI_ACCESS_KEY', '');
    vi.stubEnv('AI_ACCESS_KEY', '');
    vi.stubEnv('CDS_SSO_ENABLED', 'false');
    vi.stubEnv('CDS_PREVIEW_INSTANCE', '0');
    vi.stubEnv('CDS_STORAGE_MODE', 'json');
    vi.stubEnv('CDS_MONGO_URI', '');
    dir = await mkdtemp(path.join(os.tmpdir(), 'cds-preview-approver-http-'));
    const stateFile = path.join(dir, 'state.json');
    state = new StateService(stateFile, dir);
    state.load();
    const now = new Date().toISOString();
    const commit = 'a'.repeat(40);
    const repo = (project: string) => `fixture-org/${project}`;
    const store = new FileEngineeringPlanningStore(path.join(dir, 'engineering-planning'));
    const planning = new EngineeringPlanningService(store, undefined, { repositoryFor: repo });
    for (const project of [projectA, projectB]) {
      const profile = `profile-${project}`;
      state.addProject({ id: project, slug: project, name: project, dockerNetwork: project, repoPath: dir,
        githubRepoFullName: repo(project), gitDefaultBranch: 'main', kind: 'git', legacyFlag: false, createdAt: now, updatedAt: now });
      state.addBuildProfile({ id: profile, name: profile, projectId: project, dockerImage: 'node:20',
        command: '', workDir: '.', containerPort: 3000, pathPrefixes: ['/'], webEntry: { name: 'Members', path: '/members/' } });
      state.addBranch({ id: branch(project), projectId: project, branch: 'review-preview', status: 'running',
        githubPrNumber: 7, worktreePath: dir, createdAt: now, lastReadyAt: now,
        services: { [profile]: { profileId: profile, containerName: 'fixture-runtime', hostPort: 18300, status: 'running', sourceCommitSha: commit } } });
      await planning.recordGithubObservation(project, { type: 'pull_request', pullRequest: {
        number: 7, repository: repo(project), url: `https://github.com/${repo(project)}/pull/7`, title: 'Fixture review', author: 'fixture',
        openedAt: now, updatedAt: now, state: 'open', headSha: commit, headBranch: 'review-preview', headRepository: repo(project),
        decisionRefs: [], debtRefs: [], observation: { action: 'opened', deliveryId: `fixture-${project}` }, checks: {},
      } });
    }
    const shell = new MockShellExecutor();
    logs = { http: [], active: [], events: [] };
    const config: CdsConfig = { repoRoot: dir, worktreeBase: dir, masterPort: 9900, workerPort: 5500, dockerNetwork: 'fixture',
      portStart: 10001, sharedEnv: {}, rootDomains: [previewDomain], previewDomain, jwt: { secret: 'fixture', issuer: 'fixture' } };
    app = createServer({ stateService: state, stateFile, shell, config, engineeringPlanningStore: store,
      authStore: new MemoryAuthStore(), worktreeService: new WorktreeService(shell, dir),
      httpLogStore: { record: entry => logs.http.push(entry), beginActive: entry => { logs.active.push(entry); return entry.requestId; } },
      serverEventLogStore: { record: event => logs.events.push(event) },
      containerService: { getRunningContainerNames: async () => new Set(), getTotalMemoryGB: async () => 8 } as never,
      bridgeService: {} as never,
      proxyService: { getProxyLog: () => [], setOnProxyLog: () => {}, handleSwitchFromExpress: () => {} } as never });
    server = listenLoopbackFixture(app);
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const entered = await call('POST', '/api/auth/login', '', { username: 'fixture-preview-owner', password: 'isolated-preview-owner-password' });
    expect(entered.status).toBe(200);
    owner = entered.cookie;
    for (const project of [projectA, projectB]) {
      const resolved = await call('GET', `/api/projects/${project}/planning/preview/7`);
      expect(resolved.status).toBe(200);
      expect(resolved.body.state).toBe('native-login');
      state.setCustomEnv({ CDS_PREVIEW_SSO_ENABLED: '1', CDS_PREVIEW_SSO_PROVIDER_ID: 'cds-preview', CDS_PREVIEW_SSO_CLIENT_ID: client(project),
        CDS_PREVIEW_SSO_CLIENT_SECRET: 'synthetic-preview-secret-'.padEnd(48, 'a'), CDS_PREVIEW_PUBLIC_BASE_URL: new URL(resolved.body.url).origin,
        CDS_PREVIEW_SSO_AUTHORIZATION_URL: parentUrl + '/preview/authorize', CDS_PREVIEW_SSO_TOKEN_URL: parentUrl + `${previewScope}/token`,
      }, branch(project));
    }
  });

  afterEach(async () => {
    app?.emit('close');
    server?.closeAllConnections();
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await flushAllJsonStateStores();
    if (dir) await rm(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('lets only the system owner set or clear an active member as project approver', async () => {
    const delegate = await member('delegate-settings', [projectA]);
    const stranger = await member('unrelated-settings', [projectB]);
    const agentKey = await call('POST', `/api/projects/${projectA}/agent-keys`, owner, { label: 'fixture only' });
    expect(agentKey.status).toBe(201);
    const agent = { 'x-ai-access-key': agentKey.body.plaintext as string };
    expect((await call('GET', '/api/projects', agent)).body.projects.map((project: { id: string }) => project.id)).toEqual([projectA]);
    for (const identity of [delegate.cookie, stranger.cookie, agent, '']) {
      expect(denied).toContain((await call('GET', settings(projectA), identity)).status);
      expect(denied).toContain((await call('PUT', settings(projectA), identity, { userId: delegate.id })).status);
    }

    const set = await call('PUT', settings(projectA), owner, { userId: delegate.id });
    expect(set.status).toBe(200);
    expect((await call('GET', settings(projectA))).body.userId).toBe(delegate.id);
    const rejected = await call('PUT', settings(projectA), owner, { userId: stranger.id });
    expect([400, 404, 409, 422]).toContain(rejected.status);
    expect((await call('GET', settings(projectA))).body.userId).toBe(delegate.id);

    const row = await apply(projectA, stranger);
    const status = await call('GET', `${previewScope}/access?request=${row}`, stranger.cookie);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ approver: delegate.displayName, state: 'requested' });
    expect(status.body.startUrl).toBeUndefined();
    expect((await call('PUT', settings(projectA), owner, { userId: null })).status).toBe(200);
    expect((await call('GET', settings(projectA))).body.userId).toBeNull();
  });

  it('scopes the approval queue while rejecting unrelated grants, revoked roles, and retired previews', async () => {
    const delegate = await member('delegate-requests', [projectA, projectB]);
    const outsider = await member('outsider-requests', [projectA]);
    const applicantA = await member('applicant-a', [projectB]);
    const applicantB = await member('applicant-b', []);
    const configured = await call('PUT', settings(projectA), owner, { userId: delegate.id });
    const a = await apply(projectA, applicantA);
    const b = await apply(projectB, applicantB);
    const list = await call('GET', `${previewScope}/requests`, delegate.cookie);
    expect.soft(configured.status).toBe(200);
    expect(list.status).toBe(200);
    expect(list.body.requests.map((request: { id: string }) => request.id)).toEqual([a]);
    expect(list.raw).not.toContain(b);
    expect(decodeURIComponent(list.raw)).not.toContain(previewPath);
    expect(list.body.requests[0]).not.toHaveProperty('returnPath');
    expect((await call('GET', `${previewScope}/notices`, delegate.cookie)).body).toEqual({ pending: 1, approved: [] });
    const outsiderList = await call('GET', `${previewScope}/requests`, outsider.cookie);
    expect([200, ...denied]).toContain(outsiderList.status);
    expect(outsiderList.raw).not.toContain(a);
    expect((await call('GET', `${previewScope}/access?request=${a}`, delegate.cookie)).status).toBe(404);
    expect(denied).toContain((await call('GET', accountProjects(applicantA.id), delegate.cookie)).status);
    expect(denied).toContain((await call('PUT', accountProjects(applicantA.id), delegate.cookie, { projectIds: [] })).status);

    const approve = (project: string, subject: Member, request?: string, actor = delegate.cookie) => call('POST',
      `${accountProjects(subject.id)}/${project}`, actor, request ? { previewRequestId: request } : {});
    for (const deniedGrant of [
      () => approve(projectA, applicantA),
      () => approve(projectA, applicantA, b),
      () => approve(projectA, applicantB, a),
      () => approve(projectB, applicantB, b),
      () => approve(projectA, applicantA, a, outsider.cookie),
    ]) expect(denied).toContain((await deniedGrant()).status);

    state.removeCustomEnvVar('CDS_PREVIEW_SSO_CLIENT_ID', branch(projectA));
    expect(denied).toContain((await approve(projectA, applicantA, a)).status);
    const noPreviewNotice = await call('GET', `${previewScope}/notices`, delegate.cookie);
    expect(noPreviewNotice.body.pending).toBe(0);
    const retiredQueue = await call('GET', `${previewScope}/requests`, delegate.cookie);
    expect(retiredQueue.status).toBe(200);
    expect(retiredQueue.body.requests).toEqual([]);
    expect((await call('GET', `${previewScope}/access?request=${a}`, applicantA.cookie)).status).toBe(404);
    state.setCustomEnvVar('CDS_PREVIEW_SSO_CLIENT_ID', client(projectA), branch(projectA));
    expect((await call('GET', `${previewScope}/requests`, delegate.cookie)).body.requests.map((row: { id: string }) => row.id)).toEqual([a]);
    await call('PUT', accountProjects(delegate.id), owner, { projectIds: [projectB] });
    expect(denied).toContain((await approve(projectA, applicantA, a)).status);
    expect((await call('GET', `${previewScope}/notices`, delegate.cookie)).body.pending).toBe(0);
    await call('PUT', accountProjects(delegate.id), owner, { projectIds: [projectA, projectB] });

    const approved = await approve(projectA, applicantA, a);
    expect(approved.status).toBe(200);
    expect(approved.raw).not.toContain(projectB);
    const grants = await call('GET', accountProjects(applicantA.id));
    expect(grants.body.projects.filter((row: { authorized: boolean }) => row.authorized).map((row: { id: string }) => row.id).sort())
      .toEqual([projectA, projectB]);
    const privateReturn = await call('GET', `${previewScope}/access?request=${a}`, applicantA.cookie);
    expect(privateReturn.status).toBe(200);
    expect(new URL(privateReturn.body.startUrl).searchParams.get('redirect')).toBe(previewPath);
    expect((await call('GET', `${previewScope}/notices`, applicantA.cookie)).body).toMatchObject({ approved: [{ id: a, project: projectA }] });
  });

  it('requires site JSON writes and suppresses preview details when authentication or the route denies the request', async () => {
    const delegate = await member('delegate-browser', [projectA]);
    const applicant = await member('applicant-browser', []);
    const sameSite = { 'Sec-Fetch-Site': 'same-site' };
    const crossSite = { 'Sec-Fetch-Site': 'cross-site' };
    const nonJson = { ...sameSite, 'Content-Type': 'text/plain' };
    for (const headers of [crossSite, nonJson]) {
      expect((await call('PUT', settings(projectA), { Cookie: owner, ...headers }, { userId: delegate.id })).status).toBe(403);
      expect((await call('POST', `${previewScope}/access`, { Cookie: applicant.cookie, ...headers }, { client: client(projectA) })).status).toBe(403);
    }
    expect((await call('GET', settings(projectA))).body.userId).toBeNull();
    expect((await call('PUT', settings(projectA), { Cookie: owner, ...sameSite }, { userId: delegate.id })).status).toBe(200);
    const submitted = await call('POST', `${previewScope}/access`, { Cookie: applicant.cookie, ...sameSite }, { client: client(projectA), path: previewPath });
    expect(submitted.status).toBe(201);
    const approve = `${accountProjects(applicant.id)}/${projectA}`;
    for (const headers of [crossSite, nonJson]) {
      expect((await call('POST', approve, { Cookie: delegate.cookie, ...headers }, { previewRequestId: submitted.body.id })).status).toBe(403);
    }
    expect((await call('GET', `${previewScope}/notices`, delegate.cookie)).body.pending).toBe(1);

    const logsStart = { http: logs.http.length, active: logs.active.length, events: logs.events.length };
    const ignored = 'fixture-preview-private-canary';
    const sourceIp = '192.0.2.82';
    const marked = { 'X-CDS-Request-Id': ignored, 'CF-Connecting-IP': sourceIp, Referer: `https://fixture.test/${ignored}`,
      'User-Agent': ignored, 'X-Fixture-Private': ignored };
    const warnings: unknown[][] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args) => { warnings.push(args); });
    try {
      const anonymous = await call('GET', `/_cds${previewScope}/access?request=${ignored}`, marked);
      const wrongSite = await call('POST', `${approve}?fixture=${ignored}`, { Cookie: delegate.cookie, ...marked, ...crossSite },
        { previewRequestId: submitted.body.id, note: ignored });
      expect(anonymous.status).toBe(401);
      expect(wrongSite.status).toBe(403);
      expect(anonymous.requestId).toBeTruthy();
      expect(wrongSite.requestId).toBeTruthy();
      expect(anonymous.requestId).not.toBe(ignored);
      expect(wrongSite.requestId).not.toBe(ignored);

      const requestPaths = ['/api/auth/preview/access', '/api/auth/users/:id/projects/:projectId'];
      const http = logs.http.slice(logsStart.http);
      const active = logs.active.slice(logsStart.active);
      const events = logs.events.slice(logsStart.events);
      expect(http).toEqual(expect.arrayContaining([expect.objectContaining({ path: requestPaths[0], status: 401 }),
        expect.objectContaining({ path: requestPaths[1], status: 403 })]));
      for (const path of requestPaths) {
        expect(active).toEqual(expect.arrayContaining([expect.objectContaining({ path })]));
        expect(warnings).toContainEqual([expect.stringContaining('before activity middleware'), expect.objectContaining({ path })]);
      }
      const stored = JSON.stringify({ http, active, events, warnings });
      for (const privateValue of [ignored, sourceIp, submitted.body.id, applicant.id, projectA]) {
        expect(stored.includes(privateValue)).toBe(false);
      }
    } finally {
      warn.mockRestore();
    }
    expect((await call('POST', approve, { Cookie: delegate.cookie, ...sameSite }, { previewRequestId: submitted.body.id })).status).toBe(200);
  });

  it.each([
    { caseName: 'malformed', expectedStatus: 400, body: '{"code":qa_probe}' },
    { caseName: 'oversized', expectedStatus: 413, body: JSON.stringify({ code: 'qa_probe'.padEnd(110_000, 'a') }) },
  ])('keeps $caseName preview JSON private when the global parser rejects it before authentication', async ({ expectedStatus, body }) => {
    app.set('env', 'production');
    const canary = 'qa_probe';
    const failures: unknown[][] = [];
    const error = vi.spyOn(console, 'error').mockImplementation((...args) => { failures.push(args); });
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args) => { failures.push(args); });
    try {
      const response = await fetch(base + `/_cds${previewScope}/token?probe=${canary}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Referer: `https://fixture.test/${canary}` },
        body,
      });
      const raw = await response.text();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(response.status).toBe(expectedStatus);
      expect.soft(JSON.stringify({ failures, logs }).includes(canary)).toBe(false);
      expect.soft(raw.includes(canary)).toBe(false);
      expect(response.headers.get('Content-Type')).toContain('application/json');
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
