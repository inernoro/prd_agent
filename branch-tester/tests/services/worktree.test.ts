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
      mock.addResponsePattern(/git worktree add/, () => ({ stdout: 'Preparing worktree', stderr: '', exitCode: 0 }));

      await service.create('feature/new-ui', '/tmp/wt/feature-new-ui');
      expect(mock.commands[0]).toContain('git fetch');
      expect(mock.commands[1]).toContain('git worktree add');
      expect(mock.commands[1]).toContain('/tmp/wt/feature-new-ui');
      expect(mock.commands[1]).toContain('origin/feature/new-ui');
    });

    it('should throw if fetch fails', async () => {
      mock.addResponsePattern(/git fetch/, () => ({
        stdout: '',
        stderr: 'fatal: remote error',
        exitCode: 128,
      }));

      await expect(service.create('bad-branch', '/tmp/wt/bad')).rejects.toThrow('fetch');
    });

    it('should throw if worktree add fails', async () => {
      mock.addResponsePattern(/git fetch/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/git worktree add/, () => ({
        stdout: '',
        stderr: 'fatal: already exists',
        exitCode: 128,
      }));

      await expect(service.create('dup', '/tmp/wt/dup')).rejects.toThrow('worktree');
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
});
