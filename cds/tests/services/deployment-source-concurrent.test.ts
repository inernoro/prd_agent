import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { WorktreeService } from '../../src/services/worktree.js';
import { ShellExecutor } from '../../src/services/shell-executor.js';
import type { IShellExecutor } from '../../src/types.js';

describe('实际不同服务并行准备独立源码', () => {
  it.each(['warm', 'cold'] as const)('同一分支的A/B目标同时准备均成功，不修改旧目录或串用对方提交：%s', async scenario => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-source-concurrent-'));
    const git = (args: string[], cwd: string) => execFileSync('/usr/bin/git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    try {
      const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
      git(['init', '--initial-branch=main'], repo);
      git(['config', 'user.name', 'source-test'], repo); git(['config', 'user.email', 'source-test@example.invalid'], repo);
      fs.writeFileSync(path.join(repo, 'version.txt'), 'A'); git(['add', '.'], repo); git(['commit', '-m', '版本A'], repo);
      const shaA = git(['rev-parse', 'HEAD'], repo);
      fs.writeFileSync(path.join(repo, 'version.txt'), 'B'); git(['commit', '-am', '版本B'], repo);
      const shaB = git(['rev-parse', 'HEAD'], repo), current = path.join(root, 'current');
      git(['clone', repo, current], root);
      const shell = new ShellExecutor(); let metadataActive = 0, metadataOverlap = false, firstAdd = true;
      const target = scenario === 'cold' ? path.join(root, 'worktrees', 'main') : current;
      let missingReads = 0, resume = () => {};
      const bothMissing = new Promise<void>(resolve => { resume = resolve; });
      const actual: IShellExecutor = { exec: async (command, options) => {
        const metadata = /^git (?:fetch|worktree (?:add|prune|remove))/.test(command);
        if (metadata) { metadataActive++; if (metadataActive > 1) metadataOverlap = true; }
        try {
          // 保留原真实 add 在途窗口，同时验证 warm/cold 的共享元数据队列。
          if (command.startsWith('git worktree add') && firstAdd) { firstAdd = false; await new Promise(resolve => setTimeout(resolve, 100)); }
          const result = await shell.exec(command, options);
          // 两实例都真实观察到同一缺失目标，再继续原恢复路径，不模拟 Git 的结果。
          if (scenario === 'cold' && command === 'git rev-parse HEAD' && options?.cwd === target && missingReads < 2) {
            if (++missingReads === 2) resume(); await bothMissing;
          }
          return result;
        } finally { if (metadata) metadataActive--; }
      } };
      const first = new WorktreeService(actual), second = new WorktreeService(actual);
      if (scenario === 'cold') { await first.create(current, 'main', target); fs.rmSync(target, { recursive: true, force: true }); }
      const secondSha = scenario === 'cold' ? shaA : shaB;
      const results = await Promise.allSettled([first.prepareDeploymentSource(current, 'main', target, shaA),
        second.prepareDeploymentSource(current, 'main', target, secondSha)]);
      console.info(JSON.stringify({ concurrentResults: results.map(r => r.status === 'fulfilled'
        ? { status: r.status, target: r.value.afterFull } : { status: r.status, reason: r.reason?.message }) }));
      expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(metadataOverlap, 'same repository metadata mutations must not overlap across service instances').toBe(false);
      if (results[0].status !== 'fulfilled' || results[1].status !== 'fulfilled') throw new Error('Parallel owned preparation failed');
      const a = results[0].value, b = results[1].value;
      expect(a.afterFull).toBe(shaA); expect(b.afterFull).toBe(secondSha); expect(a.sourcePath).not.toBe(b.sourcePath);
      expect(fs.readFileSync(path.join(a.sourcePath, 'version.txt'), 'utf8')).toBe('A');
      expect(fs.readFileSync(path.join(b.sourcePath, 'version.txt'), 'utf8')).toBe(scenario === 'cold' ? 'A' : 'B');
      expect(git(['rev-parse', 'HEAD'], target)).toBe(shaB);
      expect(git(['rev-parse', 'HEAD'], current)).toBe(shaB);
      expect(fs.readFileSync(path.join(current, 'version.txt'), 'utf8')).toBe('B');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 20000);
});
