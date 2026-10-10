import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import * as childProcess from 'node:child_process';
import { ObservationStreamExecutor } from '../../src/services/observation-stream-executor.js';
import { ContainerLogStreamHub } from '../../src/services/container-log-stream-hub.js';
import { ContainerService } from '../../src/services/container.js';
import { BoundedLogTail } from '../../src/services/bounded-log-tail.js';
import { BoundedSseWriter, SsePendingBudget, ssePendingBudget } from '../../src/services/bounded-sse-writer.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { createBranchRouter } from '../../src/routes/branches.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import { selfStatusCache } from '../../src/services/self-status-cache.js';
import type { CdsConfig } from '../../src/types.js';
import { EventEmitter } from 'node:events';
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const originalPath = process.env.PATH;
const pools: ObservationStreamExecutor[] = []; const hubs: ContainerLogStreamHub[] = [];
const dirs: string[] = []; const servers: http.Server[] = []; const clients: http.ClientRequest[] = [];
async function until(predicate: () => boolean, limit = 800) {
  for (let i = 0; i < limit; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Log fixture did not settle');
}
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'cds-user-log-')); dirs.push(dir);
  const traceFile = path.join(dir, 'trace.jsonl');
  await writeFile(path.join(dir, 'docker'), `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);const name=args[args.length-1];
fs.appendFileSync(${JSON.stringify(traceFile)},JSON.stringify({pid:process.pid,ppid:process.ppid,args})+'\\n');
if(name==='fixture-fast') {
 setTimeout(()=>{let i=0;const data=Buffer.alloc(32*1024,120);function next(){if(i++>=384){process.stdout.write('\\nFAST-END\\n');setTimeout(()=>process.exit(0),50);return;}if(process.stdout.write(data))setImmediate(next);else process.stdout.once('drain',next);}next();},100);
} else { process.stdout.write('中文初始\\n');process.stderr.write('诊断输出\\n');let i=0;setInterval(()=>process.stdout.write('日志-'+i+++'\\n'),50);setTimeout(()=>process.exit(0),60000); }
`, { mode: 0o700 });
  process.env.PATH = `${dir}:${originalPath || ''}`;
  const streams = new ObservationStreamExecutor(2); pools.push(streams); await streams.start();
  const hub = new ContainerLogStreamHub(streams); hubs.push(hub);
  const config = { repoRoot: dir, worktreeBase: dir, masterPort: 9900, workerPort: 5500, dockerNetwork: 'fixture',
    sharedEnv: {}, portStart: 10001, rootDomains: ['example.test'], previewDomain: 'example.test', jwt: { secret: 'fixture-secret', issuer: 'fixture' } } as CdsConfig;
  const shell = new MockShellExecutor();
  const container = new ContainerService(shell, config, undefined, undefined, undefined, hub);
  vi.clearAllMocks();
  const trace = async () => (await readFile(traceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { dir, streams, hub, config, shell, container, trace };
}
async function routeFixture(name = 'fixture-normal') {
  const f = await fixture(); const state = new StateService(path.join(f.dir, 'state.json')); state.load();
  const now = new Date().toISOString();
  state.addProject({ id: 'fixture-project', slug: 'fixture', name: 'Fixture', kind: 'git', createdAt: now, updatedAt: now });
  state.addBranch({ id: 'fixture-branch', projectId: 'fixture-project', branch: 'fixture', worktreePath: f.dir, status: 'running', createdAt: now,
    services: { api: { profileId: 'api', containerName: name, hostPort: 10001, status: 'running' } } });
  const events: Array<{ action: string }> = [];
  const app = express(); app.use('/api', createBranchRouter({ serverEventLogStore: { record: event => { events.push(event); } }, stateService: state, worktreeService: new WorktreeService(f.shell, f.dir), containerService: f.container, shell: f.shell, config: f.config }));
  const server = app.listen(0, '127.0.0.1'); servers.push(server); await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/branches/fixture-branch/container-logs-stream/api`;
  return { ...f, state, url, events };
}
async function open(url: string, paused = false) {
  return await new Promise<{ response: http.IncomingMessage; request: http.ClientRequest; bytes: () => number; ended: () => boolean }>((resolve, reject) => {
    const request = http.get(url, response => {
      let bytes = 0; let ended = false;
      response.on('error', () => {}); response.on('end', () => { ended = true; });
      if (paused) response.pause(); else response.on('data', chunk => { bytes += chunk.length; });
      resolve({ response, request, bytes: () => bytes, ended: () => ended });
    }); clients.push(request); request.on('error', reject);
  });
}
afterEach(async () => {
  clients.splice(0).forEach(client => client.destroy());
  await Promise.all(servers.splice(0).map(server => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); }));
  for (const result of vi.mocked(childProcess.spawn).mock.results) if (result.type === 'return' && result.value?.spawnfile === 'docker') result.value.kill('SIGKILL');
  await Promise.all(hubs.splice(0).map(hub => hub.close())); await Promise.all(pools.splice(0).map(pool => pool.close()));
  await flushAllJsonStateStores(); selfStatusCache._resetForTests();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
  vi.clearAllMocks();
});

describe('用户日志独立读取与有界发送', () => {
  it('实际同服务三个查看者共享一个独立进程，退出一个不影响其余查看者', async () => {
    const f = await fixture(); const received = [0, 0, 0];
    const handles = received.map((_, i) => f.container.streamLogs('fixture-normal', chunk => { received[i] += Buffer.byteLength(chunk); }, () => {}, 200, 'same-project-branch-service'));
    await until(() => received.every(Boolean)); const trace = await f.trace();
    if (process.env.CDS_USER_LOG_REFERENCE === '1') console.info(JSON.stringify({ referenceTrace: trace }));
    expect(trace).toHaveLength(1); expect(trace[0].ppid).not.toBe(process.pid); expect(childProcess.spawn).not.toHaveBeenCalled();
    handles[0].abort(); expect(f.hub.getStats().subscribers).toBe(2); const before = received[1]; await until(() => received[1] > before);
    handles[1].abort(); handles[2].abort(); await f.hub.close(); expect(f.streams.getStats().admitted).toBe(0); expect(f.hub.getStats().readers).toBe(0);
  });
  it('真实HTTP路由100连接共享读取并保留SSE MIME，断开后归属流和预算归零', async () => {
    const f = await routeFixture(); const connections = await Promise.all(Array.from({ length: 100 }, () => open(f.url)));
    await until(() => connections.every(c => c.bytes() > 0));
    expect(connections.every(c => c.response.statusCode === 200 && c.response.headers['content-type']?.startsWith('text/event-stream'))).toBe(true);
    expect(await f.trace()).toHaveLength(1); expect(f.hub.getStats().subscribers).toBe(100);
    connections.forEach(c => c.request.destroy()); await until(() => f.hub.getStats().subscribers === 0 && f.hub.getStats().readers === 0);
    expect(f.streams.getStats().admitted).toBe(0); expect(ssePendingBudget.bytes).toBe(0);
  }, 15000);
  it('真实HTTP暂停读取不拖住正常查看者，12MiB末尾归档有界且明确截断', async () => {
    const f = await routeFixture('fixture-fast'); const slow = await open(f.url, true); const fast = await open(f.url);
    await until(() => fast.ended(), 1500); await until(() => f.hub.getStats().readers === 0);
    const archives = f.state.getContainerLogArchives('fixture-branch');
    if (process.env.CDS_USER_LOG_REFERENCE === '1') console.info(JSON.stringify({ archiveBytes: archives.map(x => x.byteLength), fastBytes: fast.bytes() }));
    expect(fast.bytes()).toBeGreaterThan(12 * 1024 * 1024);
    expect(archives.length).toBeGreaterThanOrEqual(1); expect(archives.every(x => x.byteLength <= 256 * 1024 + 128)).toBe(true);
    expect(archives.some(x => x.logs?.includes('FAST-END') && x.logs.includes('已截断'))).toBe(true);
    expect(f.events.some(e => e.action === 'container.logs.stream-backpressure')).toBe(true);
    expect(ssePendingBudget.bytes).toBe(0); slow.request.destroy();
  }, 20000);
  it('容量满不从Master兜底，结束后可重用，异常查看者不关闭其他查看者', async () => {
    const f = await fixture(); let healthy = 0; let secondReady = false; let end: string | undefined;
    const a = f.hub.subscribe('one', () => { healthy++; }, () => {}, 200, 'project-a'); const bad = f.hub.subscribe('one', () => false, () => {}, 200, 'project-a');
    const b = f.hub.subscribe('one', () => { secondReady = true; }, () => {}, 200, 'project-b'); const rejected = f.hub.subscribe('three', () => {}, result => { end = result?.reason; });
    await rejected.completion; expect(end).toBe('capacity'); await until(() => healthy > 0 && secondReady);
    expect(bad.signal.aborted).toBe(true); expect(f.hub.getStats().subscribers).toBe(2); expect(await f.trace()).toHaveLength(2);
    a.abort(); await a.completion; const replacement = f.hub.subscribe('three', () => {}, () => {});
    await until(() => f.streams.getStats().admitted === 2); b.abort(); replacement.abort(); await f.hub.close(); expect(f.hub.getStats().subscribers).toBe(0);
  });
  it('尾部UTF-8和对象数量有界，大块裁剪不保留原底层Buffer，小块不无限积累对象', () => {
    const tail = new BoundedLogTail(4096); tail.append('中'.repeat(10000)); expect(tail.text()).not.toContain('\ufffd');
    for (let i = 0; i < 15000; i++) tail.append('a');
    expect(tail.getStats().retainedBytes).toBeLessThanOrEqual(4096); expect(tail.getStats().chunks).toBeLessThanOrEqual(3);
    expect(tail.text()).toContain('已截断'); tail.clear(); expect(tail.getStats().retainedBytes).toBe(0);
  });
  it('实际定时器回收停滞连接，释放全局预算而不无限等drain', async () => {
    class Sink extends EventEmitter {
      writableLength = 0; destroyed = false; writableEnded = false;
      write(frame: string) { this.writableLength += Buffer.byteLength(frame); return false; }
      end() { this.writableEnded = true; this.emit('close'); }
      destroy() { this.destroyed = true; this.emit('close'); }
    }
    const budget = new SsePendingBudget(4096); const sink = new Sink(); let dropped = false;
    const writer = new BoundedSseWriter(sink as unknown as http.ServerResponse, () => { dropped = true; }, budget, 4096, 30);
    expect(writer.send('log', { chunk: 'held' })).toBe(true); await until(() => dropped);
    expect(sink.destroyed).toBe(true); expect(budget.bytes).toBe(0); expect(writer.getStats().queuedFrames).toBe(0);
  });
  it('多个连接合计超限明确拒绝，只释放被断开的连接占用', () => {
    class Sink extends EventEmitter {
      writableLength = 0; destroyed = false; writableEnded = false;
      write(frame: string) { this.writableLength += Buffer.byteLength(frame); return false; }
      end() { this.writableEnded = true; this.emit('close'); }
      destroy() { this.destroyed = true; this.emit('close'); }
    }
    const budget = new SsePendingBudget(2048); const first = new Sink(); const second = new Sink();
    const a = new BoundedSseWriter(first as unknown as http.ServerResponse, () => {}, budget, 4096);
    const b = new BoundedSseWriter(second as unknown as http.ServerResponse, () => {}, budget, 4096);
    expect(a.send('log', { chunk: 'x'.repeat(1400) })).toBe(true); expect(b.send('log', { chunk: 'new' })).toBe(false);
    expect(first.destroyed).toBe(false); expect(second.destroyed).toBe(true); expect(budget.bytes).toBe(first.writableLength);
    a.dispose(); expect(budget.bytes).toBe(0);
  });
  it('destroy尚未close的transport仍计入共同预算，不能提前挪给新连接', () => {
    class Sink extends EventEmitter {
      writableLength = 0; destroyed = false; writableEnded = false;
      write(frame: string) { this.writableLength += Buffer.byteLength(frame); return false; }
      end() { this.writableEnded = true; }
      destroy() { this.destroyed = true; }
    }
    const budget = new SsePendingBudget(2048); const first = new Sink(); const second = new Sink();
    const a = new BoundedSseWriter(first as unknown as http.ServerResponse, () => {}, budget, 2048);
    const b = new BoundedSseWriter(second as unknown as http.ServerResponse, () => {}, budget, 2048);
    expect(a.send('log', { chunk: 'x'.repeat(1400) })).toBe(true); expect(a.send('log', { chunk: 'x'.repeat(1400) })).toBe(false);
    expect(first.destroyed).toBe(true); expect(budget.bytes).toBe(first.writableLength);
    expect(b.send('log', { chunk: 'new' })).toBe(false);
    first.writableLength = 0; first.emit('close'); second.emit('close'); expect(budget.bytes).toBe(0);
  });
  it('发送队列遵守单连接与全局预算，drain保持顺序并完整释放预算', () => {
    class Sink extends EventEmitter {
      writableLength = 0; destroyed = false; writableEnded = false; frames: string[] = []; allow = false;
      write(frame: string) { this.frames.push(frame); if (!this.allow) this.writableLength += Buffer.byteLength(frame); return this.allow; }
      end() { this.writableEnded = true; this.emit('close'); }
      destroy() { this.destroyed = true; this.emit('close'); }
    }
    const budget = new SsePendingBudget(4096); const first = new Sink(); const second = new Sink(); let drops = 0;
    const a = new BoundedSseWriter(first as unknown as http.ServerResponse, () => { drops++; }, budget, 2048);
    const b = new BoundedSseWriter(second as unknown as http.ServerResponse, () => { drops++; }, budget, 2048);
    expect(a.send('log', { chunk: 'first' })).toBe(true); expect(a.send('log', { chunk: 'second' })).toBe(true);
    expect(b.send('log', { chunk: 'other' })).toBe(true); expect(budget.bytes).toBeLessThanOrEqual(4096);
    first.allow = true; first.writableLength = 0; first.emit('drain'); a.end();
    expect(first.frames[1]).toContain('second'); expect(first.writableEnded).toBe(true);
    while (b.send('log', { chunk: 'blocked' })) {} expect(drops).toBe(1); expect(second.destroyed).toBe(true); expect(budget.bytes).toBe(0);
  });
});
