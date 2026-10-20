import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { CdsState } from '../src/types.js';
import type { JsonStateWriteEvent } from '../src/infra/state-store/json-backing-store.js';

// Native filesystem and compiled production module; controlled gates affect only this owned process.
const moduleUrl = new URL('../dist/infra/state-store/json-backing-store.js', import.meta.url);
const { JsonStateBackingStore, flushAllJsonStateStores } = await import(moduleUrl.href) as typeof import('../src/infra/state-store/json-backing-store.js');
const output = path.resolve(process.argv[2] || 'json-write-output'); await fs.mkdir(output, { recursive: true, mode: 0o700 });
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-json-write-')); await fs.chmod(dir, 0o700);
const file = path.join(dir, 'state.json');
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const sourcePaths = ['src/infra/state-store/json-backing-store.ts', 'scripts/json-write-overlap-drill.ts'];
const receipts: JsonStateWriteEvent[] = []; let dropped = 0;
const observe = (event: JsonStateWriteEvent) => { if (receipts.length < 256) receipts.push(event); else dropped++; };
const report: any = { schema: 1, head: execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceHashes: Object.fromEntries(await Promise.all(sourcePaths.map(async name => [name, digest(await fs.readFile(name))]))),
  moduleSha256: digest(await fs.readFile(moduleUrl)), mode: 'compiled', actualNativeFileHandles: true,
  wholeFilesystemMock: false, scope: 'isolated JSON atomic-write ownership and confirmation only',
  performanceVerified: false, actualDeploymentVerified: false, verdict: 'failed', checks: [], writeReceipts: receipts, isolatedFilesRemoved: false };
const state = (marker: string): CdsState => ({ routingRules: [], buildProfiles: [], branches: {}, nextPortIndex: 0, logs: {}, defaultBranch: null, customEnv: { fixture: { marker } }, infraServices: [], previewMode: 'multi' });
const barrier = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { release, promise }; };
const originalOpen = fs.open; const originalNow = Date.now;
const primary = (name: unknown) => String(name).includes('.tmp.') && !String(name).includes('.bak.');
const marker = async () => JSON.parse(await fs.readFile(file, 'utf8')).customEnv.fixture.marker;
try {
  Date.now = () => 1_791_689_000_000;
  const entered = barrier(), release = barrier(); let opens = 0;
  fs.open = async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args); if (!primary(args[0])) return handle; const index = opens++;
    return new Proxy(handle, { get(target, key) {
      if (key === 'writeFile' && index === 0) return async (...values: any[]) => { entered.release(); await release.promise; return (target.writeFile as any)(...values); };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  const a = new JsonStateBackingStore(file, { onWrite: observe }), b = new JsonStateBackingStore(path.join(dir, 'unused', '..', 'state.json'), { onWrite: observe });
  a.save(state('long:' + 'x'.repeat(8192))); const first = a.flush(); await entered.promise;
  b.save(state('short')); const second = b.flush(); void second.catch(() => {});
  try { await new Promise(resolve => setImmediate(resolve)); assert.equal(opens, 1); release.release(); await first; await marker(); await second; assert.equal(await marker(), 'short'); }
  finally { release.release(); await Promise.allSettled([first, second]); fs.open = originalOpen; }
  report.checks.push({ phase: 'normalized-target', singleWriterWhileFirstHeld: true, confirmedJsonParseable: true });

  await fs.symlink(dir, path.join(dir, 'alias'));
  const gates = [barrier(), barrier()], ready = [barrier(), barrier()]; const inodes: number[] = [];
  fs.open = async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args); if (!primary(args[0])) return handle;
    assert.equal(args[1], 'wx'); const index = inodes.length; inodes.push((await handle.stat()).ino);
    return new Proxy(handle, { get(target, key) {
      if (key === 'writeFile') return async (...values: any[]) => { ready[index].release(); await gates[index].promise; return (target.writeFile as any)(...values); };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  const c = new JsonStateBackingStore(file, { onWrite: observe }), d = new JsonStateBackingStore(path.join(dir, 'alias', 'state.json'), { onWrite: observe });
  c.save(state('long:' + 'x'.repeat(8192))); const long = c.flush(); await ready[0].promise;
  d.save(state('short')); const short = d.flush(); void short.catch(() => {}); await ready[1].promise;
  try { gates[0].release(); await long; assert.equal((await marker()).length, 8197); gates[1].release(); await short; assert.equal(await marker(), 'short'); assert.notEqual(inodes[0], inodes[1]); }
  finally { gates.forEach(g => g.release()); await Promise.allSettled([long, short]); fs.open = originalOpen; }
  report.checks.push({ phase: 'physical-alias-overlap', distinctInodes: true, exclusiveTempCreation: true, shortWriteCannotMutatePublishedLongSnapshot: true });

  let injected = false; const before = await fs.readFile(file, 'utf8');
  fs.open = async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args); if (!primary(args[0]) || injected) return handle; injected = true;
    return new Proxy(handle, { get(target, key) {
      if (key === 'writeFile') return async () => { throw Object.assign(new Error('owned injected write failure'), { code: 'EIO' }); };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  const failure = new JsonStateBackingStore(file, { onWrite: observe }); failure.save(state('must-not-publish'));
  await assert.rejects(failure.flush(), { code: 'EIO' }); fs.open = originalOpen; assert.equal(await fs.readFile(file, 'utf8'), before);
  const retry = new JsonStateBackingStore(file, { onWrite: observe }); retry.save(state('retry')); await retry.flush();
  assert.equal(new JsonStateBackingStore(file).load()?.customEnv.fixture.marker, 'retry');
  assert.ok(!(await fs.readdir(dir)).some(name => name.includes('.tmp.')));
  report.checks.push({ phase: 'failed-write-and-cold-recovery', failureNotAcknowledged: true, oldFilePreserved: true, anotherWriterCanRetry: true, coldJsonParseable: true });
  const committed = receipts.filter(r => r.phase === 'committed' && r.purpose === 'primary');
  assert.equal(committed.length, 5); assert.equal(new Set(committed.map(r => path.basename(r.tempPath))).size, 5);
  assert.ok(receipts.some(r => r.phase === 'failed' && r.errorCode === 'EIO')); assert.equal(dropped, 0);
  report.verdict = 'passed';
} catch (error) { report.errorName = (error as Error).name; throw error; }
finally {
  fs.open = originalOpen; Date.now = originalNow;
  await flushAllJsonStateStores(); await fs.rm(dir, { recursive: true, force: true }); report.isolatedFilesRemoved = true;
  report.writeReceiptsDropped = dropped; report.finishedAt = new Date().toISOString();
  await fs.copyFile(moduleUrl, path.join(output, 'json-backing-store.compiled.js')); await fs.chmod(path.join(output, 'json-backing-store.compiled.js'), 0o600);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
