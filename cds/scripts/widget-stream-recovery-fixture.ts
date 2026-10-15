/** 自有回环夹具：真实 widget + forwarder + 可停启的独立上游进程；不连接生产或数据库。 */
import http from 'node:http';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { ProxyHandler } from '../src/forwarder/proxy-handler.js';
import { buildWidgetScript } from '../src/widget-script.js';

const stamp = () => new Date().toISOString();
if (process.argv[2] === '--upstream') {
  const status = process.argv[4] || 'running';
  const server = http.createServer((req, res) => {
    if (req.headers['x-cds-source-branch-id'] !== 'fixture-owned') { res.writeHead(403); res.end(); return; }
    if (req.url === '/api/branches/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: snapshot\ndata: {"branches":[]}\n\n');
      return;
    }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/branches') res.end(JSON.stringify({ tabTitleEnabled: false,
      branches: [{ id: 'fixture-owned', projectId: 'fixture-project', status, runningCommitSha: 'a'.repeat(40) }] }));
    else if (req.url?.startsWith('/api/build-profiles')) res.end('{"profiles":[]}');
    else { res.writeHead(404); res.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(Number(process.argv[3]), '127.0.0.1', resolve));
  process.send?.({ ready: true, port: (server.address() as AddressInfo).port, pid: process.pid, at: stamp() });
} else {
  const events: Array<Record<string, unknown>> = [];
  let child: ChildProcess | undefined, upstreamPort = 0, loads = 0;
  const start = (status: string) => new Promise<void>((resolve, reject) => {
    child = fork(fileURLToPath(import.meta.url), ['--upstream', String(upstreamPort), status], {
      execArgv: process.execArgv, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const current = child;
    const timer = setTimeout(() => { current.kill('SIGTERM'); reject(new Error('fixture child readiness exceeded 5s')); }, 5000);
    current.once('error', reject);
    current.once('message', (message: any) => {
      if (!message.ready) return;
      clearTimeout(timer); upstreamPort = message.port;
      events.push({ event: 'upstream-ready', ...message, status }); resolve();
    });
    current.once('exit', (code, signal) => events.push({ event: 'upstream-exit', pid: current.pid, code, signal, at: stamp() }));
  });
  const stop = async () => {
    const current = child;
    if (!current || current.exitCode !== null || current.signalCode !== null) return;
    await new Promise<void>(resolve => { current.once('exit', () => resolve()); current.kill('SIGTERM'); });
    child = undefined;
  };
  await start('running');
  const proxy = new ProxyHandler({ masterPassthroughPort: upstreamPort,
    httpLogStore: { record: row => events.push({ event: 'http', at: stamp(), path: row.path, status: row.status, outcome: row.outcome, code: row.error?.code }) },
  });
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.url === '/' && req.method === 'GET') {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>隔离流恢复验收</title>
          <style>body{font:16px sans-serif;padding:30px}body.dark{background:#161b22;color:#fff}button{margin:8px;padding:12px}textarea{display:block;width:70%;height:150px}</style>
          <h1>隔离流恢复验收</h1><p>只作用于本夹具的独立上游进程。</p>
          <button id="stop" onclick="fetch('/_fixture/stop',{method:'POST'}).then(()=>document.querySelector('#phase').textContent='上游已停')">停止自有上游</button>
          <button id="start" onclick="fetch('/_fixture/start',{method:'POST'}).then(()=>document.querySelector('#phase').textContent='上游已恢复为失败终态')">恢复自有上游</button>
          <button id="theme" onclick="document.body.classList.toggle('dark')">切换主题</button>
          <p id="phase" role="status">上游运行中</p><label for="business-editor">未保存的业务编辑</label><textarea id="business-editor"></textarea>
          <p id="load" data-load="${++loads}">页面加载序号 ${loads}</p>${buildWidgetScript('fixture-owned', 'fixture/main')}</html>`);
        return;
      }
      if (req.url === '/_fixture/stop' && req.method === 'POST') { await stop(); res.end('stopped'); return; }
      if (req.url === '/_fixture/start' && req.method === 'POST') { if (!child) await start('error'); res.end('started'); return; }
      if (req.url === '/_fixture/evidence') {
        res.setHeader('content-type', 'application/json');
        const sources = ['../src/widget-script.ts', '../src/forwarder/proxy-handler.ts', '../src/forwarder/control-plane-stream.ts'];
        res.end(JSON.stringify({ at: stamp(), loads, events, stats: proxy.getStats(),
          sources: Object.fromEntries(sources.map(name => [name, createHash('sha256').update(readFileSync(new URL(name, import.meta.url))).digest('hex')])) }));
        return;
      }
      if (req.url?.startsWith('/_cds/')) {
        await proxy.handle(req, res, { _id: 'fixture-route', host: 'localhost', branchId: 'fixture-owned', upstreamPort: 1, weight: 100 });
        return;
      }
      res.writeHead(404); res.end();
    })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, at: stamp(), pid: process.pid }) + '\n');
  const close = async () => { proxy.destroy(); server.closeAllConnections(); server.close(); await stop(); process.exit(0); };
  process.once('SIGTERM', () => void close()); process.once('SIGINT', () => void close());
}
