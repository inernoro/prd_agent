import { traceExecutor } from '../helpers/cleanup-lifecycle-trace.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as childProcess from 'node:child_process';
import { SystemLogMonitor } from '../../src/services/system-log-monitor.js';
import { ObservationStreamExecutor } from '../../src/services/observation-stream-executor.js';
import { ShellExecutor } from '../../src/services/shell-executor.js';
import { ObservationExecutionError } from '../../src/services/isolated-shell-executor.js';
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const pools: ObservationStreamExecutor[] = [];
const monitors: SystemLogMonitor[] = [];
const dirs: string[] = [];
const originalPath = process.env.PATH;
const originalSince = process.env.CDS_JOURNAL_BACKFILL_SINCE;
async function until(predicate: () => boolean | Promise<boolean>, attempts = 500): Promise<void> {
  for (let i = 0; i < attempts; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Journal fixture did not become ready');
}
async function fixture(mode = 'normal', prewarmed?: ObservationStreamExecutor) {
  const dir = await mkdtemp(path.join(tmpdir(), 'cds-journal-stream-')); dirs.push(dir);
  const traceFile = path.join(dir, 'trace.jsonl'); const childFile = path.join(dir, 'child.pid');
  const script = String.raw`#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(traceFile)},JSON.stringify({pid:process.pid,ppid:process.ppid,args})+'\n');
const emit=(cursor,message)=>process.stdout.write(JSON.stringify({__CURSOR:cursor,PRIORITY:'4',MESSAGE:message,_SYSTEMD_UNIT:'fixture.service'})+'\n');
if(!args.includes('-f')) {
 if(${JSON.stringify(mode)}==='slow-backfill') {setInterval(()=>{},1000);}
 else if(${JSON.stringify(mode)}==='hang') {const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(childFile)},String(child.pid));setInterval(()=>{},1000);}
 else {if(${JSON.stringify(mode)}==='large-backfill')process.stdout.write('x'.repeat(12*1024*1024)+'\n');emit('shared-cursor','warning backfill');}
} else {
 emit('shared-cursor','warning duplicate');
 if(${JSON.stringify(mode)}==='overflow') {process.stdout.write('x'.repeat(128*1024));setTimeout(()=>process.stdout.write('\n'+JSON.stringify({__CURSOR:'valid',PRIORITY:'4',MESSAGE:'warning after oversize'})+'\n'),200);}
 else if(${JSON.stringify(mode)}==='burst') {let rows=[];for(let i=0;i<5000;i++)rows.push(JSON.stringify({__CURSOR:'burst-'+i,PRIORITY:'4',MESSAGE:'warning burst '+i}));process.stdout.write(rows.join('\n')+'\n');}
 else emit(${JSON.stringify(mode)}==='flap'?'tail-'+process.pid:'tail-cursor','warning tail');
 process.stderr.write('synthetic-journal-stderr\n');
 if(${JSON.stringify(mode)}==='flap')setTimeout(()=>process.exit(0),20);
 setInterval(()=>{},1000);setTimeout(()=>process.exit(0),60000);
}
`;
  await writeFile(path.join(dir, 'journalctl'), script, { mode: 0o700 });
  process.env.PATH = `${dir}:${originalPath || ''}`;
  const streams = prewarmed ?? traceExecutor(new ObservationStreamExecutor(1), `system-journal:${mode}`);
  if (!prewarmed) pools.push(streams);
  await streams.start(); vi.clearAllMocks();
  const trace = async (): Promise<Array<{ pid: number; ppid: number; args: string[] }>> => {
    try { return (await readFile(traceFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; }
  };
  return { dir, streams, trace, childFile };
}
afterEach(async () => {
  await Promise.allSettled(monitors.splice(0).map(monitor => monitor.stop()));
  // 旧路径反例只回收本测试实际返回的私有journalctl及其ShellExecutor组。
  for (const result of vi.mocked(childProcess.spawn).mock.results) {
    if (result.type !== 'return') continue;
    const child = result.value;
    if (child?.spawnfile === 'journalctl') child.kill('SIGKILL');
    else if (child?.spawnfile === 'bash' && child.spawnargs.some(arg => arg.includes('journalctl')) && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  }
  await Promise.all(pools.splice(0).map(pool => pool.close()));
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
  if (originalSince === undefined) delete process.env.CDS_JOURNAL_BACKFILL_SINCE; else process.env.CDS_JOURNAL_BACKFILL_SINCE = originalSince;
  vi.restoreAllMocks();
});
describe('系统journal独立读取与真实收尾', () => {
  it('历史和监听均由独立进程读取，游标去重及原优先级保留，参数不执行shell展开', async () => {
    const f = await fixture(); const rows: any[] = [];
    const sentinel = path.join(f.dir, 'must-not-exist');
    process.env.CDS_JOURNAL_BACKFILL_SINCE = `15 minutes ago $(touch '${sentinel}')`;
    const monitor = new SystemLogMonitor(new ShellExecutor(), { record: row => rows.push(row) }, ['fixture.service'], f.streams); monitors.push(monitor);
    await monitor.start(); await until(() => rows.some(row => row.action === 'journal.tail'));
    const trace = await f.trace();
    if (process.env.CDS_JOURNAL_REFERENCE === '1') console.info(JSON.stringify({ referenceTrace: trace, rows: rows.map(row => ({ action: row.action, message: row.message.length < 200 ? row.message : row.message.length })) }));
    expect(trace).toHaveLength(2); expect(trace.every(row => row.ppid !== process.pid)).toBe(true);
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(trace[0].args).toContain(process.env.CDS_JOURNAL_BACKFILL_SINCE);
    expect(trace.every(row => row.args.includes('warning..alert') && row.args.includes('fixture.service'))).toBe(true);
    await expect(access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(rows.filter(row => row.action.startsWith('journal.')).map(row => row.message)).toEqual(['warning backfill', 'warning tail']);
    expect(rows.some(row => row.action === 'tail.stderr' && row.message.includes('synthetic-journal-stderr'))).toBe(true);
    await monitor.stop(); expect(f.streams.getStats().admitted).toBe(0); expect(monitor.getStats().bufferedBytes).toBe(0);
  });
  it('12MiB历史和未换行超长尾部不积累全文，跳过整行后继续记录', async () => {
    // 保留两份独立池与全部原数据量；提前并行预热第二池，不在半途串行重复冷启动。
    const nextStreams = traceExecutor(new ObservationStreamExecutor(1), 'system-journal:overflow'); pools.push(nextStreams);
    const [f] = await Promise.all([fixture('large-backfill'), nextStreams.start()]); const rows: any[] = [];
    const monitor = new SystemLogMonitor(new ShellExecutor(), { record: row => rows.push(row) }, ['fixture.service'], f.streams); monitors.push(monitor);
    await monitor.start(); await until(() => rows.some(row => row.action === 'journal.tail'));
    if (process.env.CDS_JOURNAL_REFERENCE === '1') console.info(JSON.stringify({ maximumMessage: Math.max(...rows.map(row => row.message.length)), actions: rows.map(row => row.action) }));
    expect(rows.filter(row => row.action === 'journal.backfill').map(row => row.message)).toEqual(['warning backfill']);
    expect(rows.some(row => row.action === 'journal.oversize')).toBe(true);
    expect(rows.every(row => Buffer.byteLength(row.message) <= 65536)).toBe(true);
    expect(monitor.getStats().overflowLines).toBe(1);
    await monitor.stop(); expect(f.streams.getStats().admitted).toBe(0);
    const next = await fixture('overflow', nextStreams); const tailRows: any[] = [];
    const tail = new SystemLogMonitor(new ShellExecutor(), { record: row => tailRows.push(row) }, ['fixture.service'], next.streams); monitors.push(tail);
    await tail.start(); await until(() => tail.getStats().overflowLines === 1);
    expect(tail.getStats().bufferedBytes).toBeLessThanOrEqual(65536);
    await until(() => tailRows.some(row => row.message === 'warning after oversize'));
    expect(tailRows.filter(row => row.action === 'journal.tail').map(row => row.message)).toEqual(['warning after oversize']);
    await tail.stop();
  });
  it('突发短行逐批让出控制面，无2000行丢弃队列且游标字节有硬限', async () => {
    const f = await fixture('burst'); let count = 0; let yielded = false; let afterYield = false;
    const monitor = new SystemLogMonitor(new ShellExecutor(), { record: row => {
      if (row.action !== 'journal.tail') return;
      if (++count === 1) setImmediate(() => { yielded = true; });
      if (count > 100 && yielded) afterYield = true;
    } }, ['fixture.service'], f.streams); monitors.push(monitor);
    await monitor.start(); await until(() => count === 5000);
    expect(afterYield).toBe(true); expect(monitor.getStats().seenCursors).toBeLessThanOrEqual(5000);
    expect(monitor.getStats().cursorBytes).toBeLessThanOrEqual(1024 * 1024);
    await monitor.stop(); expect(f.streams.getStats().admitted).toBe(0);
  });
  it('stop取消正在历史读取的真实父子进程，完成后不启动迟到监听', async () => {
    const f = await fixture('hang'); const rows: any[] = [];
    const monitor = new SystemLogMonitor(new ShellExecutor(), { record: row => rows.push(row) }, ['fixture.service'], f.streams); monitors.push(monitor);
    void monitor.start(); await until(async () => { try { return Number((await readFile(f.childFile, 'utf8')).trim()) > 1; } catch { return false; } });
    const pid = Number((await readFile(f.childFile, 'utf8')).trim());
    const stopping = monitor.stop(); expect(stopping).toBeInstanceOf(Promise); await stopping;
    expect(f.streams.getStats().admitted).toBe(0);
    expect(pid).toBeGreaterThan(1); let state = '';
    try { state = childProcess.execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch (error) { expect((error as { status?: number }).status).toBe(1); }
    expect(state).toMatch(/^(Z.*)?$/);
    expect((await f.trace()).filter(row => row.args.includes('-f'))).toHaveLength(0);
    expect(rows.filter(row => row.action === 'journal.tail')).toEqual([]);
  });
  it('真实历史读取八秒超时并清理后继续监听新日志，不无限重放历史', async () => {
    const f = await fixture('slow-backfill'); const rows: any[] = [];
    const monitor = new SystemLogMonitor(new ShellExecutor(), { record: row => rows.push(row) }, ['fixture.service'], f.streams); monitors.push(monitor);
    await monitor.start(); await until(() => rows.some(row => row.action === 'journal.tail'), 1500);
    expect(rows.some(row => row.action === 'backfill.failed' && row.message.includes('超时'))).toBe(true);
    expect((await f.trace()).filter(row => !row.args.includes('-f'))).toHaveLength(1);
    expect(f.streams.getStats().admitted).toBe(1); await monitor.stop(); expect(f.streams.getStats().admitted).toBe(0);
  }, 18000);
  it('反复start和stop/start不叠加，流断开只保留一个重连', async () => {
    const f = await fixture('flap'); let tails = 0;
    const monitor = new SystemLogMonitor(new ShellExecutor(), { record: row => { if (row.action === 'journal.tail') tails++; } }, ['fixture.service'], f.streams, 10); monitors.push(monitor);
    void monitor.start(); void monitor.start(); await until(() => tails >= 2);
    expect(f.streams.getStats().admitted).toBeLessThanOrEqual(1);
    const stopping = monitor.stop(); void monitor.start(); await stopping; await until(() => tails >= 3);
    await monitor.stop(); const before = (await f.trace()).length; await new Promise(resolve => setTimeout(resolve, 100));
    expect((await f.trace()).length).toBe(before);
    expect((await f.trace()).filter(row => !row.args.includes('-f'))).toHaveLength(1);
  });
  it('取消历史读取后收到cleanup拒绝仍拒绝停止确认，不能把aborted当清理成功', async () => {
    const f = await fixture();
    const fail = vi.spyOn(f.streams, 'exec').mockImplementation((_command, options) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(new ObservationExecutionError('cleanup')), { once: true });
    }));
    const monitor = new SystemLogMonitor(new ShellExecutor(), { record: () => {} }, ['fixture.service'], f.streams); monitors.push(monitor);
    try { await monitor.start(); await until(() => fail.mock.calls.length === 1); await expect(monitor.stop()).rejects.toMatchObject({ code: 'cleanup' }); }
    finally { fail.mockRestore(); }
  });
  it('缺执行器或容量满不回退Master，清理拒绝不会报告停止成功', async () => {
    const shell = { exec: vi.fn() }; const missingRows: any[] = [];
    const missing = new SystemLogMonitor(shell, { record: row => missingRows.push(row) }); monitors.push(missing);
    await missing.start(); await missing.stop(); expect(shell.exec).not.toHaveBeenCalled(); expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(missingRows.some(row => row.action === 'tail.unavailable')).toBe(true);
    const f = await fixture(); const ac = new AbortController(); let ready = false;
    const occupied = f.streams.exec('echo occupied; sleep 30', { timeout: 0, signal: ac.signal, onData: () => { ready = true; } }).catch(() => {});
    await until(() => ready); const rows: any[] = [];
    const full = new SystemLogMonitor(shell, { record: row => rows.push(row) }, ['fixture.service'], f.streams); monitors.push(full);
    try { await full.start(); await until(() => rows.length > 0); await full.stop(); expect(await f.trace()).toEqual([]); expect(childProcess.spawn).not.toHaveBeenCalled(); }
    finally { ac.abort(); await occupied; }
    const fail = vi.spyOn(f.streams, 'exec').mockRejectedValue(new ObservationExecutionError('cleanup'));
    const unknown = new SystemLogMonitor(shell, { record: () => {} }, ['fixture.service'], f.streams); monitors.push(unknown);
    await unknown.start(); await until(() => !unknown.getStats().active);
    await expect(unknown.stop()).rejects.toMatchObject({ code: 'cleanup' }); fail.mockRestore();
  });
});
