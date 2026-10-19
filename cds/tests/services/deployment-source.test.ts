import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { WorktreeService } from '../../src/services/worktree.js';
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
});
