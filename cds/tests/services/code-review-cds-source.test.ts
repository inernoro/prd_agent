import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorktreeService } from '../../src/services/worktree.js';
import { ShellExecutor } from '../../src/services/shell-executor.js';
import { codeReviewRepositoryRoot, readCodeReviewSnapshot } from '../../src/services/code-review-source.js';
import type { IShellExecutor } from '../../src/types.js';

let root = '';
afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

describe('CDS 分支的真实 Git 源码快照', () => {
  it.each(['export-ignore', 'export-subst'])('导出属性不能静默遗漏或改变已选择的提交源码：%s', async (attribute) => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-review-attributes-'));
    const origin = path.join(root, 'origin.git'), repo = path.join(root, 'repo');
    const git = (args: string[], cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(['init', '--bare', origin]); git(['clone', origin, repo]);
    git(['config', 'user.email', 'fixture@example.invalid'], repo); git(['config', 'user.name', 'Local fixture'], repo);
    git(['checkout', '-b', 'main'], repo);
    await fs.mkdir(path.join(repo, 'tests'));
    await fs.writeFile(path.join(repo, 'main.py'), 'print("selected main")\n');
    const selectedSource = 'revision = "$Format:%H$"\n';
    await fs.writeFile(path.join(repo, 'tests/security.py'), selectedSource);
    await fs.writeFile(path.join(repo, '.gitattributes'), `tests/security.py ${attribute}\n`);
    git(['add', '.'], repo); git(['commit', '-m', '固定导出属性反例'], repo); git(['push', 'origin', 'main'], repo);
    const commit = git(['rev-parse', 'HEAD'], repo);
    const real = new ShellExecutor();
    const shell: IShellExecutor = { exec: real.exec.bind(real), execBackgroundObservation: async (command, options) => real.exec(command, options) };
    const service = new WorktreeService(shell);
    const control = { signal: new AbortController().signal, assertCurrent: () => undefined };
    await expect(service.exportCodeReviewSnapshot(repo, 'main', [], control)).rejects.toThrow('源码快照与所选提交不一致');
    // Explicit source exclusions remain valid; an archive attribute is not an exclusion policy.
    const captured = await service.exportCodeReviewSnapshot(repo, 'main', ['tests'], control);
    expect(captured.commitSha).toBe(commit);
    expect(captured.skippedFiles).toBe(2);
    const verified = await readCodeReviewSnapshot(captured.zip, [], false);
    expect(verified.files.map(file => file.name)).toEqual(['main.py']);
    expect(verified.files[0].data.toString()).toBe('print("selected main")\n');
    expect(git(['show', 'HEAD:tests/security.py'], repo)).toBe(selectedSource.trim());
    expect(git(['status', '--porcelain'], repo)).toBe('');
  }, 15_000);
  it('兼容未保留 legacy 标记的旧项目，仅明确的实例归属可使用全局根，否则读取自己的受管工作树', () => {
    const project = { id: 'existing' }, branch = { projectId: 'existing', worktreePath: '/managed/existing/main' };
    expect(codeReviewRepositoryRoot(project, branch, '/global/root', 'existing')).toBe('/global/root');
    expect(codeReviewRepositoryRoot(project, branch, '/global/root', 'other')).toBe('/managed/existing/main');
    expect(codeReviewRepositoryRoot({ ...project, repoPath: '/project/repository' }, branch, '/global/root', 'other')).toBe('/project/repository');
    expect(() => codeReviewRepositoryRoot(project, { ...branch, worktreePath: '' }, '/global/root', 'other')).toThrow('尚未同步');
    expect(() => codeReviewRepositoryRoot(project, { ...branch, projectId: 'other' }, '/global/root', 'existing')).toThrow('不属于当前项目');
  });
  it('同步所选分支并固定 SHA，保留路径，跳过依赖与凭据，不改工作树也不运行项目脚本或 Git hooks', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "cds-review-'source-"));
    const origin = path.join(root, 'origin.git'), repo = path.join(root, 'repo'), marker = path.join(root, 'executed');
    const git = (args: string[], cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(['init', '--bare', origin]); git(['clone', origin, repo]);
    git(['config', 'user.email', 'fixture@example.invalid'], repo); git(['config', 'user.name', 'Local fixture'], repo);
    git(['checkout', '-b', 'main'], repo);
    await fs.mkdir(path.join(repo, 'src'));
    await fs.writeFile(path.join(repo, 'src/index.ts'), 'export const revision = "main";');
    await fs.writeFile(path.join(repo, 'src/path\'$(touch nope).ts'), 'export const literalPath = true;');
    await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({ scripts: { install: `touch ${marker}` } }));
    await fs.writeFile(path.join(repo, '.env'), 'MUST_NOT_LEAVE_REPOSITORY=private');
    await fs.mkdir(path.join(repo, 'vendor')); await fs.writeFile(path.join(repo, 'vendor/a.ts'), 'vendor');
    await fs.writeFile(path.join(repo, 'poster.png'), 'binary asset');
    git(['add', '.'], repo); git(['commit', '-m', '基础提交'], repo); git(['push', 'origin', 'main'], repo);
    const main = git(['rev-parse', 'HEAD'], repo);
    git(['checkout', '-b', 'feature/review'], repo);
    await fs.writeFile(path.join(repo, 'src/index.ts'), 'export const revision = "selected branch";');
    git(['add', '.'], repo); git(['commit', '-m', '所选分支'], repo); git(['push', 'origin', 'feature/review'], repo);
    const selected = git(['rev-parse', 'HEAD'], repo);
    git(['checkout', 'main'], repo);
    // The tracking ref is deliberately stale; capture must fetch the chosen branch.
    git(['update-ref', 'refs/remotes/origin/feature/review', main], repo);
    await fs.writeFile(path.join(repo, 'src/index.ts'), 'dirty worktree must not be audited');
    await fs.writeFile(path.join(repo, 'src/untracked.ts'), 'untracked must not be audited');
    await fs.mkdir(path.join(repo, '.git/hooks'), { recursive: true });
    await fs.writeFile(path.join(repo, '.git/hooks/reference-transaction'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    const real = new ShellExecutor();
    const shell: IShellExecutor = { exec: real.exec.bind(real), execBackgroundObservation: async (command, options) => {
      options?.signal?.throwIfAborted(); options?.beforeStart?.();
      return real.exec(command, options);
    } };
    const authorization = vi.fn(async () => ({ CDS_FIXTURE_AUTH: 'existing-project-authorization' }));
    const service = new WorktreeService(shell, authorization);
    const captured = await service.exportCodeReviewSnapshot(repo, 'feature/review', [], { signal: new AbortController().signal, assertCurrent: () => undefined });
    const snapshot = await readCodeReviewSnapshot(captured.zip, [], false);
    expect(captured.commitSha).toBe(selected); expect(captured.skippedFiles).toBe(3);
    expect(snapshot.files.map(file => file.name).sort()).toEqual(['package.json', 'src/index.ts', 'src/path\'$(touch nope).ts']);
    expect(snapshot.files.find(file => file.name === 'src/index.ts')?.data.toString()).toContain('selected branch');
    expect(git(['rev-parse', 'HEAD'], repo)).toBe(main);
    expect(await fs.readFile(path.join(repo, 'src/index.ts'), 'utf8')).toContain('dirty worktree');
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(repo, 'nope'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(authorization).toHaveBeenCalledWith(repo);
    await expect(service.exportCodeReviewSnapshot(repo, 'feature/review', [], { signal: AbortSignal.abort(), assertCurrent: () => undefined })).rejects.toThrow();
  }, 15_000);
});
