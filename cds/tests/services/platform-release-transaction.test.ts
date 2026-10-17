import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MaintenanceWorkGroup, PlatformReleaseBarrier } from '../../src/services/platform-release-barrier.js';
import { executePlatformRelease, recoverPlatformRelease, platformBundleDigest, PLATFORM_RELEASE_COVERAGE,
  type PlatformReleaseHost, type PlatformReleasePlan, type PlatformBundle } from '../../src/services/platform-release-transaction.js';

const baselineSha = 'a'.repeat(40), candidateSha = 'b'.repeat(40);
const expectedRuntime = { pid: 1234, startedAt: '2026-10-16T00:00:00Z', commitSha: baselineSha };
let temp: string, plan: PlatformReleasePlan, host: PlatformReleaseHost;
let closed: boolean, sealed: boolean, runtime: typeof expectedRuntime;
let children: ChildProcess[] = [];
function bundle(root: string, sha: string): PlatformBundle {
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(root, 'web/dist/assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(root, 'web/dist/index.html'), `<html><script src="/assets/entry.js"></script>${sha}</html>`);
  fs.writeFileSync(path.join(root, 'web/dist/assets/entry.js'), `globalThis.version = '${sha}';`);
  // 受控测试进程：只监听随机 loopback 端口，不加载平台配置、Docker 或业务数据。
  fs.writeFileSync(path.join(root, 'dist/index.js'), `
    import http from 'node:http'; import fs from 'node:fs';
    const identity = {pid:process.pid, startedAt:new Date().toISOString(), commitSha:'${sha}'};
    const server = http.createServer((req,res) => {
      if (req.url === '/api/version') { res.end(JSON.stringify(identity)); return; }
      const file = req.url === '/' ? 'web/dist/index.html' : 'web/dist/assets/entry.js';
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({port:server.address().port,...identity})));
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `);
  return { commitSha: sha, treeSha256: platformBundleDigest(root) };
}
const current = () => path.join(plan.root, 'current');
const journal = () => JSON.parse(fs.readFileSync(path.join(plan.root, '.release-lock/journal.json'), 'utf8'));
const receipts = () => fs.readdirSync(path.join(plan.root, 'receipts')).map(name =>
  JSON.parse(fs.readFileSync(path.join(plan.root, 'receipts', name), 'utf8')));
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cbd-release-transaction-'));
  const root = path.join(temp, 'release'); fs.mkdirSync(root);
  plan = { root, candidateDirectory: path.join(temp, 'candidate'), baseline: bundle(path.join(root, 'current'), baselineSha),
    candidate: bundle(path.join(temp, 'candidate'), candidateSha), expectedRuntime: { ...expectedRuntime },
    applicationFingerprint: 'c'.repeat(64), drainTimeoutMs: 1000 };
  closed = sealed = false; runtime = { ...expectedRuntime };
  host = {
    identity: vi.fn(async () => ({ ...runtime })),
    acquire: vi.fn(async () => {
      closed = true;
      return { coverage: [...PLATFORM_RELEASE_COVERAGE],
        seal: async () => { sealed = true; },
        assertSealed: () => { if (!closed || !sealed) throw new Error('barrier not sealed'); },
        reopen: async () => { closed = sealed = false; } };
    }),
    stopOwned: vi.fn(async () => { expect(closed && sealed).toBe(true); }),
    start: vi.fn(async (_id, directory, target) => {
      expect(directory).toBe(current()); expect(closed && sealed).toBe(true);
      expect(platformBundleDigest(directory)).toBe(target.treeSha256);
      runtime = { ...runtime, pid: runtime.pid + 1, startedAt: new Date().toISOString(), commitSha: target.commitSha };
    }),
    verify: vi.fn(async (target, fingerprint) => {
      expect(fingerprint).toBe(plan.applicationFingerprint);
      return { runtime: { ...runtime }, treeSha256: target.treeSha256, surfaceReady: true,
        applicationsUnchanged: true, admissionClosed: closed };
    }),
  };
});
afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  }
  children = []; vi.restoreAllMocks(); fs.rmSync(temp, { recursive: true, force: true });
});

describe('外部维护控制器的持久发布事务', () => {
  it('完整校验后换盘，新代际和页面确认后才开闸，保留旧包及不可覆盖回执', async () => {
    const result = await executePlatformRelease(plan, host);
    expect(result.phase).toBe('committed'); expect(closed).toBe(false);
    expect(platformBundleDigest(current())).toBe(plan.candidate.treeSha256);
    expect(platformBundleDigest(path.join(plan.root, `.baseline-${result.id}`))).toBe(plan.baseline.treeSha256);
    expect(receipts()).toHaveLength(1); expect(fs.existsSync(path.join(plan.root, '.release-lock'))).toBe(false);
    expect(result.events.map(event => event.phase)).toEqual(['prepared', 'draining', 'stopping', 'switching', 'starting', 'verifying', 'committed']);
  });
  it.each(['candidate', 'baseline', 'identity', 'missing-entry', 'symlink', 'runtime-state', 'credentials', 'web-source'] as const)
  ('%s 不合格时不取得屏障、不发停止信号', async failure => {
    if (failure === 'candidate') fs.appendFileSync(path.join(plan.candidateDirectory, 'dist/index.js'), '\n// tampered');
    if (failure === 'baseline') fs.appendFileSync(path.join(current(), 'dist/index.js'), '\n// tampered');
    if (failure === 'identity') runtime.pid++;
    if (failure === 'missing-entry') fs.unlinkSync(path.join(plan.candidateDirectory, 'web/dist/index.html'));
    if (failure === 'symlink') fs.symlinkSync('/etc/passwd', path.join(plan.candidateDirectory, 'dist/outside'));
    if (failure === 'runtime-state') fs.mkdirSync(path.join(plan.candidateDirectory, '.cds'));
    if (failure === 'credentials') fs.writeFileSync(path.join(plan.candidateDirectory, '.env'), 'FIXTURE_ONLY=1');
    if (failure === 'web-source') fs.mkdirSync(path.join(plan.candidateDirectory, 'web/src'));
    await expect(executePlatformRelease(plan, host)).rejects.toThrow();
    expect(host.acquire).not.toHaveBeenCalled(); expect(host.stopOwned).not.toHaveBeenCalled();
  });
  it.each(['coverage', 'drain', 'final-identity', 'late-file-change'] as const)
  ('%s 拒绝在换盘前，旧产物不被事务覆盖', async failure => {
    host.acquire = vi.fn(async () => {
      closed = true;
      return { coverage: failure === 'coverage' ? ['http-webhook'] : PLATFORM_RELEASE_COVERAGE,
        seal: async () => {
          if (failure === 'drain') throw new Error('drain timeout');
          if (failure === 'final-identity') runtime.pid++;
          if (failure === 'late-file-change') fs.appendFileSync(path.join(current(), 'dist/index.js'), '\n// external change');
          sealed = true;
        }, assertSealed: () => {}, reopen: async () => { closed = false; } };
    });
    await expect(executePlatformRelease(plan, host)).rejects.toThrow();
    expect(host.stopOwned).not.toHaveBeenCalled(); expect(host.start).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(current(), 'dist/index.js'), 'utf8')).toContain(baselineSha);
    expect(receipts()[0].phase).toBe('aborted');
  });
  it('取得屏障回执丢失时保留锁，恢复换盘前事务不停止旧进程', async () => {
    const acquire = host.acquire;
    host.acquire = async () => { closed = true; throw new Error('receipt lost'); };
    await expect(executePlatformRelease(plan, host)).rejects.toThrow('receipt lost');
    expect(journal().phase).toBe('recovery-required'); expect(closed).toBe(true);
    host.acquire = acquire;
    await recoverPlatformRelease(plan.root, host);
    expect(host.stopOwned).not.toHaveBeenCalled(); expect(receipts()[0].phase).toBe('aborted');
  });
  it('排空仍在落盘时拒绝解锁；迟到落盘完成后只能取消换盘前事务', async () => {
    const acquire = host.acquire;
    host.acquire = async () => ({ coverage: PLATFORM_RELEASE_COVERAGE,
      seal: async () => { closed = true; throw new Error('flush timeout'); }, assertSealed: () => {},
      reopen: async () => { throw new Error('flush pending'); } });
    await expect(executePlatformRelease(plan, host)).rejects.toThrow('flush timeout');
    expect(journal().phase).toBe('recovery-required'); expect(host.stopOwned).not.toHaveBeenCalled();
    host.acquire = acquire; await recoverPlatformRelease(plan.root, host);
    expect(host.stopOwned).not.toHaveBeenCalled(); expect(closed).toBe(false);
  });
  it.each(['stop', 'rename', 'start', 'surface', 'applications', 'generation'] as const)
  ('%s 失败恢复旧包与旧版本服务，原发布仍失败', async failure => {
    if (failure === 'stop') vi.mocked(host.stopOwned).mockRejectedValueOnce(new Error('stop failed'));
    if (failure === 'rename') {
      const rename = fs.renameSync;
      vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (String(from).includes('.candidate-')) throw new Error('rename failed');
        return rename(from, to);
      });
    }
    if (failure === 'start') vi.mocked(host.start).mockRejectedValueOnce(new Error('start failed'));
    if (['surface', 'applications', 'generation'].includes(failure)) {
      vi.mocked(host.verify).mockImplementationOnce(async target => ({ runtime: failure === 'generation'
        ? { ...expectedRuntime, commitSha: candidateSha } : runtime, treeSha256: target.treeSha256,
        surfaceReady: failure !== 'surface', applicationsUnchanged: failure !== 'applications', admissionClosed: true }));
    }
    await expect(executePlatformRelease(plan, host)).rejects.toThrow();
    expect(platformBundleDigest(current())).toBe(plan.baseline.treeSha256);
    expect(runtime.commitSha).toBe(baselineSha); expect(closed).toBe(false);
    expect(receipts()[0]).toMatchObject({ phase: 'restored', failurePhase: expect.any(String) });
  });
  it('回滚启动失败保持封闭和日志，新控制器恢复并复验后才开闸', async () => {
    vi.mocked(host.start).mockRejectedValueOnce(new Error('candidate down')).mockRejectedValueOnce(new Error('baseline down'));
    await expect(executePlatformRelease(plan, host)).rejects.toThrow('baseline down');
    expect(closed).toBe(true); expect(journal().phase).toBe('recovery-required');
    const result = await recoverPlatformRelease(plan.root, host);
    expect(result.phase).toBe('restored'); expect(runtime.commitSha).toBe(baselineSha);
    expect(closed).toBe(false); expect(host.acquire).toHaveBeenLastCalledWith(result.id, expectedRuntime, true);
  });
  it('回退包篡改时绝不启动被篡改的包，维护锁不按时间失效', async () => {
    vi.mocked(host.start).mockImplementationOnce(async id => {
      fs.appendFileSync(path.join(plan.root, `.baseline-${id}/dist/index.js`), '\n// damaged');
      throw new Error('candidate failed');
    });
    await expect(executePlatformRelease(plan, host)).rejects.toThrow('完整性');
    expect(closed).toBe(true); expect(host.start).toHaveBeenCalledTimes(1);
    await expect(executePlatformRelease(plan, host)).rejects.toThrow();
    expect(journal().phase).toBe('recovery-required');
  });
  it('已提交但开闸失败只重验并恢复准入，不重复停机或换盘', async () => {
    const acquire = host.acquire;
    host.acquire = async (...args) => {
      const hold = await acquire(...args); hold.reopen = async () => { throw new Error('reopen failed'); }; return hold;
    };
    await expect(executePlatformRelease(plan, host)).rejects.toThrow('reopen failed');
    expect(journal().phase).toBe('committed'); expect(closed).toBe(true);
    host.acquire = acquire; await recoverPlatformRelease(plan.root, host);
    expect(host.stopOwned).toHaveBeenCalledTimes(1); expect(runtime.commitSha).toBe(candidateSha); expect(closed).toBe(false);
  });
  it('终态回执落盘后锁清理失败可幂等收尾，不覆盖回执', async () => {
    const rm = fs.rmSync; let failed = false;
    vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (String(target).endsWith('.release-lock') && !failed) { failed = true; throw new Error('lock cleanup'); }
      return rm(target, options);
    });
    await expect(executePlatformRelease(plan, host)).rejects.toThrow('lock cleanup');
    const before = receipts()[0]; await recoverPlatformRelease(plan.root, host);
    expect(receipts()).toEqual([before]); expect(host.stopOwned).toHaveBeenCalledTimes(1);
  });
  it.each(['stopping', 'switching', 'starting', 'verifying', 'committed'])
  ('控制器在 %s 持久化后退出，由另一控制器按日志恢复', async phase => {
    const source = path.resolve('src/services/platform-release-transaction.ts');
    const script = `
      import fs from 'node:fs';
      import {executePlatformRelease} from ${JSON.stringify(source)};
      const plan = JSON.parse(process.argv[1]); let runtime = plan.expectedRuntime;
      const rename = fs.renameSync;
      fs.renameSync = (from,to) => {
        rename(from,to);
        if (String(to).endsWith('/journal.json') && JSON.parse(fs.readFileSync(to,'utf8')).phase === ${JSON.stringify(phase)}) process.exit(86);
      };
      const hold = {coverage:${JSON.stringify(PLATFORM_RELEASE_COVERAGE)},seal:async()=>{},assertSealed:()=>{},reopen:async()=>{}};
      const host = {identity:async()=>runtime, acquire:async()=>hold,stopOwned:async()=>{},
        start:async(_id,_dir,bundle)=>{runtime={...runtime,pid:runtime.pid+1,commitSha:bundle.commitSha};},
        verify:async(bundle)=>({runtime,treeSha256:bundle.treeSha256,surfaceReady:true,applicationsUnchanged:true,admissionClosed:true})};
      await executePlatformRelease(plan,host);
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, JSON.stringify(plan)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let stderr = ''; child.stderr!.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'exit'); expect(stderr).toBe(''); expect(code).toBe(86);
    expect(journal().phase).toBe(phase);
    // 模拟外部 supervisor 重新取得独占权。事务代码不能仅凭 child exit 自动取得此资格。
    if (phase === 'committed') runtime = { ...expectedRuntime, pid: 1235, commitSha: candidateSha };
    const result = await recoverPlatformRelease(plan.root, host);
    expect(result.phase).toBe(phase === 'committed' ? 'committed' : 'restored');
    expect(platformBundleDigest(current())).toBe(phase === 'committed' ? plan.candidate.treeSha256 : plan.baseline.treeSha256);
    expect(closed).toBe(false);
  });
});

describe('隔离进程与真实 HTTP 表面验收', () => {
  it('自然排空、晚到请求拒绝、候选页面验真失败后恢复旧页面和新进程代际', async () => {
    // 完整运行包中包含错误版本的入口资源：API 和 HTML 正常不能掩盖混版。
    fs.writeFileSync(path.join(plan.candidateDirectory, 'web/dist/assets/entry.js'), `globalThis.version='${baselineSha}';`);
    plan.candidate.treeSha256 = platformBundleDigest(plan.candidateDirectory);
    let processNow: ChildProcess | undefined, port = 0;
    async function start(directory: string) {
      const child = spawn(process.execPath, ['dist/index.js'], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child); processNow = child;
      const [data] = await once(child.stdout!, 'data');
      const identity = JSON.parse(data.toString()); port = identity.port; runtime = identity; return identity;
    }
    async function stop() {
      if (!processNow || processNow.exitCode !== null || processNow.signalCode !== null) return;
      const exit = once(processNow, 'exit'); processNow.kill('SIGTERM'); await exit;
    }
    plan.expectedRuntime = await start(current());
    const externalIdentity = { ...expectedRuntime, pid: process.pid };
    const groups = new Map(PLATFORM_RELEASE_COVERAGE.map(name => [name, new MaintenanceWorkGroup()]));
    const barrier = new PlatformReleaseBarrier(groups, PLATFORM_RELEASE_COVERAGE, () => externalIdentity);
    let complete!: () => void;
    const accepted = groups.get('http-webhook')!.run('accepted', () => new Promise<void>(resolve => { complete = resolve; }));
    let acceptedEnded = false; accepted.then(() => { acceptedEnded = true; });
    host.acquire = async () => {
      const lease = barrier.begin(externalIdentity); closed = true;
      return { coverage: PLATFORM_RELEASE_COVERAGE, seal: async timeoutMs => {
        expect(() => groups.get('http-webhook')!.run('late', () => 1)).toThrow('维护');
        complete(); await barrier.seal(lease, { timeoutMs, flush: async () => {} }); barrier.commit(lease);
      }, assertSealed: () => { expect(barrier.snapshot().phase).toBe('committing'); },
      reopen: async () => { barrier.rollbackComplete(lease, () => true); closed = false; } };
    };
    host.identity = async () => runtime;
    host.stopOwned = async () => { expect(acceptedEnded).toBe(true); await stop(); };
    host.start = async (_id, directory) => { await start(directory); };
    host.verify = async target => {
      const base = `http://127.0.0.1:${port}`;
      const identity = await fetch(`${base}/api/version`).then(res => res.json());
      const html = await fetch(base).then(res => res.text());
      const resource = await fetch(`${base}/assets/entry.js`).then(res => res.text());
      return { runtime: identity, treeSha256: platformBundleDigest(current()),
        surfaceReady: identity.commitSha === target.commitSha && html.includes(target.commitSha) && resource.includes(target.commitSha),
        applicationsUnchanged: true, admissionClosed: closed };
    };
    await expect(executePlatformRelease(plan, host)).rejects.toThrow('核验失败');
    expect(runtime.commitSha).toBe(baselineSha); expect(runtime.pid).not.toBe(plan.expectedRuntime.pid);
    expect(receipts()[0].phase).toBe('restored'); expect(barrier.snapshot().phase).toBe('open');
    expect(await fetch(`http://127.0.0.1:${port}`).then(res => res.text())).toContain(baselineSha);
    await stop();
  });
});
