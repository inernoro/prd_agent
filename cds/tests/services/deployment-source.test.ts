import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { DeploymentSourcePreparationError, WorktreeService } from '../../src/services/worktree.js';
import { ShellExecutor } from '../../src/services/shell-executor.js';

const git = (args: string[], cwd: string) => execFileSync('/usr/bin/git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

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
      const sourceA = await service.prepareDeploymentSource('main', current, shaA);
      const sourceB = await service.prepareDeploymentSource('main', current);
      expect(sourceA.afterFull).toBe(shaA);
      expect(sourceB.afterFull).toBe(shaB);
      expect(sourceA.sourcePath).not.toBe(sourceB.sourcePath);
      expect(fs.readFileSync(path.join(sourceA.sourcePath, 'version.txt'), 'utf8')).toBe('A');
      expect(fs.readFileSync(path.join(sourceB.sourcePath, 'version.txt'), 'utf8')).toBe('B');
      expect(fs.readFileSync(path.join(current, 'version.txt'), 'utf8')).toBe('B');
      expect(git(['rev-parse', 'HEAD'], current)).toBe(shaB);
      await expect(service.prepareDeploymentSource('main', current, 'f'.repeat(40))).rejects.toThrow();
      expect(git(['rev-parse', 'HEAD'], current)).toBe(shaB);
      expect(fs.readFileSync(path.join(sourceA.sourcePath, 'version.txt'), 'utf8')).toBe('A');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['missing-worktree', 'missing-git', 'corrupt-git', 'external-missing',
    'missing-without-capability', 'escaped-managed', 'late-sentinel', 'late-empty', 'existing-empty',
    'owner-after-auth', 'owner-after-fetch', 'owner-before-dispatch', 'owner-before-add', 'owner-before-add-nonempty', 'owner-before-add-replaced', 'owner-after-add-retry', 'cleanup-on-prune', 'cleanup-on-add'] as const)(
    'LRU冷恢复仅重建缺失工作树并保留现存登记目录：%s', async scenario => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cds-source-cold-')));
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
      const worktreeBase = path.join(root, 'worktrees');
      const projectId = scenario === 'escaped-managed' ? '..' : 'default';
      const current = scenario === 'external-missing' ? path.join(root, 'external', 'main')
        : WorktreeService.worktreePathFor(worktreeBase, projectId, 'main');
      let cold = false, revoked = false, cleanupFaults = 0;
      const recovery = { kind: 'managed-missing' as const, worktreeBase, projectId, branchId: 'main',
        assertCurrent: () => { if (revoked) throw new Error('本次冷恢复资格已撤销'); } };
      const shell = new ShellExecutor();
      const commands: string[] = [];
      const afterRevocation: string[] = [];
      const cleanupFailure = Object.assign(new Error('本次任务进程清理尚未确认'), { code: 'cleanup' });
      const service = new WorktreeService({ exec: async (command, options) => {
        commands.push(command);
        if (cold && (scenario === 'cleanup-on-prune' && command === 'git worktree prune'
          || scenario === 'cleanup-on-add' && command.startsWith('git worktree add '))) {
          cleanupFaults++;
          throw cleanupFailure;
        }
        if (cold && scenario === 'owner-after-add-retry' && command.startsWith('git worktree add ')) {
          options?.beforeStart?.();
          return shell.exec("printf 'missing but already registered worktree\\n' >&2; exit 1", options);
        }
        if (cold && (scenario === 'owner-after-add-retry' && command === 'git worktree prune' && commands.filter(c => c === command).length === 2
          || scenario === 'owner-before-dispatch' && command === 'git worktree prune'
          || scenario.startsWith('owner-before-add') && command.startsWith('git worktree add '))) {
          revoked = true;
          if (scenario === 'owner-before-add-nonempty') fs.writeFileSync(path.join(current, 'sentinel.txt'), '保留写入');
          if (scenario === 'owner-before-add-replaced') { fs.renameSync(current, current + '.reserved'); fs.mkdirSync(current); }
          options?.beforeStart?.();
        }
        if (revoked && /^git (?:fetch|worktree (?:add|prune))/.test(command)) afterRevocation.push(command);
        const result = await shell.exec(command, {
          ...options, env: { ...options?.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
        });
        if (cold && scenario === 'owner-after-fetch' && command.startsWith('git fetch ')) revoked = true;
        return result;
      } }, async () => {
        if (cold && scenario.startsWith('late-')) {
          fs.mkdirSync(current);
          if (scenario === 'late-sentinel') fs.writeFileSync(path.join(current, 'sentinel.txt'), '陌生目录必须保留');
        }
        if (cold && scenario === 'owner-after-auth') revoked = true;
        return undefined;
      });
      await service.create(repo, 'main', current);

      if (scenario === 'missing-git' || scenario === 'corrupt-git') {
        const marker = path.join(current, 'marker.txt'); fs.writeFileSync(marker, '必须保留的挂载源码');
        fs.unlinkSync(path.join(current, '.git'));
        if (scenario === 'corrupt-git') fs.writeFileSync(path.join(current, '.git'), '损坏的登记文件');
        expect(git(['worktree', 'list', '--porcelain'], repo)).toContain(`worktree ${fs.realpathSync(current)}\n`);
        commands.length = 0;
        const failure = await service.prepareDeploymentSource('main', current, sha, repo, recovery).then(() => undefined, error => error);
        expect(fs.readFileSync(marker, 'utf8')).toBe('必须保留的挂载源码');
        expect(failure).toMatchObject({ code: 'deployment-worktree-unavailable' });
        expect(failure.message).not.toContain(current);
        expect(commands.some(command => /^(rm -rf|git worktree (add|prune))/.test(command))).toBe(false);
        return;
      }
      // 模拟 LRU 冷停：目录已被回收，Git 仍可能保留陈旧登记。
      fs.rmSync(current, { recursive: true, force: true });
      if (scenario.startsWith('cleanup-')) {
        cold = true; commands.length = 0;
        await expect(service.prepareDeploymentSource('main', current, sha, repo, recovery)).rejects.toBe(cleanupFailure);
        expect(cleanupFaults).toBe(1);
        const independentCommands: string[] = [];
        const independent = new WorktreeService({ exec: async (command, options) => {
          independentCommands.push(command); return shell.exec(command, options);
        } });
        await expect(independent.remove(repo, current)).rejects.toMatchObject({ code: 'worktree-held' });
        expect(independentCommands).toEqual([]);
        expect(fs.existsSync(current)).toBe(scenario === 'cleanup-on-add');
        return;
      }
      if (scenario === 'existing-empty') fs.mkdirSync(current);
      if (scenario.startsWith('late-') || scenario === 'existing-empty' || scenario.startsWith('owner-')) {
        cold = true; commands.length = 0;
        await expect(service.prepareDeploymentSource('main', current, sha, repo, recovery))
          .rejects.toMatchObject({ code: scenario === 'existing-empty'
            ? 'deployment-worktree-unavailable' : 'deployment-worktree-recovery-failed' });
        if (scenario.startsWith('owner-')) {
          expect(fs.existsSync(current)).toBe(scenario === 'owner-before-add-nonempty' || scenario === 'owner-before-add-replaced' || scenario === 'owner-after-add-retry');
          if (scenario === 'owner-before-add-nonempty') expect(fs.readFileSync(path.join(current, 'sentinel.txt'), 'utf8')).toBe('保留写入');
          if (scenario === 'owner-before-add-replaced') { expect(fs.readdirSync(current)).toEqual([]); expect(fs.existsSync(current + '.reserved')).toBe(true); }
          expect(afterRevocation).toEqual([]);
          if (scenario === 'owner-after-add-retry') { expect(fs.readdirSync(current)).toEqual([]); expect(commands.filter(c => c.startsWith('git worktree add '))).toHaveLength(1); }
          if (scenario === 'owner-before-add') {
            cold = false; revoked = false;
            const retry = await service.prepareDeploymentSource('main', current, sha, repo, recovery);
            expect(retry.afterFull).toBe(sha);
            expect(fs.readFileSync(path.join(retry.sourcePath, 'version.txt'), 'utf8')).toBe('cold-recovery');
          }
        } else {
          expect(fs.readdirSync(current)).toEqual(scenario === 'late-sentinel' ? ['sentinel.txt'] : []);
          if (scenario === 'late-sentinel') expect(fs.readFileSync(path.join(current, 'sentinel.txt'), 'utf8')).toBe('陌生目录必须保留');
          expect(commands.some(command => /^(rm -rf|git worktree (add|prune))/.test(command))).toBe(false);
        }
        return;
      }
      if (scenario === 'external-missing' || scenario === 'missing-without-capability' || scenario === 'escaped-managed') {
        commands.length = 0;
        await expect(service.prepareDeploymentSource('main', current, sha,
          scenario === 'missing-without-capability' ? undefined : repo,
          scenario === 'missing-without-capability' ? undefined : recovery)).rejects.toMatchObject({ code: 'deployment-worktree-unavailable' });
        expect(fs.existsSync(current)).toBe(false);
        expect(commands.some(command => /^(rm -rf|git worktree (add|prune))/.test(command))).toBe(false);
        return;
      }
      const prepared = await service.prepareDeploymentSource('main', current, sha, repo, recovery);

      expect(prepared.afterFull).toBe(sha);
      expect(fs.existsSync(current)).toBe(true);
      expect(git(['rev-parse', '--is-inside-work-tree'], current)).toBe('true');
      expect(fs.readFileSync(path.join(prepared.sourcePath, 'version.txt'), 'utf8')).toBe('cold-recovery');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 20000);

  it('分支格式错误与工作树不可用返回不同稳定错误码', async () => {
    const shell = new ShellExecutor();
    const service = new WorktreeService(shell);
    const invalid = await service.prepareDeploymentSource('bad..branch', process.cwd())
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
      const unavailable = await service.prepareDeploymentSource('main', unmanaged, undefined, repo)
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
        const recovery = { kind: 'managed-missing' as const, worktreeBase: base, branchId: 'main' };
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
          const prepared = await service.prepareDeploymentSource('main', alias, sha, repo, recovery);
          expect(prepared.afterFull).toBe(sha);
          expect(fs.readFileSync(path.join(prepared.sourcePath, 'version.txt'), 'utf8')).toBe('legacy-recovery');
          expect(fs.lstatSync(alias).isSymbolicLink()).toBe(scenario === 'live-owned');
          expect(git(['rev-parse', 'HEAD'], alias)).toBe(sha);
          if (scenario === 'broken-owned') expect(fs.existsSync(flat)).toBe(false);
          else expect(fs.readlinkSync(alias)).toBe(originalLink);
        } else {
          await expect(service.prepareDeploymentSource('main', alias, sha, repo, recovery))
            .rejects.toMatchObject({ code: 'deployment-worktree-unavailable' });
          expect(fs.readlinkSync(alias)).toBe(originalLink);
          if (scenario === 'live-unusable') expect(fs.readFileSync(path.join(flat, 'marker.txt'), 'utf8')).toBe('不能删除的活目录');
        }
        expect(fs.readFileSync(path.join(outside, 'marker.txt'), 'utf8')).toBe('不能修改外部目录');
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }, 20000,
  );
});
