import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IsolatedShellExecutor } from '../../src/services/isolated-shell-executor.js';
import { ShellExecutor } from '../../src/services/shell-executor.js';
import { SelfMaintenanceRuntime } from '../../src/services/self-maintenance-runtime.js';
import { shellQuote } from '../../src/services/sidecar/sidecar-deployer.js';
import type { ExecAssignment } from '../../src/types.js';
import {
  parseGitHubRepoFullName,
  replaceDirectoriesAtomically,
  validateWebDistCandidate,
  WEB_DIST_BUILD_COMMAND,
} from '../../src/routes/branches.js';

const tmpRoots: string[] = [];
const ownedResources: Array<{ runtime: SelfMaintenanceRuntime; operation: IsolatedShellExecutor }> = [];
type OwnedRemoval = { assertActive(): void; remove(directory: string): Promise<boolean> };
// 旧函数能合法忽略额外参数，让tests-first验证行为而非新接口是否已存在。
const ownedSwap = replaceDirectoriesAtomically as (
  pairs: Parameters<typeof replaceDirectoriesAtomically>[0], removal: OwnedRemoval,
) => void | Promise<void>;

function makeTmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-prebuilt-helpers-'));
  tmpRoots.push(dir);
  return dir;
}

function writeMarker(dir: string, value: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'marker.txt'), value);
}

function readMarker(dir: string): string {
  return fs.readFileSync(path.join(dir, 'marker.txt'), 'utf8');
}

afterEach(async () => {
  for (const resource of ownedResources.splice(0)) {
    await resource.runtime.close();
    await resource.operation.close();
  }
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('parseGitHubRepoFullName', () => {
  it('解析常见 GitHub remote 和 owner/repo 输入', () => {
    expect(parseGitHubRepoFullName('inernoro/prd_agent')).toBe('inernoro/prd_agent');
    expect(parseGitHubRepoFullName('git@github.com:inernoro/prd_agent.git')).toBe('inernoro/prd_agent');
    expect(parseGitHubRepoFullName('https://github.com/inernoro/prd_agent.git')).toBe('inernoro/prd_agent');
    expect(parseGitHubRepoFullName('https://github.com/inernoro/prd_agent.git?x=1')).toBe('inernoro/prd_agent');
  });

  it('拒绝非 owner/repo 形态', () => {
    expect(parseGitHubRepoFullName('prd_agent')).toBeNull();
    expect(parseGitHubRepoFullName('inernoro/prd_agent/extra')).toBeNull();
    expect(parseGitHubRepoFullName('https://example.com/inernoro/prd_agent.git')).toBeNull();
    expect(parseGitHubRepoFullName('')).toBeNull();
    expect(parseGitHubRepoFullName(undefined)).toBeNull();
  });
});

describe('replaceDirectoriesAtomically', () => {
  it('显式owned模式在真实换代后等待归属删除，不在Master递归清理', async () => {
    const root = makeTmpRoot();
    const currentA = path.join(root, 'dist'), nextA = path.join(root, 'dist.next');
    const currentB = path.join(root, 'web-dist'), nextB = path.join(root, 'web-dist.next');
    const previous = path.join(root, 'web-dist.previous');
    writeMarker(currentA, 'old-a'); writeMarker(nextA, 'new-a');
    writeMarker(currentB, 'old-b'); writeMarker(nextB, 'new-b');
    writeMarker(previous, 'previous-b');
    const operation = new IsolatedShellExecutor(new ShellExecutor(), { isolatedLane: 'operation', concurrency: 1 });
    const runtime = new SelfMaintenanceRuntime(operation, root, () => {});
    ownedResources.push({ runtime, operation });
    const ticket = runtime.acquire({ source: 'self-update', actor: 'atomic-fixture' })!;
    const deadline = performance.now() + 15 * 60_000;
    const assignments: ExecAssignment[] = [], removed: string[] = [], masterDeletes: string[] = [];
    const originalRemove = fs.rmSync;
    const removalSpy = vi.spyOn(fs, 'rmSync').mockImplementation((directory, options) => {
      if (String(directory).startsWith(root + path.sep) && options?.recursive) masterDeletes.push(String(directory));
      return originalRemove(directory, options);
    });
    try {
      await ownedSwap([
        { currentPath: currentA, nextPath: nextA },
        { currentPath: currentB, nextPath: nextB, previousPath: previous },
      ], {
        assertActive() {
          const state = runtime.observe();
          if (state?.id !== ticket.id || state.stopRequested || state.unconfirmedJobCount || performance.now() >= deadline) {
            throw new Error('本票已停止，不能继续原子换代');
          }
        },
        async remove(directory) {
          const timeout = Math.ceil(deadline - performance.now());
          if (timeout <= 0) throw new Error('原阶段预算已耗尽');
          const result = await runtime.exec(ticket, `rm -rf -- ${shellQuote(directory)}`, {
            timeout, onAssigned: assignment => assignments.push(assignment),
          });
          if (result.exitCode === 0) removed.push(directory);
          return result.exitCode === 0;
        },
      });
      expect(readMarker(currentA)).toBe('new-a'); expect(readMarker(currentB)).toBe('new-b');
      expect(readMarker(previous)).toBe('old-b');
      expect(fs.existsSync(nextA)).toBe(false); expect(fs.existsSync(nextB)).toBe(false);
      expect(fs.readdirSync(root).sort()).toEqual(['dist', 'web-dist', 'web-dist.previous']);
      expect.soft(masterDeletes).toEqual([]);
      expect.soft(removed).toHaveLength(2);
      expect.soft(assignments).toHaveLength(2);
      for (const assignment of assignments) {
        expect(assignment.lane).toBe('operation');
        expect(assignment.factoryPid).toBeGreaterThan(1);
        expect(assignment.actorPid).toBeGreaterThan(1);
      }
      expect(runtime.observe()).toMatchObject({ activeJobCount: 0, unconfirmedJobCount: 0 });
      expect(runtime.finish(ticket)).toBe(true);
    } finally {
      removalSpy.mockRestore();
    }
  });

  it('同时替换两个目录并清理 staging', () => {
    const root = makeTmpRoot();
    const currentA = path.join(root, 'dist');
    const currentB = path.join(root, 'web-dist');
    const nextA = path.join(root, 'next-dist');
    const nextB = path.join(root, 'next-web-dist');
    writeMarker(currentA, 'old-a');
    writeMarker(currentB, 'old-b');
    writeMarker(nextA, 'new-a');
    writeMarker(nextB, 'new-b');

    replaceDirectoriesAtomically([
      { currentPath: currentA, nextPath: nextA },
      { currentPath: currentB, nextPath: nextB },
    ]);

    expect(readMarker(currentA)).toBe('new-a');
    expect(readMarker(currentB)).toBe('new-b');
    expect(fs.existsSync(nextA)).toBe(false);
    expect(fs.existsSync(nextB)).toBe(false);
  });

  it('owned删除的真实写者停止确认后才返回，取消不吞掉或继续第二份清理', async () => {
    const root = makeTmpRoot(), marker = path.join(root, 'writer');
    const currentA = path.join(root, 'dist'), nextA = path.join(root, 'dist.next');
    const currentB = path.join(root, 'web-dist'), nextB = path.join(root, 'web-dist.next');
    writeMarker(currentA, 'old-a'); writeMarker(nextA, 'new-a');
    writeMarker(currentB, 'old-b'); writeMarker(nextB, 'new-b');
    const operation = new IsolatedShellExecutor(new ShellExecutor(), { isolatedLane: 'operation', concurrency: 1 });
    const runtime = new SelfMaintenanceRuntime(operation, root, () => {});
    ownedResources.push({ runtime, operation });
    const ticket = runtime.acquire({ source: 'self-force-sync', actor: 'atomic-cancel-fixture' })!;
    const deadline = performance.now() + 15 * 60_000;
    let ready!: () => void, output = '', writerPid = 0;
    let writerAssignment: ExecAssignment | undefined;
    const entered = new Promise<void>(resolve => { ready = resolve; });
    const removals: string[] = [];
    const pending = ownedSwap([
      { currentPath: currentA, nextPath: nextA }, { currentPath: currentB, nextPath: nextB },
    ], {
      assertActive() {
        const state = runtime.observe();
        if (state?.id !== ticket.id || state.stopRequested || state.unconfirmedJobCount || performance.now() >= deadline) {
          throw new Error('本票已停止，不能继续原子换代');
        }
      },
      async remove(directory) {
        removals.push(directory);
        const source = `const fs=require('node:fs');fs.rmSync(${JSON.stringify(directory)},{recursive:true,force:true});fs.appendFileSync(${JSON.stringify(marker)},'x');process.stdout.write('cleanup-held:'+process.pid+'\\n');setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'x'),10);`;
        const timeout = Math.ceil(deadline - performance.now());
        if (timeout <= 0) throw new Error('原阶段预算已耗尽');
        // writer就是actor持有并等待close/reap的child，不依赖各平台sh是否优化最后一条外部命令。
        const result = await runtime.exec(ticket, `exec ${shellQuote(process.execPath)} --eval ${shellQuote(source)}`, {
          timeout, onAssigned: assignment => { writerAssignment = assignment; }, onData: chunk => {
            output += chunk;
            const match = output.match(/cleanup-held:(\d+)\n/);
            if (match) { writerPid = Number(match[1]); ready(); }
          },
        });
        return result.exitCode === 0;
      },
    });
    const stopped = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    try {
      await entered;
      expect(writerPid).toBeGreaterThan(1);
      expect(removals).toHaveLength(1);
      expect(fs.existsSync(removals[0])).toBe(false);
      expect(runtime.observe()).toMatchObject({ activeJobCount: 1, unconfirmedJobCount: 0 });
      runtime.requestStop(ticket);
      expect(runtime.finish(ticket)).toBe(false);
      await stopped;
      expect(removals).toHaveLength(1);
      expect(readMarker(currentA)).toBe('new-a'); expect(readMarker(currentB)).toBe('new-b');
      const remaining = fs.readdirSync(root).filter(name => name.startsWith('web-dist.old.'));
      expect(remaining).toHaveLength(1);
      expect(readMarker(path.join(root, remaining[0]))).toBe('old-b');
      let probeError: unknown;
      try { process.kill(writerPid, 0); } catch (error) { probeError = error; }
      // 固定首次probe结果后才取自身PID证据，不等一轮再重判，也不把kill0成功直接等同仍有writer。
      const ownLinuxState = (pid: number | undefined) => {
        if (process.platform !== 'linux' || !pid) return null;
        try {
          const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
          const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
          return { pid, state: fields[0], ppid: Number(fields[1]), group: Number(fields[2]), startTime: fields[19] };
        } catch (error) { return { pid, error: (error as NodeJS.ErrnoException).code }; }
      };
      console.info('[cds-atomic-owned-cancel-receipt]', { platform: process.platform, testPid: process.pid,
        writerPid, assignment: writerAssignment, probeCode: (probeError as NodeJS.ErrnoException | undefined)?.code ?? null,
        writer: ownLinuxState(writerPid), actor: ownLinuxState(writerAssignment?.actorPid),
        markerBytes: fs.statSync(marker).size, maintenance: runtime.observe() });
      expect(probeError).toMatchObject({ code: 'ESRCH' });
      expect(runtime.observe()).toMatchObject({ activeJobCount: 0, unconfirmedJobCount: 0, stopRequested: true });
      expect(runtime.finish(ticket)).toBe(true);
      const bytes = fs.readFileSync(marker, 'utf8');
      const successor = runtime.acquire({ source: 'self-update-dry-run', actor: 'successor' })!;
      expect((await runtime.exec(successor, 'printf successor')).stdout).toBe('successor');
      expect(fs.readFileSync(marker, 'utf8')).toBe(bytes);
      expect(runtime.finish(successor)).toBe(true);
    } finally {
      if (runtime.observe()?.id === ticket.id) runtime.requestStop(ticket);
      await Promise.resolve(pending).catch(() => {});
    }
  });

  it('第二个目录替换失败时回滚第一个目录', () => {
    const root = makeTmpRoot();
    const currentA = path.join(root, 'dist');
    const currentB = path.join(root, 'web-dist');
    const nextA = path.join(root, 'next-dist');
    const missingNextB = path.join(root, 'missing-web-dist');
    writeMarker(currentA, 'old-a');
    writeMarker(currentB, 'old-b');
    writeMarker(nextA, 'new-a');

    expect(() => replaceDirectoriesAtomically([
      { currentPath: currentA, nextPath: nextA },
      { currentPath: currentB, nextPath: missingNextB },
    ])).toThrow();

    expect(readMarker(currentA)).toBe('old-a');
    expect(readMarker(currentB)).toBe('old-b');
  });

  it('owned普通删除非零只保留安全旧备份，仍按原合同清理下一份', async () => {
    const root = makeTmpRoot();
    const currentA = path.join(root, 'dist'), nextA = path.join(root, 'dist.next');
    const currentB = path.join(root, 'web-dist'), nextB = path.join(root, 'web-dist.next');
    writeMarker(currentA, 'old-a'); writeMarker(nextA, 'new-a');
    writeMarker(currentB, 'old-b'); writeMarker(nextB, 'new-b');
    const operation = new IsolatedShellExecutor(new ShellExecutor(), { isolatedLane: 'operation', concurrency: 1 });
    const runtime = new SelfMaintenanceRuntime(operation, root, () => {});
    ownedResources.push({ runtime, operation });
    const ticket = runtime.acquire({ source: 'self-update', actor: 'atomic-nonzero-fixture' })!;
    const deadline = performance.now() + 15 * 60_000, removals: string[] = [], exits: number[] = [];
    await ownedSwap([
      { currentPath: currentA, nextPath: nextA }, { currentPath: currentB, nextPath: nextB },
    ], {
      assertActive() {
        if (runtime.observe()?.id !== ticket.id || runtime.observe()?.stopRequested) throw new Error('本票已停止');
      },
      async remove(directory) {
        removals.push(directory);
        const timeout = Math.ceil(deadline - performance.now());
        if (timeout <= 0) throw new Error('原阶段预算已耗尽');
        const result = await runtime.exec(ticket, removals.length === 1 ? 'false' : `rm -rf -- ${shellQuote(directory)}`, { timeout });
        exits.push(result.exitCode);
        return result.exitCode === 0;
      },
    });
    expect(exits).toEqual([1, 0]);
    expect(readMarker(currentA)).toBe('new-a'); expect(readMarker(currentB)).toBe('new-b');
    expect(readMarker(removals[0])).toBe('old-a'); expect(fs.existsSync(removals[1])).toBe(false);
    expect(runtime.observe()).toMatchObject({ activeJobCount: 0, unconfirmedJobCount: 0, stopRequested: false });
    expect(runtime.finish(ticket)).toBe(true);
  });

  it('owned激活失败时真实删除已换入产物再恢复原两代，仍抛原激活错误', async () => {
    const root = makeTmpRoot();
    const currentA = path.join(root, 'dist'), nextA = path.join(root, 'dist.next');
    const currentB = path.join(root, 'web-dist'), nextB = path.join(root, 'web-dist.next');
    const previous = path.join(root, 'web-dist.previous');
    writeMarker(currentA, 'old-a'); writeMarker(nextA, 'new-a');
    writeMarker(currentB, 'old-b'); writeMarker(nextB, 'new-b'); writeMarker(previous, 'previous-b');
    const operation = new IsolatedShellExecutor(new ShellExecutor(), { isolatedLane: 'operation', concurrency: 1 });
    const runtime = new SelfMaintenanceRuntime(operation, root, () => {});
    ownedResources.push({ runtime, operation });
    const ticket = runtime.acquire({ source: 'self-update', actor: 'atomic-rollback-fixture' })!;
    const failure = new Error('fixture候选激活失败'), originalRename = fs.renameSync;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (from === nextB && to === currentB) throw failure;
      return originalRename(from, to);
    });
    const deadline = performance.now() + 15 * 60_000, removed: string[] = [];
    try {
      await expect(ownedSwap([
        { currentPath: currentA, nextPath: nextA }, { currentPath: currentB, nextPath: nextB, previousPath: previous },
      ], {
        assertActive() {
          if (runtime.observe()?.id !== ticket.id || runtime.observe()?.stopRequested) throw new Error('本票已停止');
        },
        async remove(directory) {
          const timeout = Math.ceil(deadline - performance.now());
          if (timeout <= 0) throw new Error('原阶段预算已耗尽');
          const result = await runtime.exec(ticket, `rm -rf -- ${shellQuote(directory)}`, { timeout });
          if (result.exitCode === 0) removed.push(directory);
          return result.exitCode === 0;
        },
      })).rejects.toBe(failure);
      expect(removed).toEqual([currentA]);
      expect(readMarker(currentA)).toBe('old-a'); expect(readMarker(currentB)).toBe('old-b');
      expect(readMarker(previous)).toBe('previous-b'); expect(readMarker(nextB)).toBe('new-b');
      expect(fs.readdirSync(root).some(name => name.includes('.old.'))).toBe(false);
      expect(runtime.finish(ticket)).toBe(true);
    } finally {
      renameSpy.mockRestore();
    }
  });

  it.each([false, true])('owned回滚删除普通非零时保留候选并恢复旧目录（保留上一代=%s）', async (keepPrevious) => {
    const root = makeTmpRoot();
    const currentA = path.join(root, 'dist'), nextA = path.join(root, 'dist.next');
    const currentB = path.join(root, 'web-dist'), nextB = path.join(root, 'web-dist.next');
    const previous = path.join(root, 'dist.previous');
    writeMarker(currentA, 'old-a'); writeMarker(nextA, 'new-a');
    writeMarker(currentB, 'old-b'); writeMarker(nextB, 'new-b');
    if (keepPrevious) writeMarker(previous, 'previous-a');
    const operation = new IsolatedShellExecutor(new ShellExecutor(), { isolatedLane: 'operation', concurrency: 1 });
    const runtime = new SelfMaintenanceRuntime(operation, root, () => {});
    ownedResources.push({ runtime, operation });
    const ticket = runtime.acquire({ source: 'self-update', actor: 'atomic-rollback-nonzero-fixture' })!;
    const failure = new Error('fixture第二份候选激活失败'), originalRename = fs.renameSync;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (from === nextB && to === currentB) throw failure;
      return originalRename(from, to);
    });
    const assignments: ExecAssignment[] = [], removals: string[] = [], exits: number[] = [];
    const deadline = performance.now() + 15 * 60_000;
    try {
      await expect(ownedSwap([
        { currentPath: currentA, nextPath: nextA, ...(keepPrevious ? { previousPath: previous } : {}) },
        { currentPath: currentB, nextPath: nextB },
      ], {
        assertActive() {
          const state = runtime.observe();
          if (state?.id !== ticket.id || state.stopRequested || state.unconfirmedJobCount || performance.now() >= deadline) {
            throw new Error('本票已停止，不能继续原子换代');
          }
        },
        async remove(directory) {
          removals.push(directory);
          const timeout = Math.ceil(deadline - performance.now());
          if (timeout <= 0) throw new Error('原阶段预算已耗尽');
          const result = await runtime.exec(ticket, 'false', {
            timeout, onAssigned: assignment => assignments.push(assignment),
          });
          exits.push(result.exitCode);
          return result.exitCode === 0;
        },
      })).rejects.toBe(failure);
      expect(removals).toEqual([currentA]); expect(exits).toEqual([1]);
      expect(assignments).toHaveLength(1);
      expect(assignments[0]).toMatchObject({ lane: 'operation' });
      expect(assignments[0].actorPid).toBeGreaterThan(1);
      expect.soft(readMarker(currentA)).toBe('old-a'); expect.soft(readMarker(currentB)).toBe('old-b');
      expect.soft(fs.existsSync(nextA)).toBe(true);
      if (fs.existsSync(nextA)) expect.soft(readMarker(nextA)).toBe('new-a');
      expect.soft(readMarker(nextB)).toBe('new-b');
      if (keepPrevious) expect.soft(readMarker(previous)).toBe('previous-a');
      expect.soft(fs.readdirSync(root).filter(name => name.includes('.old.'))).toEqual([]);
      expect(runtime.observe()).toMatchObject({ activeJobCount: 0, unconfirmedJobCount: 0, stopRequested: false });
      expect(runtime.finish(ticket)).toBe(true);
    } finally {
      renameSpy.mockRestore();
    }
  });

  it('前端产物换代后保留上一代目录', () => {
    const root = makeTmpRoot();
    const current = path.join(root, 'dist');
    const next = path.join(root, 'dist.next');
    const previous = path.join(root, 'dist.previous');
    writeMarker(current, 'old-web');
    writeMarker(next, 'new-web');

    replaceDirectoriesAtomically([
      { currentPath: current, nextPath: next, previousPath: previous },
    ]);

    expect(readMarker(current)).toBe('new-web');
    expect(readMarker(previous)).toBe('old-web');
  });

  it('已存在上一代时候选目录上线失败会恢复两代产物', () => {
    const root = makeTmpRoot();
    const current = path.join(root, 'dist');
    const next = path.join(root, 'dist.next');
    const previous = path.join(root, 'dist.previous');
    writeMarker(current, 'current-web');
    writeMarker(next, 'candidate-web');
    writeMarker(previous, 'previous-web');

    const originalRename = fs.renameSync;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (from === next && to === current) {
        throw new Error('simulated candidate activation failure');
      }
      return originalRename(from, to);
    });

    try {
      expect(() => replaceDirectoriesAtomically([
        { currentPath: current, nextPath: next, previousPath: previous },
      ])).toThrow('simulated candidate activation failure');
    } finally {
      renameSpy.mockRestore();
    }

    expect(readMarker(current)).toBe('current-web');
    expect(readMarker(previous)).toBe('previous-web');
    expect(readMarker(next)).toBe('candidate-web');
  });
});

describe('validateWebDistCandidate', () => {
  it('把 Vite 输出定向候选目录且不传入多余分隔符', () => {
    expect(WEB_DIST_BUILD_COMMAND).toBe('pnpm build --outDir dist.next --emptyOutDir');
    expect(WEB_DIST_BUILD_COMMAND).not.toContain('build -- --outDir');
  });

  it('验证 index.html 引用的本地 JS 和 CSS 入口', () => {
    const root = makeTmpRoot();
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'index.html'),
      '<link rel="stylesheet" href="/assets/main.css"><script type="module" src="/assets/main.js"></script>',
    );
    fs.writeFileSync(path.join(root, 'assets', 'main.css'), 'body { color: black; }');
    fs.writeFileSync(path.join(root, 'assets', 'main.js'), 'export const ready = true;');

    expect(validateWebDistCandidate(root)).toEqual({
      ok: true,
      entryFiles: ['assets/main.css', 'assets/main.js'],
    });
  });

  it('拒绝 index.html 引用缺失入口的候选产物', () => {
    const root = makeTmpRoot();
    fs.writeFileSync(
      path.join(root, 'index.html'),
      '<script type="module" src="/assets/missing.js"></script>',
    );

    expect(validateWebDistCandidate(root)).toEqual({
      ok: false,
      error: 'candidate entry is missing: assets/missing.js',
    });
  });
});
