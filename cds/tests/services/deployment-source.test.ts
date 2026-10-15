import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { DeploymentSourcePreparationError, WorktreeService } from '../../src/services/worktree.js';
import { ShellExecutor } from '../../src/services/shell-executor.js';

describe('真实Git部署源码隔离', () => {
  it('指定A提交时复制A，未点名时复制HEAD B，两次准备均不修改旧运行目录', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-source-'));
    const git = (args: string[], cwd: string) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
      git(['init', '--initial-branch=main'], repo);
      git(['config', 'user.name', 'source-test'], repo);
      git(['config', 'user.email', 'source-test@example.invalid'], repo);
      fs.writeFileSync(path.join(repo, 'version.txt'), 'A');
      git(['add', '.'], repo); git(['commit', '-m', '版本A'], repo);
      const shaA = git(['rev-parse', 'HEAD'], repo);
      fs.writeFileSync(path.join(repo, 'version.txt'), 'B');
      git(['commit', '-am', '版本B'], repo);
      const shaB = git(['rev-parse', 'HEAD'], repo);
      const current = path.join(root, 'current');
      git(['clone', repo, current], root);
      const shell = new ShellExecutor();
      const service = new WorktreeService({ exec: (command, options) => shell.exec(command, {
        ...options, env: { ...options?.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      }) });
      const sourceA = await service.prepareDeploymentSource(current, 'main', current, shaA);
      const sourceB = await service.prepareDeploymentSource(current, 'main', current);
      expect(sourceA.afterFull).toBe(shaA);
      expect(sourceB.afterFull).toBe(shaB);
      expect(sourceA.sourcePath).not.toBe(sourceB.sourcePath);
      expect(fs.readFileSync(path.join(sourceA.sourcePath, 'version.txt'), 'utf8')).toBe('A');
      expect(fs.readFileSync(path.join(sourceB.sourcePath, 'version.txt'), 'utf8')).toBe('B');
      expect(fs.readFileSync(path.join(current, 'version.txt'), 'utf8')).toBe('B');
      expect(git(['rev-parse', 'HEAD'], current)).toBe(shaB);
      await expect(service.prepareDeploymentSource(current, 'main', current, 'f'.repeat(40))).rejects.toThrow();
      expect(git(['rev-parse', 'HEAD'], current)).toBe(shaB);
      expect(fs.readFileSync(path.join(sourceA.sourcePath, 'version.txt'), 'utf8')).toBe('A');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('LRU回收分支工作树后从仓库根重建并继续准备部署源码', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-source-cold-'));
    const git = (args: string[], cwd: string) => execFileSync('/usr/bin/git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    try {
      const remote = path.join(root, 'remote.git');
      fs.mkdirSync(remote);
      git(['init', '--bare'], remote);
      const repo = path.join(root, 'repo');
      git(['clone', remote, repo], root);
      git(['switch', '-c', 'main'], repo);
      git(['config', 'user.name', 'source-test'], repo);
      git(['config', 'user.email', 'source-test@example.invalid'], repo);
      fs.writeFileSync(path.join(repo, 'version.txt'), 'cold-recovery');
      git(['add', '.'], repo);
      git(['commit', '-m', '冷分支恢复'], repo);
      git(['push', '-u', 'origin', 'main'], repo);
      const sha = git(['rev-parse', 'HEAD'], repo);
      const current = path.join(root, 'worktrees', 'main');
      const shell = new ShellExecutor();
      const service = new WorktreeService({ exec: (command, options) => shell.exec(command, {
        ...options, env: { ...options?.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      }) });
      await service.create(repo, 'main', current);

      // 模拟 LRU 冷停：目录已被回收，Git 仍可能保留陈旧登记。
      fs.rmSync(current, { recursive: true, force: true });
      const prepared = await service.prepareDeploymentSource(repo, 'main', current, sha);

      expect(prepared.afterFull).toBe(sha);
      expect(git(['rev-parse', '--is-inside-work-tree'], current)).toBe('true');
      expect(fs.readFileSync(path.join(prepared.sourcePath, 'version.txt'), 'utf8')).toBe('cold-recovery');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 20000);

  it('分支格式错误与工作树不可用返回不同稳定错误码', async () => {
    const shell = new ShellExecutor();
    const service = new WorktreeService(shell);
    const invalid = await service.prepareDeploymentSource(process.cwd(), 'bad..branch', process.cwd())
      .then(() => undefined, error => error as DeploymentSourcePreparationError);
    expect(invalid).toBeInstanceOf(DeploymentSourcePreparationError);
    expect(invalid?.code).toBe('invalid-branch-ref');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-source-unmanaged-'));
    try {
      const repo = path.join(root, 'repo');
      const unmanaged = path.join(root, 'unmanaged');
      fs.mkdirSync(repo);
      fs.mkdirSync(unmanaged);
      execFileSync('/usr/bin/git', ['init', '--initial-branch=main'], { cwd: repo });
      const unavailable = await service.prepareDeploymentSource(repo, 'main', unmanaged)
        .then(() => undefined, error => error as DeploymentSourcePreparationError);
      expect(unavailable).toBeInstanceOf(DeploymentSourcePreparationError);
      expect(unavailable?.code).toBe('deployment-worktree-unavailable');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
