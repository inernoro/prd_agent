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

  it.each(['missing-worktree', 'missing-git', 'corrupt-git'] as const)(
    'LRU冷恢复仅重建缺失工作树并保留现存登记目录：%s', async scenario => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cds-source-cold-')));
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
      const commands: string[] = [];
      const service = new WorktreeService({ exec: (command, options) => { commands.push(command); return shell.exec(command, {
        ...options, env: { ...options?.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      }); } });
      await service.create(repo, 'main', current);

      if (scenario !== 'missing-worktree') {
        const marker = path.join(current, 'marker.txt'); fs.writeFileSync(marker, '必须保留的挂载源码');
        fs.unlinkSync(path.join(current, '.git'));
        if (scenario === 'corrupt-git') fs.writeFileSync(path.join(current, '.git'), '损坏的登记文件');
        expect(git(['worktree', 'list', '--porcelain'], repo)).toContain(`worktree ${fs.realpathSync(current)}\n`);
        commands.length = 0;
        const failure = await service.prepareDeploymentSource(repo, 'main', current, sha).then(() => undefined, error => error);
        expect(fs.readFileSync(marker, 'utf8')).toBe('必须保留的挂载源码');
        expect(failure).toMatchObject({ code: 'deployment-worktree-unavailable' });
        expect(failure.message).not.toContain(current);
        expect(commands.some(command => /^(rm -rf|git worktree (add|prune))/.test(command))).toBe(false);
        return;
      }
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

  it.each(['broken-owned', 'live-owned', 'live-unusable', 'external-target', 'external-bucket', 'unregistered'] as const)(
    'FU-04迁移别名的真实Git归属与冷恢复：%s', async scenario => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cds-source-alias-')));
      const git = (args: string[], cwd: string) => execFileSync('/usr/bin/git', args, {
        cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      try {
        const remote = path.join(root, 'remote.git'); fs.mkdirSync(remote); git(['init', '--bare'], remote);
        const repo = path.join(root, 'repo'); git(['clone', remote, repo], root);
        git(['switch', '-c', 'main'], repo);
        git(['config', 'user.name', 'source-test'], repo);
        git(['config', 'user.email', 'source-test@example.invalid'], repo);
        fs.writeFileSync(path.join(repo, 'version.txt'), 'legacy-recovery');
        git(['add', '.'], repo); git(['commit', '-m', '旧布局恢复'], repo);
        git(['push', '-u', 'origin', 'main'], repo);
        const sha = git(['rev-parse', 'HEAD'], repo), base = path.join(root, 'worktrees');
        const flat = path.join(base, 'main'), alias = WorktreeService.worktreePathFor(base, undefined, 'main');
        const shell = new ShellExecutor();
        const service = new WorktreeService({ exec: (command, options) => shell.exec(command, {
          ...options, env: { ...options?.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
        }) });
        await service.create(repo, 'main', flat);
        let migratedPath = flat;
        expect(WorktreeService.migrateFlatLayoutIfNeeded({ worktreeBase: base, projectIds: [],
          branches: [{ id: 'main', worktreePath: flat }], currentVersion: undefined,
          updateBranchWorktreePath: (_id, next) => { migratedPath = next; }, markMigrated: () => {},
        })).toBe(1);
        expect(migratedPath).toBe(alias);
        expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
        expect(fs.readlinkSync(alias)).toBe(flat);
        expect(git(['worktree', 'list', '--porcelain'], repo)).toContain(`worktree ${flat}\n`);
        if (scenario !== 'live-owned') fs.rmSync(flat, { recursive: true, force: true });
        if (scenario === 'live-unusable') {
          fs.mkdirSync(flat); fs.writeFileSync(path.join(flat, 'marker.txt'), '不能删除的活目录');
        }
        const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, 'marker.txt'), '不能修改外部目录');
        if (scenario === 'external-target') {
          fs.unlinkSync(alias); fs.symlinkSync(path.join(outside, 'missing'), alias, 'dir');
        }
        if (scenario === 'external-bucket') {
          fs.renameSync(path.dirname(alias), path.join(outside, 'default'));
          fs.symlinkSync(path.join(outside, 'default'), path.dirname(alias), 'dir');
        }
        if (scenario === 'unregistered') git(['worktree', 'prune'], repo);
        const originalLink = fs.readlinkSync(alias);
        if (scenario === 'broken-owned' || scenario === 'live-owned') {
          const prepared = await service.prepareDeploymentSource(repo, 'main', alias, sha);
          expect(prepared.afterFull).toBe(sha);
          expect(fs.readFileSync(path.join(prepared.sourcePath, 'version.txt'), 'utf8')).toBe('legacy-recovery');
          expect(fs.lstatSync(alias).isSymbolicLink()).toBe(scenario === 'live-owned');
          expect(git(['rev-parse', 'HEAD'], alias)).toBe(sha);
          if (scenario === 'broken-owned') expect(fs.existsSync(flat)).toBe(false);
          else expect(fs.readlinkSync(alias)).toBe(originalLink);
        } else {
          await expect(service.prepareDeploymentSource(repo, 'main', alias, sha))
            .rejects.toMatchObject({ code: 'deployment-worktree-unavailable' });
          expect(fs.readlinkSync(alias)).toBe(originalLink);
          if (scenario === 'live-unusable') expect(fs.readFileSync(path.join(flat, 'marker.txt'), 'utf8')).toBe('不能删除的活目录');
        }
        expect(fs.readFileSync(path.join(outside, 'marker.txt'), 'utf8')).toBe('不能修改外部目录');
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }, 20000,
  );
});
