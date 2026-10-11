import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createProbeDaemonProxy } from '../../scripts/application-docker-inner-drill.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-proxy-wire-'));
  const backendPath = path.join(root, 'daemon.sock'), proxyPath = path.join(root, 'proxy.sock');
  const sockets = new Set<net.Socket>(); let peerEnded = false;
  const backend = http.createServer((_request, response) => { response.writeHead(200); response.end('ordinary'); });
  backend.on('connection', socket => { socket.allowHalfOpen = true; sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  backend.on('upgrade', (_request, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    socket.on('end', () => { peerEnded = true; setTimeout(() => socket.end('stdout-after-stdin-EOF'), 30); });
  });
  await new Promise<void>(resolve => backend.listen(backendPath, resolve));
  const proxy = await createProbeDaemonProxy(proxyPath, backendPath);
  return { backendPath, proxyPath, proxy, get peerEnded() { return peerEnded; },
    close: async () => { await proxy.close(); for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => backend.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); } };
}

async function attach(socketPath: string) {
  const socket = net.createConnection({ path: socketPath, allowHalfOpen: true });
  let wire = '', sentEof = false;
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('attach exchange did not finish')); }, 1000);
    socket.on('connect', () => socket.write('POST /v1.53/containers/' + 'a'.repeat(64) + '/attach?stream=1&stdout=1 HTTP/1.1\r\nHost: owned\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n'));
    socket.on('data', chunk => { wire += chunk.toString(); if (!sentEof && wire.includes('\r\n\r\n')) { sentEof = true; socket.end(); } });
    socket.once('end', () => { clearTimeout(timer); socket.destroy(); resolve(wire); });
    socket.once('error', error => { clearTimeout(timer); socket.destroy(); reject(error); });
  });
}

describe('owned Docker probe proxy wire conformance', () => {
  it('retains stdout after the client closes only the upgraded input side, matching the direct backend', async () => {
    const f = await fixture();
    try {
      const direct = await attach(f.backendPath); expect(direct).toContain('stdout-after-stdin-EOF');
      const proxied = await attach(f.proxyPath);
      expect(proxied).toEqual(direct); expect(f.peerEnded).toBe(true);
    } finally { await f.close(); }
  });
  const cliAvailable = (() => { try { execFileSync('docker', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  it.runIf(cliAvailable)('lets the actual Docker CLI finish attach and send start through either socket without stdin', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-proxy-cli-'));
    const backendPath = path.join(root, 'daemon.sock'), proxyPath = path.join(root, 'proxy.sock'), id = 'b'.repeat(64);
    const sockets = new Set<net.Socket>(), attached = new Set<net.Socket>(), waits = new Set<http.ServerResponse>();
    const starts: string[] = []; let inputEof = 0;
    const backend = http.createServer((request, response) => {
      const send = (status: number, body: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
      if (request.url?.endsWith('/_ping')) { response.writeHead(200, { 'API-Version': '1.53', 'OSType': 'linux' }); response.end('OK'); }
      else if (request.url?.includes('/containers/create')) { request.resume(); request.once('end', () => send(201, { Id: id, Warnings: [] })); }
      else if (request.url?.endsWith('/json')) send(200, { Id: id, Config: { Tty: false, OpenStdin: false }, State: { Running: true }, HostConfig: {} });
      else if (request.url?.includes('/wait')) {
        request.resume(); response.writeHead(200, { 'Content-Type': 'application/json' }); response.flushHeaders(); waits.add(response);
      }
      else if (request.url?.endsWith('/start')) {
        starts.push(request.url); send(204, undefined);
        setTimeout(() => {
          const bytes = Buffer.from('owned-output\n'), header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(bytes.length, 4);
          for (const socket of attached) socket.end(Buffer.concat([header, bytes])); attached.clear();
          for (const waiting of waits) waiting.end('{"StatusCode":0}'); waits.clear();
        }, 30);
      } else send(404, { message: 'unsupported fixture request' });
    });
    backend.on('connection', socket => { socket.allowHalfOpen = true; sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    backend.on('upgrade', (_request, socket) => {
      const peer = socket as net.Socket; attached.add(peer);
      peer.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/vnd.docker.raw-stream\r\n\r\n');
      peer.once('end', () => { inputEof++; }); peer.once('close', () => attached.delete(peer));
    });
    await new Promise<void>(resolve => backend.listen(backendPath, resolve));
    const proxy = await createProbeDaemonProxy(proxyPath, backendPath); proxy.enableTrace();
    try {
      const execute = promisify(execFile);
      for (const socketPath of [backendPath, proxyPath]) {
        let result;
        try { result = await execute('docker', ['--host', `unix://${socketPath}`, 'run', '--rm', '--pull', 'never', 'owned-wire-fixture', 'true'],
          { encoding: 'utf8', timeout: 1500, killSignal: 'SIGKILL', env: { PATH: process.env.PATH, DOCKER_CONFIG: path.join(root, 'empty-config'), DOCKER_API_VERSION: '1.53' } }); }
        catch { throw new Error(JSON.stringify({ route: socketPath === backendPath ? 'direct' : 'proxy', starts: starts.length,
          phases: proxy.requestTimeline.map(event => ({ kind: event.kind, phase: event.phase, status: event.status })) })); }
        expect(result.stdout).toBe('owned-output\n');
      }
      expect(starts).toHaveLength(2); expect(inputEof).toBe(2);
      expect(proxy.requestTimeline).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'container-attach', phase: 'upgrade-response', status: 101 }),
        expect.objectContaining({ kind: 'container-start', phase: 'response-headers', status: 204 }),
      ]));
      expect(proxy.traceOverflow()).toBe(0);
    } finally { await proxy.close(); for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => backend.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); }
  });
});
