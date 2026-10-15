import { describe, expect, it } from 'vitest';
import { WorktreeService } from '../../src/services/worktree.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';

const B = 'b'.repeat(40);
const BRANCH = 'codex/owned-express';
function fixture(stdout = `${B}\trefs/heads/${BRANCH}\n`, exitCode = 0) {
  const shell = new MockShellExecutor();
  shell.addResponsePattern(/git ls-remote/, () => ({ stdout, stderr: '', exitCode }));
  return { shell, worktree: new WorktreeService(shell) };
}

describe('未指定提交的远端目标解析', () => {
  it('只认当前远端完整分支B，缓存、跟踪引用和服务目录都不能代替远端事实', async () => {
    const { shell, worktree } = fixture();
    expect(await worktree.resolveLatestRemoteHead('/owned/repo', BRANCH)).toBe(B);
    expect(shell.commands).toHaveLength(1);
    expect(shell.commands[0]).toContain(`refs/heads/${BRANCH}`);
    expect(shell.commands[0]).not.toMatch(/fetch|reset|checkout|worktree add|docker/);
  });

  it.each([
    ['', 0], [`${B.slice(0, 7)}\trefs/heads/${BRANCH}\n`, 0],
    [`${B}\trefs/heads/main\n`, 0],
    [`${B}\trefs/heads/${BRANCH}\n${'c'.repeat(40)}\trefs/heads/${BRANCH}\n`, 0],
    [`${B}\trefs/heads/${BRANCH}\n`, 128],
  ])('身份缺失、含糊或查询失败都不可回退旧提交：%s', async (stdout, code) => {
    const { worktree } = fixture(stdout, code);
    await expect(worktree.resolveLatestRemoteHead('/owned/repo', BRANCH)).rejects.toThrow();
  });

  it('预先取消时不发起Git，危险分支值不能进入命令', async () => {
    const { shell, worktree } = fixture();
    const controller = new AbortController(); controller.abort();
    await expect(worktree.resolveLatestRemoteHead('/owned/repo', BRANCH, controller.signal)).rejects.toThrow();
    await expect(worktree.resolveLatestRemoteHead('/owned/repo', '--upload-pack=bad')).rejects.toThrow();
    expect(shell.commands).toEqual([]);
  });

  it('沿用仓库鉴权，读前后资格检查和有界执行超时均可观察', async () => {
    const { shell, worktree } = fixture(); let checks = 0;
    worktree.setGitEnvProvider(async () => ({ GIT_TERMINAL_PROMPT: '0' }));
    shell.addResponsePatternFirst(/git ls-remote/, (_match, options) => {
      expect(options?.cwd).toBe('/owned/repo');
      expect(options?.timeout).toBeGreaterThan(0); expect(options?.timeout).toBeLessThanOrEqual(15_000);
      expect(options?.env?.GIT_TERMINAL_PROMPT).toBe('0');
      return { stdout: `${B}\trefs/heads/${BRANCH}\n`, stderr: '', exitCode: 0 };
    });
    expect(await worktree.resolveLatestRemoteHead('/owned/repo', BRANCH, undefined, () => { checks++; })).toBe(B);
    expect(checks).toBeGreaterThanOrEqual(2);
  });
});
