/**
 * Unit tests for GitHubWebhookDispatcher.
 *
 * Uses an in-memory StateService + a stub WorktreeService + a stub
 * IShellExecutor. These tests focus on the branching logic of the
 * dispatcher — they don't actually clone git repos or talk to GitHub.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import type { IShellExecutor, CdsConfig } from '../../src/types.js';
import { GitHubWebhookDispatcher } from '../../src/services/github-webhook-dispatcher.js';

class MockShell implements IShellExecutor {
  calls: Array<{ cmd: string; cwd?: string }> = [];
  async exec(command: string, options?: { cwd?: string }) {
    this.calls.push({ cmd: command, cwd: options?.cwd });
    return { stdout: '', stderr: '', exitCode: 0 };
  }
}

class MockWorktree extends WorktreeService {
  createdWorktrees: Array<{ repoRoot: string; branch: string; targetDir: string }> = [];
  override async create(repoRoot: string, branch: string, targetDir: string) {
    this.createdWorktrees.push({ repoRoot, branch, targetDir });
  }
}

function buildConfig(overrides?: Partial<CdsConfig>): CdsConfig {
  return {
    repoRoot: '/tmp/repo',
    worktreeBase: '/tmp/wt',
    masterPort: 9900,
    workerPort: 5500,
    dockerNetwork: 'cds',
    portStart: 10001,
    sharedEnv: {},
    jwt: { secret: 'x'.repeat(32), issuer: 'cds' },
    mode: 'standalone',
    executorPort: 9901,
    ...overrides,
  };
}

describe('GitHubWebhookDispatcher', () => {
  let tmp: string;
  let stateService: StateService;
  let shell: MockShell;
  let worktree: MockWorktree;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-whd-'));
    stateService = new StateService(path.join(tmp, 'state.json'), tmp);
    stateService.load();
    shell = new MockShell();
    worktree = new MockWorktree(shell);
  });

  function buildDispatcher(): GitHubWebhookDispatcher {
    return new GitHubWebhookDispatcher({
      stateService,
      worktreeService: worktree,
      shell,
      config: buildConfig(),
    });
  }

  describe('ping', () => {
    it('acknowledges ping events', async () => {
      const d = buildDispatcher();
      const result = await d.handle('ping', { zen: 'hi' });
      expect(result.action).toBe('ignored-ping');
    });
  });

  describe('push events', () => {
    it('returns ignored-no-project when no project matches', async () => {
      const d = buildDispatcher();
      const result = await d.handle('push', {
        ref: 'refs/heads/main',
        after: 'abc123def456789012345678901234567890aaaa',
        repository: { id: 1, full_name: 'octocat/missing' },
      });
      expect(result.action).toBe('ignored-no-project');
      expect(result.deployRequest).toBeUndefined();
    });

    it('ignores tag pushes', async () => {
      const d = buildDispatcher();
      const result = await d.handle('push', {
        ref: 'refs/tags/v1',
        after: 'abc1234567890abcdef1234567890abcdef12345',
        repository: { id: 1, full_name: 'octocat/repo' },
      });
      expect(result.action).toBe('ignored-non-branch');
    });

    it('ignores delete pushes', async () => {
      const d = buildDispatcher();
      const result = await d.handle('push', {
        ref: 'refs/heads/main',
        deleted: true,
        repository: { id: 1, full_name: 'octocat/repo' },
      });
      expect(result.action).toBe('ignored-delete');
    });

    it('honours autoDeploy=false', async () => {
      stateService.addProject({
        id: 'p1',
        slug: 'proj',
        name: 'Proj',
        kind: 'git',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        githubRepoFullName: 'octocat/repo',
        githubInstallationId: 42,
        githubAutoDeploy: false,
      });
      const d = buildDispatcher();
      const result = await d.handle('push', {
        ref: 'refs/heads/feature',
        after: 'abc123def456789012345678901234567890aaaa',
        repository: { id: 1, full_name: 'octocat/repo' },
      });
      expect(result.action).toBe('ignored-auto-deploy-off');
      expect(result.deployRequest).toBeUndefined();
    });

    it('creates a new branch + records deploy request on push', async () => {
      stateService.addProject({
        id: 'p1',
        slug: 'proj',
        name: 'Proj',
        kind: 'git',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        githubRepoFullName: 'octocat/repo',
        githubInstallationId: 42,
      });
      const d = buildDispatcher();
      const result = await d.handle('push', {
        ref: 'refs/heads/feature-x',
        after: 'deadbeef01234567890abcdef1234567890abcde',
        repository: { id: 1, full_name: 'octocat/repo' },
      });
      expect(result.action).toBe('branch-created');
      expect(result.branchId).toBe('proj-feature-x');
      expect(result.deployRequest).toEqual({ branchId: 'proj-feature-x', commitSha: 'deadbeef01234567890abcdef1234567890abcde' });

      const branch = stateService.getBranch('proj-feature-x');
      expect(branch).toBeDefined();
      expect(branch!.githubRepoFullName).toBe('octocat/repo');
      expect(branch!.githubCommitSha).toBe('deadbeef01234567890abcdef1234567890abcde');
      expect(branch!.githubInstallationId).toBe(42);
      expect(worktree.createdWorktrees).toHaveLength(1);
    });

    it('refreshes an existing branch (no new worktree)', async () => {
      stateService.addProject({
        id: 'p1',
        slug: 'proj',
        name: 'Proj',
        kind: 'git',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        githubRepoFullName: 'octocat/repo',
        githubInstallationId: 42,
      });
      stateService.addBranch({
        id: 'proj-main',
        projectId: 'p1',
        branch: 'main',
        worktreePath: '/tmp/wt/p1/proj-main',
        services: {},
        status: 'idle',
        createdAt: new Date().toISOString(),
      });
      const d = buildDispatcher();
      const result = await d.handle('push', {
        ref: 'refs/heads/main',
        after: 'cafebabe01234567890abcdef1234567890abcde',
        repository: { id: 1, full_name: 'octocat/repo' },
      });
      expect(result.action).toBe('branch-refreshed');
      expect(result.branchId).toBe('proj-main');
      expect(worktree.createdWorktrees).toHaveLength(0);
      const branch = stateService.getBranch('proj-main');
      expect(branch!.githubCommitSha).toBe('cafebabe01234567890abcdef1234567890abcde');
    });

    it('matches repo full names case-insensitively', async () => {
      stateService.addProject({
        id: 'p1',
        slug: 'proj',
        name: 'Proj',
        kind: 'git',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        githubRepoFullName: 'OctoCat/Repo',
        githubInstallationId: 42,
      });
      const d = buildDispatcher();
      const result = await d.handle('push', {
        ref: 'refs/heads/main',
        after: 'ab12345678901234567890123456789012345678',
        repository: { id: 1, full_name: 'octocat/repo' },
      });
      expect(result.action).toBe('branch-created');
    });
  });

  describe('installation_repositories removed', () => {
    it('detaches a removed repo link from matching project', async () => {
      stateService.addProject({
        id: 'p1',
        slug: 'proj',
        name: 'Proj',
        kind: 'git',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        githubRepoFullName: 'octocat/repo',
        githubInstallationId: 42,
      });
      const d = buildDispatcher();
      await d.handle('installation_repositories', {
        action: 'removed',
        installation: { id: 42 },
        repositories_removed: [{ full_name: 'octocat/repo' }],
      });
      const updated = stateService.getProject('p1')!;
      expect(updated.githubRepoFullName).toBeUndefined();
      expect(updated.githubInstallationId).toBeUndefined();
    });
  });

  describe('check_run rerequested', () => {
    it('queues a redeploy when the branch exists', async () => {
      stateService.addProject({
        id: 'p1',
        slug: 'proj',
        name: 'Proj',
        kind: 'git',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        githubRepoFullName: 'octocat/repo',
        githubInstallationId: 42,
      });
      stateService.addBranch({
        id: 'proj-main',
        projectId: 'p1',
        branch: 'main',
        worktreePath: '/tmp/x',
        services: {},
        status: 'running',
        createdAt: new Date().toISOString(),
      });
      const d = buildDispatcher();
      const result = await d.handle('check_run', {
        action: 'rerequested',
        check_run: { id: 1, head_sha: 'ca55e77e', external_id: 'proj-main', check_suite: { id: 9 } },
        repository: { full_name: 'octocat/repo' },
        installation: { id: 42 },
      });
      expect(result.action).toBe('check-run-requeued');
      expect(result.deployRequest).toEqual({ branchId: 'proj-main', commitSha: 'ca55e77e' });
    });
  });

  describe('unhandled events', () => {
    it('returns ignored-event', async () => {
      // Use an event we genuinely don't handle (not in the case switch).
      // `release` now has its own acknowledgement handler.
      const d = buildDispatcher();
      const result = await d.handle('deployment_status', { action: 'created' });
      expect(result.action).toBe('ignored-event');
    });
  });

  describe('pull_request events', () => {
    beforeEach(() => {
      stateService.addProject({
        id: 'p1',
        slug: 'proj',
        name: 'Proj',
        kind: 'git',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        githubRepoFullName: 'octocat/repo',
        githubInstallationId: 42,
      });
      stateService.addBranch({
        id: 'proj-feature',
        projectId: 'p1',
        branch: 'feature',
        worktreePath: '/tmp/wt',
        services: {},
        status: 'running',
        createdAt: new Date().toISOString(),
      });
    });

    it('returns pr-comment-posted on opened and stamps prNumber on branch', async () => {
      const d = buildDispatcher();
      const result = await d.handle('pull_request', {
        action: 'opened',
        number: 99,
        pull_request: {
          number: 99,
          state: 'open',
          head: { ref: 'feature', sha: 'abc' },
          base: { ref: 'main' },
          html_url: 'https://github.com/octocat/repo/pull/99',
          title: 'Great feature',
        },
        repository: { full_name: 'octocat/repo' },
        installation: { id: 42 },
      });
      expect(result.action).toBe('pr-comment-posted');
      expect(result.branchId).toBe('proj-feature');
      const branch = stateService.getBranch('proj-feature');
      expect(branch!.githubPrNumber).toBe(99);
    });

    it('returns pr-branch-stopped on closed with stopRequest', async () => {
      const d = buildDispatcher();
      const result = await d.handle('pull_request', {
        action: 'closed',
        number: 99,
        pull_request: {
          number: 99,
          state: 'closed',
          merged: true,
          head: { ref: 'feature', sha: 'abc' },
          base: { ref: 'main' },
          html_url: 'https://github.com/octocat/repo/pull/99',
          title: 'Great feature',
        },
        repository: { full_name: 'octocat/repo' },
      });
      expect(result.action).toBe('pr-branch-stopped');
      expect(result.stopRequest).toEqual({ branchId: 'proj-feature' });
    });

    it('ignores synchronize (handled by companion push)', async () => {
      const d = buildDispatcher();
      const result = await d.handle('pull_request', {
        action: 'synchronize',
        number: 99,
        pull_request: {
          number: 99,
          state: 'open',
          head: { ref: 'feature', sha: 'abc' },
          base: { ref: 'main' },
          html_url: 'x',
          title: 't',
        },
        repository: { full_name: 'octocat/repo' },
      });
      expect(result.action).toBe('ignored-event');
    });

    it('ignores pull_request for unlinked repo', async () => {
      const d = buildDispatcher();
      const result = await d.handle('pull_request', {
        action: 'opened',
        number: 1,
        pull_request: {
          number: 1,
          state: 'open',
          head: { ref: 'x', sha: 'y' },
          base: { ref: 'main' },
          html_url: 'z',
          title: 't',
        },
        repository: { full_name: 'stranger/repo' },
      });
      expect(result.action).toBe('ignored-no-project');
    });
  });

  describe('issue_comment slash commands', () => {
    beforeEach(() => {
      stateService.addProject({
        id: 'p1', slug: 'proj', name: 'Proj', kind: 'git',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        githubRepoFullName: 'octocat/repo', githubInstallationId: 42,
      });
      stateService.addBranch({
        id: 'proj-feat', projectId: 'p1', branch: 'feat',
        worktreePath: '/tmp/wt', services: {}, status: 'running',
        createdAt: new Date().toISOString(),
        githubPrNumber: 7,
      });
    });

    async function fireComment(body: string) {
      const d = buildDispatcher();
      return d.handle('issue_comment', {
        action: 'created',
        comment: { id: 99, body, user: { login: 'alice' } },
        issue: { number: 7, pull_request: { url: 'x', html_url: 'y' } },
        repository: { full_name: 'octocat/repo' },
        installation: { id: 42 },
      });
    }

    it('parses /cds redeploy + resolves branch from PR number', async () => {
      const r = await fireComment('/cds redeploy');
      expect(r.action).toBe('slash-command-invoked');
      expect(r.slashCommand?.command).toBe('redeploy');
      expect(r.slashCommand?.branchId).toBe('proj-feat');
      expect(r.slashCommand?.commenter).toBe('alice');
    });

    it('parses /cds stop', async () => {
      const r = await fireComment('/cds stop');
      expect(r.slashCommand?.command).toBe('stop');
    });

    it('parses /cds logs', async () => {
      const r = await fireComment('/cds logs');
      expect(r.slashCommand?.command).toBe('logs');
    });

    it('parses /cds help', async () => {
      const r = await fireComment('/cds help');
      expect(r.slashCommand?.command).toBe('help');
    });

    it('defaults bare /cds to help', async () => {
      const r = await fireComment('/cds');
      expect(r.slashCommand?.command).toBe('help');
    });

    it('maps unknown verbs to help with arg', async () => {
      const r = await fireComment('/cds foobar');
      expect(r.slashCommand?.command).toBe('unknown');
      expect(r.slashCommand?.arg).toBe('foobar');
    });

    it('ignores non-slash comments', async () => {
      const r = await fireComment('looks good to me');
      expect(r.action).toBe('ignored-event');
    });

    it('ignores comment on non-PR issue (no pull_request field)', async () => {
      const d = buildDispatcher();
      const r = await d.handle('issue_comment', {
        action: 'created',
        comment: { id: 1, body: '/cds redeploy', user: { login: 'alice' } },
        issue: { number: 99 },
        repository: { full_name: 'octocat/repo' },
      });
      expect(r.action).toBe('ignored-event');
    });
  });

  describe('delete event (branch deletion on GitHub)', () => {
    beforeEach(() => {
      stateService.addProject({
        id: 'p1', slug: 'proj', name: 'Proj', kind: 'git',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        githubRepoFullName: 'octocat/repo', githubInstallationId: 42,
      });
      stateService.addBranch({
        id: 'proj-feat', projectId: 'p1', branch: 'feat',
        worktreePath: '/tmp/wt', services: {}, status: 'running',
        createdAt: new Date().toISOString(),
      });
    });

    it('returns branch-deleted with stopRequest for branch ref_type', async () => {
      const d = buildDispatcher();
      const r = await d.handle('delete', {
        ref: 'feat',
        ref_type: 'branch',
        repository: { full_name: 'octocat/repo' },
      });
      expect(r.action).toBe('branch-deleted');
      expect(r.stopRequest).toEqual({ branchId: 'proj-feat' });
    });

    it('ignores tag deletions', async () => {
      const d = buildDispatcher();
      const r = await d.handle('delete', {
        ref: 'v1.0.0',
        ref_type: 'tag',
        repository: { full_name: 'octocat/repo' },
      });
      expect(r.action).toBe('ignored-event');
    });

    it('ignores delete for branch CDS never tracked', async () => {
      const d = buildDispatcher();
      const r = await d.handle('delete', {
        ref: 'never-existed',
        ref_type: 'branch',
        repository: { full_name: 'octocat/repo' },
      });
      expect(r.action).toBe('ignored-event');
    });
  });

  describe('repository event (rename / delete / transfer)', () => {
    beforeEach(() => {
      stateService.addProject({
        id: 'p1', slug: 'proj', name: 'Proj', kind: 'git',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        githubRepoFullName: 'octocat/repo', githubInstallationId: 42,
      });
    });

    it('detaches link on repository.deleted', async () => {
      const d = buildDispatcher();
      const r = await d.handle('repository', {
        action: 'deleted',
        repository: { full_name: 'octocat/repo', name: 'repo', owner: { login: 'octocat' } },
      });
      expect(r.action).toBe('repo-detached');
      const p = stateService.getProject('p1')!;
      expect(p.githubRepoFullName).toBeUndefined();
    });

    it('detaches link on repository.renamed using changes.repository.name.from', async () => {
      const d = buildDispatcher();
      const r = await d.handle('repository', {
        action: 'renamed',
        repository: { full_name: 'octocat/new-name', name: 'new-name', owner: { login: 'octocat' } },
        changes: { repository: { name: { from: 'repo' } } },
      });
      expect(r.action).toBe('repo-renamed');
      const p = stateService.getProject('p1')!;
      expect(p.githubRepoFullName).toBeUndefined();
    });

    it('ignores repository events with no linked project', async () => {
      const d = buildDispatcher();
      const r = await d.handle('repository', {
        action: 'deleted',
        repository: { full_name: 'stranger/thing', name: 'thing', owner: { login: 'stranger' } },
      });
      expect(r.action).toBe('ignored-event');
    });
  });

  describe('release event', () => {
    it('acknowledges release events for future implementation', async () => {
      const d = buildDispatcher();
      const r = await d.handle('release', {
        action: 'published',
        release: { tag_name: 'v1.0.0', name: '1.0', html_url: 'x', draft: false, prerelease: false },
        repository: { full_name: 'octocat/repo' },
      });
      expect(r.action).toBe('release-acknowledged');
    });
  });
});
