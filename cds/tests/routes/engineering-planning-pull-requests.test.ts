import { createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { CdsConfig, IShellExecutor } from '../../src/types.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import { createGithubWebhookRouter } from '../../src/routes/github-webhook.js';
import { EngineeringPlanningService, FileEngineeringPlanningStore } from '../../src/services/engineering-planning.js';
import { createPlanningFileAnchorProbe } from '../../src/services/engineering-planning-file-anchors.js';
import { createPlanningGithubObserver, createPlanningPreviewResolver } from '../../src/services/engineering-planning-pull-requests.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import type { PlanningActor } from '../../src/shared/engineering-planning.js';
import { planningPreviewTargetUrl } from '../../src/shared/engineering-planning-links.js';
import { getHttpFixtureTrace, listenLoopbackFixture } from '../helpers/loopback-http-fixture.js';

const secret = 'planning-webhook-fixture';
const repository = 'octocat/planning-example';
const prUrl = `https://github.com/${repository}/pull/2412`;
const head = 'a'.repeat(40);
const otherHead = 'b'.repeat(40);
const projectId = 'planning-example';
const link = { type: 'adr', title: '报表主题决策', url: `https://github.com/${repository}/blob/main/docs/adr/0007-reports.md` };
const targetPath = '/console/reports?theme=dark#charts';
const owner: PlanningActor = { kind: 'human', id: 'planning-owner', label: '负责人', permissions: ['read', 'write', 'approve', 'propose'] };
const source = { type: 'manual', ref: 'page-change' };
const shell: IShellExecutor = { async exec() { return { stdout: '', stderr: '', exitCode: 0 }; } };
const runProcess = promisify(execFile);

describe('engineering planning PR projection', () => {
  let directory: string;
  let server: Server;
  let state: StateService;
  let planning: EngineeringPlanningService;
  let now: Date;
  let delivery: number;
  let endpoint: string;

  const reopenPlanning = () => new EngineeringPlanningService(new FileEngineeringPlanningStore(path.join(directory, 'planning')), () => now, {
    repositoryFor: id => state.getProject(id)?.githubRepoFullName,
    previewFor: createPlanningPreviewResolver(state, { previewDomain: 'preview.example.test' }),
    defaultBranchFor: id => state.getDefaultBranchFor(id),
    fileAnchorProbe: createPlanningFileAnchorProbe(id => state.getProjectRepoRoot(id, directory)),
  });

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'cds-planning-github-'));
    state = new StateService(path.join(directory, 'state.json'), directory);
    state.load();
    now = new Date('2026-11-20T10:00:00Z');
    delivery = 0;
    for (const [id, repo] of [[projectId, repository], ['unrelated-project', 'octocat/unrelated'], ['blocked-project', 'blocked/repo']]) {
      state.addProject({ id, slug: id, name: id, kind: 'git', githubRepoFullName: repo, githubInstallationId: 42,
        defaultBranch: 'main', githubEventPolicy: { prOpen: false, prClose: false }, createdAt: now.toISOString(), updatedAt: now.toISOString() });
    }
    state.setGithubAppWhitelistOwners(['octocat']);
    state.addBuildProfile({ id: 'web', projectId, name: 'Web', dockerImage: 'fixture-image', workDir: '.', containerPort: 8080,
      pathPrefixes: ['/'], webEntry: { name: '主应用入口', path: '/' } });
    planning = reopenPlanning();
    const config: CdsConfig = {
      repoRoot: directory, worktreeBase: directory, masterPort: 9900, workerPort: 5500, dockerNetwork: 'cds',
      portStart: 10001, sharedEnv: {}, jwt: { secret, issuer: 'cds' }, mode: 'standalone', executorPort: 9901,
      githubApp: { appId: 'fixture', privateKey: 'unused', webhookSecret: secret },
    };
    const app = express();
    app.use(express.json({ verify: (req, _res, body) => { (req as { rawBody?: Buffer }).rawBody = body; } }));
    app.use('/api', createGithubWebhookRouter({ stateService: state, shell, config, worktreeService: new WorktreeService(shell),
      observePlanningGithubEvent: createPlanningGithubObserver(state, planning) }));
    server = listenLoopbackFixture(app);
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a local listening port');
    endpoint = `http://127.0.0.1:${address.port}/api/github/webhook`;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await flushAllJsonStateStores();
    await rm(directory, { recursive: true, force: true });
  });

  async function send(event: string, payload: unknown, signingSecret = secret) {
    const body = JSON.stringify(payload);
    const signature = createHmac('sha256', signingSecret).update(body).digest('hex');
    const response = await fetch(endpoint, { method: 'POST', body, headers: { 'content-type': 'application/json',
      'x-github-event': event, 'x-github-delivery': `fixture-${++delivery}`, 'x-hub-signature-256': `sha256=${signature}` } });
    expect(response.headers.get('x-cds-fixture-id')).toBe(getHttpFixtureTrace(server)?.id);
    return { status: response.status, body: await response.json() };
  }

  function pr(body: string, overrides: Record<string, unknown> = {}, repo = repository, action = 'opened') {
    return { action, repository: { full_name: repo }, installation: { id: 42 }, sender: { login: 'automation' }, pull_request: {
      number: 2412, title: 'Add report theme', html_url: `https://github.com/${repo}/pull/2412`, body, state: 'open', draft: true,
      created_at: '2026-11-20T08:00:00Z', updated_at: '2026-11-20T09:00:00Z', user: { login: 'lisa' },
      head: { ref: 'feature/report-theme', sha: head, repo: { full_name: repo } }, ...overrides,
    } };
  }

  async function decision(repo = repository, destination = projectId) {
    const result = await planning.command(destination, owner, {
      type: 'decision.create', requestId: `fixture-decision-${destination}`, title: '报表主题审批', source, links: [link],
      pullRequest: { url: `https://github.com/${repo}/pull/2412` },
    });
    return (result.result as { id: string }).id;
  }

  function deployed(branch: string, sha: string) {
    const id = branch === 'main' ? 'planning-main' : 'planning-feature';
    const versionId = `${id}-${sha[0]}`;
    if (!state.getBranch(id)) state.addBranch({ id, branch, projectId, worktreePath: directory, status: 'running',
      services: { web: { profileId: 'web', containerName: 'fixture-web', hostPort: 19555, status: 'running' } }, createdAt: now.toISOString() });
    state.addDeploymentVersion({ id: versionId, projectId, branchId: id, commitSha: sha, configHash: 'fixture',
      profiles: [{ profileId: 'web', name: 'Web', artifactImage: 'fixture', artifactKind: 'managed-image', reusable: true,
        containerPort: 8080, containerWorkDir: '/' }], migrations: [], capabilities: [], createdByRunId: 'fixture-run', createdAt: now.toISOString() });
    state.getBranch(id)!.currentVersionId = versionId;
    state.getBranch(id)!.services.web.deployedImage = 'fixture';
  }

  it('uses signature, owner and project scope before persisting PR facts and keeps author distinct from sender', async () => {
    const id = await decision();
    await decision('blocked/repo', 'blocked-project');
    expect((await send('pull_request', pr(''), 'not-the-webhook-secret')).status).toBe(401);
    expect((await send('pull_request', pr('', {}, 'blocked/repo'))).body.action).toBe('ignored-github-owner-not-allowed');
    expect((await planning.board(projectId, owner)).pullRequests ?? []).toEqual([]);
    expect((await planning.board('blocked-project', owner)).pullRequests ?? []).toEqual([]);

    const accepted = await send('pull_request', pr(`${'Long description\n'.repeat(300)}ADR: ${id}\nPreview: ${targetPath}`));
    expect(accepted.status).toBe(200);
    const board = await reopenPlanning().board(projectId, owner);
    expect(board.decisions[0].links).toEqual([link]);
    expect(board.pullRequests).toEqual([expect.objectContaining({ number: 2412, url: prUrl, state: 'draft',
      title: 'Add report theme', author: 'lisa', decisionIds: [id], target: { label: targetPath, path: targetPath } })]);
    expect(board.pullRequests![0]).not.toHaveProperty('checks');
    expect((await planning.board('unrelated-project', owner)).pullRequests ?? []).toEqual([]);
  });

  it('uses actual deployment head and expires only a previously built preview', async () => {
    const id = await decision();
    deployed('main', head);
    deployed('feature/report-theme', otherHead);
    await send('pull_request', pr(`ADR: ${id}\nPreview: ${targetPath}`));
    expect((await planning.board(projectId, owner)).pullRequests![0].preview).toBeUndefined();

    deployed('feature/report-theme', head);
    const matched = (await planning.board(projectId, owner)).pullRequests![0];
    expect(matched.preview).toMatchObject({ status: 'ready', commit: head, url: expect.stringMatching(/^https:\/\/[^/]+\.preview\.example\.test$/) });
    expect(matched.target?.path).toBe(targetPath);
    state.getBranch('planning-feature')!.services.web.sourceCommitSha = otherHead;
    expect((await planning.board(projectId, owner)).pullRequests![0].preview).toBeUndefined();
    delete state.getBranch('planning-feature')!.services.web.sourceCommitSha;

    await send('pull_request', pr(`ADR: ${id}`, {
      state: 'closed', merged: true, closed_at: '2026-11-20T11:00:00Z', merged_at: '2026-11-20T11:00:00Z', updated_at: '2026-11-20T11:00:00Z',
    }, repository, 'closed'));
    await send('pull_request', pr(`ADR: ${id}`, {}, repository, 'edited'));
    now = new Date('2026-11-28T12:00:00Z');
    const board = await planning.board(projectId, owner);
    expect(board.pullRequests![0]).toMatchObject({ state: 'merged', preview: { status: 'expired', commit: head } });
    expect(board.pullRequests![0].preview).not.toHaveProperty('url');
    expect(board.decisions[0].status).toBe('proposed');
  });

  it('tracks signed check runs only for the current PR commit and retains the existing noise response', async () => {
    const id = await decision();
    await send('pull_request', pr(`ADR: ${id}`));
    const check = (sha: string, status: string, conclusion: string | null, id = 123) => ({ action: status === 'completed' ? 'completed' : 'created',
      repository: { full_name: repository }, installation: { id: 42 }, check_run: { id, name: 'Build and Test', head_sha: sha, status, conclusion,
        app: { id: 7 }, pull_requests: [{ number: 2412 }] } });
    expect((await send('check_run', check(otherHead, 'completed', 'failure'))).body.action).toBe('ignored-noise');
    expect((await planning.board(projectId, owner)).pullRequests![0].checks).toBeUndefined();
    await send('check_run', check(head, 'queued', null));
    expect((await planning.board(projectId, owner)).pullRequests![0].checks).toBe('running');
    await send('check_run', check(head, 'completed', 'failure'));
    expect((await reopenPlanning().board(projectId, owner)).pullRequests![0].checks).toBe('fail');
    await send('check_run', check(head, 'completed', 'success', 124));
    await send('check_run', check(head, 'queued', null, 123));
    expect((await planning.board(projectId, owner)).pullRequests![0].checks).toBe('pass');
  });

  it('binds signed PR metadata through branch references and debt IDs while preserving branch preview destinations', async () => {
    const decision = (await planning.command(projectId, owner, { type: 'decision.create', requestId: 'adr-fixture',
      title: '报表外观', source: { type: 'adr', ref: 'ADR-007' }, links: [link] })).result as { id: string };
    const debt = (await planning.command(projectId, owner, { type: 'debt.create', requestId: 'debt-fixture',
      title: '导出未跟随报表主题', source: { type: 'manual', ref: 'ATL-0351' }, decisionId: decision.id })).result as { id: string };
    const branch = 'work/adr-007/report-theme';
    const payload = pr(`Debt: ATL-0351\nPreview: ${targetPath}`, { head: { ref: branch, sha: head, repo: { full_name: repository } } });
    await send('pull_request', { ...payload, installation: { id: 123 } });
    expect((await planning.board(projectId, owner)).pullRequests ?? []).toEqual([]);
    await send('pull_request', payload);
    const related = (await planning.debt(projectId, debt.id)).pullRequests;
    expect(related).toEqual([expect.objectContaining({ decisionIds: [decision.id], debtIds: [debt.id] })]);
    expect((await planning.board(projectId, owner)).decisions[0].pullRequests).toEqual(related);
    expect(planningPreviewTargetUrl('https://entry.preview.example.test/home', related![0].target!.path))
      .toBe(`https://entry.preview.example.test${targetPath}`);
    for (const unsafe of ['//other.example.test/path', '/\\other.example.test/path', 'https://other.example.test/path']) {
      expect(planningPreviewTargetUrl('https://entry.preview.example.test', unsafe)).toBeUndefined();
    }
  });

  it('keeps a signed PR attached to an unconfirmed proposal out of the board until the decision is created', async () => {
    await send('pull_request', pr(''));
    const submitted = (await planning.command(projectId, owner, { type: 'proposal.submit', requestId: 'proposal-fixture', kind: 'decision',
      source: { type: 'adr', ref: 'docs/adr/0007-reports.md' }, draft: { title: '报表主题决策', links: [link],
        pullRequest: { url: prUrl, target: { label: '新版报表', path: targetPath } } } })).result as { id: string };
    expect((await planning.board(projectId, owner)).pullRequests ?? []).toEqual([]);
    await planning.command(projectId, owner, { type: 'proposal.accept', requestId: 'accept-fixture', proposalId: submitted.id });
    const board = await reopenPlanning().board(projectId, owner);
    expect(board.decisions[0].links).toEqual([link]);
    expect(board.decisions[0].pullRequests).toEqual([expect.objectContaining({ number: 2412, target: { label: '新版报表', path: targetPath } })]);
    await planning.command(projectId, owner, { type: 'decision.change', requestId: 'decision-link-revision', decisionId: board.decisions[0].id,
      expectedVersion: board.decisions[0].version, change: 'amended', reason: '移除待同步链接', links: [], pullRequest: null });
    const revised = (await planning.board(projectId, owner)).decisions[0];
    expect(revised.links).toEqual([]);
    expect(revised.pullRequest).toBeUndefined();
    expect(revised.pullRequests).toBeUndefined();
  });

  it('starts the file grace period only for a signed PR at the deletion on the synced default branch', async () => {
    const git = async (...args: string[]) => (await runProcess('git', args, { cwd: directory })).stdout.trim();
    await git('init', '--initial-branch=main');
    await git('config', 'user.name', 'Planning fixture');
    await git('config', 'user.email', 'planning@example.test');
    await git('remote', 'add', 'origin', `https://github.com/${repository}.git`);
    await writeFile(path.join(directory, 'deleted.ts'), '// removal fixture\n');
    await writeFile(path.join(directory, 'restored.ts'), '// restoration fixture\n');
    await git('add', 'deleted.ts', 'restored.ts');
    await git('commit', '-m', 'Fixtures before removal');

    async function bind(file: string) {
      const debt = (await planning.command(projectId, owner, { type: 'debt.create', requestId: `create-${file}`,
        title: `绑定 ${file}`, source: { ...source, ref: file } })).result as { id: string; version: number };
      await planning.command(projectId, owner, { type: 'debt.anchor', requestId: `bind-${file}`, debtId: debt.id,
        expectedVersion: debt.version, anchor: { type: 'file', ref: `./${file}` }, reason: '当前功能所在文件' });
      return debt.id;
    }
    const deleted = await bind('deleted.ts');
    const restored = await bind('restored.ts');
    await git('switch', '-c', 'feature/report-theme');
    await git('rm', '--', 'deleted.ts', 'restored.ts');
    await git('commit', '-m', 'Remove both files');
    const headSha = await git('rev-parse', 'HEAD');
    await git('switch', 'main');
    await git('merge', '--no-ff', '--no-edit', 'feature/report-theme');
    const mergeSha = await git('rev-parse', 'HEAD');
    await writeFile(path.join(directory, 'restored.ts'), '// restored\n');
    await git('add', 'restored.ts');
    await git('commit', '-m', 'Restore one file');
    await git('update-ref', 'refs/remotes/origin/main', 'HEAD');

    const mergedAt = '2026-11-20T11:00:00Z';
    now = new Date('2026-11-21T06:00:00Z');
    const merged = (base: string, merge_commit_sha: string, number = 2412) => pr('', {
      number, html_url: `https://github.com/${repository}/pull/${number}`,
      state: 'closed', merged: true, closed_at: mergedAt, merged_at: mergedAt, updated_at: mergedAt, merge_commit_sha,
      base: { ref: base }, head: { ref: 'feature/report-theme', sha: headSha, repo: { full_name: repository } },
    }, repository, 'closed');
    await send('pull_request', merged('main', mergeSha), 'bad-signature');
    expect(await planning.scanGithubFileAnchors(projectId)).toBe(0);
    await send('pull_request', merged('release', mergeSha, 2413));
    expect(await planning.scanGithubFileAnchors(projectId)).toBe(0);
    await send('pull_request', merged('main', headSha, 2414));
    expect(await planning.scanGithubFileAnchors(projectId)).toBe(0);
    await send('pull_request', merged('main', mergeSha));
    await git('remote', 'set-url', 'origin', 'https://github.com/octocat/unrelated.git');
    expect(await planning.scanGithubFileAnchors(projectId)).toBe(0);
    await git('remote', 'set-url', 'origin', `https://github.com/${repository}.git`);
    expect(await reopenPlanning().scanGithubFileAnchors(projectId)).toBe(1);
    expect(await planning.scanGithubFileAnchors(projectId)).toBe(0);
    const detail = await planning.debt(projectId, deleted);
    expect(detail.debt).toMatchObject({ status: 'open', anchor: { status: 'missing', missingAt: now.toISOString(),
      closeAt: '2026-11-28T06:00:00.000Z', evidence: [{ type: 'change', label: 'PR #2412 删除 deleted.ts', url: prUrl }],
      source: { kind: 'github-file', proof: { repository, pullRequestUrl: prUrl, defaultBranch: 'main', path: 'deleted.ts', mergeCommitSha: mergeSha } } } });
    expect(detail.events[0]).toMatchObject({ type: 'extinct_pending', via: 'system', actor: { kind: 'system', label: 'CDS 巡检' } });
    expect((await planning.debt(projectId, restored)).debt.anchor?.status).toBe('alive');
    now = new Date('2026-11-28T07:00:00Z');
    await planning.sweepRecordedRemovals(projectId, new Date('2026-11-28T06:00:00Z'));
    expect((await planning.debt(projectId, deleted)).debt).toMatchObject({ status: 'dropped',
      outcome: { kind: 'extinct', closedAt: '2026-11-28T06:00:00.000Z' } });
  });
});
