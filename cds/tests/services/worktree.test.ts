import { describe, it, expect, beforeEach } from 'vitest';
import { WorktreeService } from '../../src/services/worktree.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';

describe('WorktreeService', () => {
  let mock: MockShellExecutor;
  let service: WorktreeService;

  beforeEach(() => {
    mock = new MockShellExecutor();
    service = new WorktreeService(mock, '/repo');
  });

  describe('create', () => {
    it('should fetch then create a worktree', async () => {
      mock.addResponsePattern(/git fetch/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/test -d/, () => ({ stdout: '', stderr: '', exitCode: 1 }));
      mock.addResponsePattern(/git worktree add/, () => ({ stdout: 'Preparing worktree', stderr: '', exitCode: 0 }));

      await service.create('feature/new-ui', '/tmp/wt/feature-new-ui');
      expect(mock.commands[0]).toContain('git fetch');
      expect(mock.commands.find(c => c.includes('git worktree add'))).toContain('/tmp/wt/feature-new-ui');
      expect(mock.commands.find(c => c.includes('git worktree add'))).toContain('origin/feature/new-ui');
    });

    it('should clean up stale worktree directory before creating', async () => {
      mock.addResponsePattern(/git fetch/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/test -d/, () => ({ stdout: 'exists\n', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/git worktree prune/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/rm -rf/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/git worktree add/, () => ({ stdout: 'Preparing worktree', stderr: '', exitCode: 0 }));

      await service.create('main', '/tmp/wt/main');
      expect(mock.commands).toContainEqual(expect.stringContaining('git worktree prune'));
      expect(mock.commands).toContainEqual(expect.stringContaining('rm -rf'));
      expect(mock.commands).toContainEqual(expect.stringContaining('git worktree add'));
    });

    it('should throw if fetch fails', async () => {
      mock.addResponsePattern(/git fetch/, () => ({
        stdout: '',
        stderr: 'fatal: remote error',
        exitCode: 128,
      }));

      await expect(service.create('bad-branch', '/tmp/wt/bad')).rejects.toThrow('拉取分支');
    });

    it('should throw if worktree add fails', async () => {
      mock.addResponsePattern(/git fetch/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/test -d/, () => ({ stdout: '', stderr: '', exitCode: 1 }));
      mock.addResponsePattern(/git worktree add/, () => ({
        stdout: '',
        stderr: 'fatal: already exists',
        exitCode: 128,
      }));

      await expect(service.create('dup', '/tmp/wt/dup')).rejects.toThrow('创建工作树');
    });
  });

  describe('remove', () => {
    it('should remove a worktree', async () => {
      mock.addResponsePattern(/git worktree remove/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      await service.remove('/tmp/wt/old');
      expect(mock.commands[0]).toContain('git worktree remove');
      expect(mock.commands[0]).toContain('--force');
      expect(mock.commands[0]).toContain('/tmp/wt/old');
    });

    it('should throw if remove fails', async () => {
      mock.addResponsePattern(/git worktree remove/, () => ({
        stdout: '',
        stderr: 'error: not a worktree',
        exitCode: 1,
      }));

      await expect(service.remove('/tmp/wt/bad')).rejects.toThrow();
    });
  });

  describe('pull', () => {
    it('should return updated=true when new commits are pulled', async () => {
      let callCount = 0;
      mock.addResponsePattern(/git rev-parse --short HEAD/, () => {
        callCount++;
        // First call: before SHA, Second call: after SHA (different)
        return callCount === 1
          ? { stdout: 'abc1234\n', stderr: '', exitCode: 0 }
          : { stdout: 'def5678\n', stderr: '', exitCode: 0 };
      });
      mock.addResponsePattern(/git fetch/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/git reset --hard/, () => ({ stdout: 'HEAD is now at def5678', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/git log --oneline/, () => ({ stdout: 'def5678 new feature\n', stderr: '', exitCode: 0 }));

      const result = await service.pull('main', '/tmp/wt/main');
      expect(result.updated).toBe(true);
      expect(result.before).toBe('abc1234');
      expect(result.after).toBe('def5678');
      expect(result.head).toBe('def5678 new feature');
    });

    it('should return updated=false when already at latest', async () => {
      mock.addResponsePattern(/git rev-parse --short HEAD/, () => ({
        stdout: 'abc1234\n', stderr: '', exitCode: 0,
      }));
      mock.addResponsePattern(/git fetch/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/git reset --hard/, () => ({ stdout: 'HEAD is now at abc1234', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/git log --oneline/, () => ({ stdout: 'abc1234 existing commit\n', stderr: '', exitCode: 0 }));

      const result = await service.pull('main', '/tmp/wt/main');
      expect(result.updated).toBe(false);
      expect(result.before).toBe('abc1234');
      expect(result.after).toBe('abc1234');
    });

    it('should throw if fetch fails', async () => {
      mock.addResponsePattern(/git rev-parse/, () => ({ stdout: 'abc\n', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/git fetch/, () => ({
        stdout: '', stderr: 'fatal: network error', exitCode: 128,
      }));

      await expect(service.pull('bad', '/tmp/wt/bad')).rejects.toThrow('拉取失败');
    });

    it('should throw if reset fails', async () => {
      mock.addResponsePattern(/git rev-parse/, () => ({ stdout: 'abc\n', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/git fetch/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/git reset --hard/, () => ({
        stdout: '', stderr: 'fatal: ambiguous argument', exitCode: 1,
      }));

      await expect(service.pull('bad', '/tmp/wt/bad')).rejects.toThrow('重置失败');
    });
  });

  describe('repoRoot setter', () => {
    it('should allow updating repoRoot at runtime', () => {
      expect(service.repoRoot).toBe('/repo');
      service.repoRoot = '/new-repo';
      expect(service.repoRoot).toBe('/new-repo');
    });

    it('should accept different repoRoot in constructor', () => {
      const svc2 = new WorktreeService(mock, '/other-repo');
      expect(svc2.repoRoot).toBe('/other-repo');
      svc2.repoRoot = '/changed';
      expect(svc2.repoRoot).toBe('/changed');
    });
  });

  describe('branchExists', () => {
    it('should return true if remote branch exists', async () => {
      mock.addResponsePattern(/git ls-remote/, () => ({
        stdout: 'abc123\trefs/heads/feature/exists\n',
        stderr: '',
        exitCode: 0,
      }));

      const exists = await service.branchExists('feature/exists');
      expect(exists).toBe(true);
    });

    it('should return false if remote branch does not exist', async () => {
      mock.addResponsePattern(/git ls-remote/, () => ({
        stdout: '',
        stderr: '',
        exitCode: 0,
      }));

      const exists = await service.branchExists('feature/nope');
      expect(exists).toBe(false);
    });
  });

  describe('findBranchBySlug', () => {
    it('should match branch by slugified name (slash to hyphen)', async () => {
      mock.addResponsePattern(/git ls-remote/, () => ({
        stdout: [
          'abc123\trefs/heads/main',
          'def456\trefs/heads/claude/fix-software-defects-dlxzp',
          'ghi789\trefs/heads/feature/new-ui',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      }));

      const result = await service.findBranchBySlug('claude-fix-software-defects-dlxzp');
      expect(result).toBe('claude/fix-software-defects-dlxzp');
    });

    it('should return null when no branch slug matches', async () => {
      mock.addResponsePattern(/git ls-remote/, () => ({
        stdout: 'abc123\trefs/heads/main\ndef456\trefs/heads/develop\n',
        stderr: '',
        exitCode: 0,
      }));

      const result = await service.findBranchBySlug('claude-nonexistent-branch');
      expect(result).toBeNull();
    });

    it('should handle case-insensitive slug matching', async () => {
      mock.addResponsePattern(/git ls-remote/, () => ({
        stdout: 'abc123\trefs/heads/Claude/Fix-Login-ISSUE\n',
        stderr: '',
        exitCode: 0,
      }));

      const result = await service.findBranchBySlug('claude-fix-login-issue');
      expect(result).toBe('Claude/Fix-Login-ISSUE');
    });

    it('should return null on git command failure', async () => {
      mock.addResponsePattern(/git ls-remote/, () => ({
        stdout: '',
        stderr: 'fatal: error',
        exitCode: 128,
      }));

      const result = await service.findBranchBySlug('anything');
      expect(result).toBeNull();
    });
  });
});
