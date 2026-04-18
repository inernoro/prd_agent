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
        after: 'abc123',
        repository: { id: 1, full_name: 'octocat/missing' },
      });
      expect(result.action).toBe('ignored-no-project');
      expect(result.deployRequest).toBeUndefined();
    });

    it('ignores tag pushes', async () => {
      const d = buildDispatcher();
      const result = await d.handle('push', {
        ref: 'refs/tags/v1',
        after: 'abc',
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
        after: 'abc123',
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
        after: 'deadbeef',
        repository: { id: 1, full_name: 'octocat/repo' },
      });
      expect(result.action).toBe('branch-created');
      expect(result.branchId).toBe('proj-feature-x');
      expect(result.deployRequest).toEqual({ branchId: 'proj-feature-x', commitSha: 'deadbeef' });

      const branch = stateService.getBranch('proj-feature-x');
      expect(branch).toBeDefined();
      expect(branch!.githubRepoFullName).toBe('octocat/repo');
      expect(branch!.githubCommitSha).toBe('deadbeef');
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
        after: 'cafebabe',
        repository: { id: 1, full_name: 'octocat/repo' },
      });
      expect(result.action).toBe('branch-refreshed');
      expect(result.branchId).toBe('proj-main');
      expect(worktree.createdWorktrees).toHaveLength(0);
      const branch = stateService.getBranch('proj-main');
      expect(branch!.githubCommitSha).toBe('cafebabe');
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
        after: 'ab',
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
      const d = buildDispatcher();
      const result = await d.handle('release', { action: 'published' });
      expect(result.action).toBe('ignored-event');
    });
  });
});
