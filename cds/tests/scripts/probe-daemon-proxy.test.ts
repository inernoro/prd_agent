import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createProbeDaemonProxy, numericProbeExitCode, removalStackSummary } from '../../scripts/application-docker-inner-drill.js';

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
  it.each(['release', 'deadline', 'close'] as const)('holds only the exact original successful stop reply until %s', async mode => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-proxy-stop-'));
    const backendPath = path.join(root, 'daemon.sock'), proxyPath = path.join(root, 'proxy.sock');
    const requests: Array<{ method?: string; url?: string; body: string }> = [], sockets = new Set<net.Socket>();
    const backend = http.createServer((request, response) => {
      let body = ''; request.on('data', chunk => { body += chunk; });
      request.once('end', () => { requests.push({ method: request.method, url: request.url, body }); response.writeHead(204); response.end(); });
    });
    backend.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise<void>(resolve => backend.listen(backendPath, resolve));
    const proxy = await createProbeDaemonProxy(proxyPath, backendPath);
    const gate = proxy.holdNextStop('owned-app-worker');
    const stop = (name: string, body: string) => new Promise<number | null>(resolve => {
      const request = http.request({ socketPath: proxyPath, method: 'POST', path: `/v1.53/containers/${name}/stop?t=10` },
        response => { response.resume(); response.once('end', () => resolve(response.statusCode || null)); });
      request.once('error', () => resolve(null)); request.end(body);
    });
    try {
      expect(await stop('owned-app-worker-other', 'other-body')).toBe(204);
      let received = false; const original = stop('owned-app-worker', 'exact-original-body').then(status => { received = true; return status; });
      const reply = await gate.caught; expect(reply.status).toBe(204); expect(received).toBe(false);
      expect(requests).toEqual([
        { method: 'POST', url: '/v1.53/containers/owned-app-worker-other/stop?t=10', body: 'other-body' },
        { method: 'POST', url: '/v1.53/containers/owned-app-worker/stop?t=10', body: 'exact-original-body' },
      ]);
      if (mode === 'release') { gate.release(); gate.release(); }
      else if (mode === 'close') await proxy.close();
      const status = await original;
      if (mode !== 'close') expect(status).toBe(204);
      expect(gate.expired()).toBe(mode === 'deadline');
      expect(proxy.timeline.filter(event => event.phase === 'original-stop-reply-held')).toHaveLength(1);
      expect(proxy.timeline.filter(event => event.phase === 'fixture-stop-reply-released')).toHaveLength(1);
      expect(requests).toHaveLength(2);
    } finally { await proxy.close(); for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => backend.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); }
  }, 10_000);
  it.each(['release', 'deadline', 'close'] as const)('binds an original app create ID to only its start response until %s', async mode => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-proxy-app-start-'));
    const backendPath = path.join(root, 'daemon.sock'), proxyPath = path.join(root, 'proxy.sock');
    const id = 'c'.repeat(64), otherId = 'd'.repeat(64), imageReference = `127.0.0.1:43210/owned-api@sha256:${'e'.repeat(64)}`;
    const target = { projectId: 'owned-project', branchId: 'owned-project-branch', profileId: 'api-owned', imageReference };
    const labels = { 'cds.managed': 'true', 'cds.type': 'app', 'cds.project.id': target.projectId,
      'cds.branch.id': target.branchId, 'cds.profile.id': target.profileId };
    const rows: Array<{ url: string; body: string }> = [], sockets = new Set<net.Socket>();
    const originalReply = JSON.stringify({ Id: id, Warnings: ['original-warning'] });
    const backend = http.createServer((request, response) => {
      let body = ''; request.on('data', chunk => { body += chunk; }); request.once('end', () => {
        rows.push({ url: request.url!, body });
        if (request.url!.includes('/create')) {
          const config = JSON.parse(body), exact = config.Image === imageReference && Object.entries(labels).every(([key, value]) => config.Labels[key] === value);
          response.writeHead(201, { 'Content-Type': 'application/json', 'X-Original-Receipt': 'created' });
          response.end(exact ? originalReply : JSON.stringify({ Id: otherId, Warnings: [] }));
        } else { response.writeHead(204, { 'X-Original-Receipt': 'started' }); response.end(); }
      });
    });
    backend.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise<void>(resolve => backend.listen(backendPath, resolve));
    const proxy = await createProbeDaemonProxy(proxyPath, backendPath); const gate = proxy.holdNextAppStart(target);
    const post = (url: string, body: string) => new Promise<{ status: number | null; body: string; receipt?: string }>(resolve => {
      const request = http.request({ socketPath: proxyPath, method: 'POST', path: url }, response => {
        let result = ''; response.on('data', chunk => { result += chunk; });
        response.once('end', () => resolve({ status: response.statusCode || null, body: result, receipt: String(response.headers['x-original-receipt'] || '') }));
        response.once('error', () => resolve({ status: null, body: '' }));
      }); request.once('error', () => resolve({ status: null, body: '' })); request.end(body);
    });
    try {
      // Same name is insufficient; project, branch, profile, type and digest are
      // checked on the original request before learning a daemon-issued ID.
      for (const [key, value] of Object.entries(labels)) {
        const wrong = JSON.stringify({ Image: imageReference, Labels: { ...labels, [key]: value + '-foreign' }, Cmd: ['same-original-command'] });
        expect((await post('/v1.53/containers/create?name=owned-app-api', wrong)).status).toBe(201);
        expect(rows.at(-1)?.body).toBe(wrong);
      }
      const wrongImage = JSON.stringify({ Image: imageReference.replace('e'.repeat(64), 'f'.repeat(64)), Labels: labels });
      await post('/v1.53/containers/create?name=owned-app-api', wrongImage); expect(rows.at(-1)?.body).toBe(wrongImage);
      const originalBody = JSON.stringify({ Image: imageReference, Labels: labels, Cmd: ['exact-original-command'], HostConfig: { NetworkMode: 'owned-network' } });
      expect(await post('/v1.53/containers/create?name=owned-app-api', originalBody)).toEqual({ status: 201, body: originalReply, receipt: 'created' });
      expect(rows.at(-1)?.body).toBe(originalBody);
      expect((await post(`/v1.53/containers/${otherId}/start`, 'foreign-start-body')).status).toBe(204);
      let completed = false;
      const original = post(`/v1.53/containers/${id}/start`, 'original-start-body').then(value => { completed = true; return value; });
      expect(await gate.caught).toMatchObject({ status: 204, containerId: id, containerName: 'owned-app-api', imageReference });
      expect(completed).toBe(false); expect(rows.at(-1)?.body).toBe('original-start-body');
      if (mode === 'release') { gate.release(); gate.release(); } else if (mode === 'close') await proxy.close();
      const result = await original; if (mode !== 'close') expect(result).toEqual({ status: 204, body: '', receipt: 'started' });
      expect(gate.expired()).toBe(mode === 'deadline');
      expect(proxy.timeline.filter(event => event.phase === 'original-app-create-replied')).toHaveLength(1);
      expect(proxy.timeline.filter(event => event.phase === 'original-app-start-reply-held')).toHaveLength(1);
      expect(proxy.timeline.filter(event => event.phase === 'fixture-app-start-reply-released')).toHaveLength(1);
      expect(rows).toHaveLength(9);
    } finally { await proxy.close(); for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => backend.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); }
  }, 10_000);

  it.each(['release', 'deadline', 'close'] as const)('holds two exact original infra inspect bodies and releases on %s', async mode => {
    const f = await fixture();
    f.proxy.enableTrace();
    // Use an original real Unix HTTP server rather than an in-memory reply.
    const gate = f.proxy.holdInfraInspects('owned-infra');
    const read = (name: string) => new Promise<{ status: number | null; body: string }>(resolve => {
      const request = http.get({ socketPath: f.proxyPath, path: `/v1.53/containers/${name}/json` }, response => {
        let body = ''; response.on('data', chunk => { body += chunk; }); response.once('end', () => resolve({ status: response.statusCode || null, body }));
        response.once('error', () => resolve({ status: null, body: '' }));
      }); request.once('error', () => resolve({ status: null, body: '' }));
    });
    try {
      expect(await read('owned-infra-other')).toEqual({ status: 200, body: 'ordinary' });
      let completed = 0; const pending = [read('owned-infra'), read('owned-infra')].map(reply => reply.then(value => { completed++; return value; }));
      expect(await gate.caught).toHaveLength(2); expect(completed).toBe(0);
      if (mode === 'release') { gate.release(); gate.release(); } else if (mode === 'close') await f.proxy.close();
      const replies = await Promise.all(pending); if (mode !== 'close') expect(replies).toEqual([{ status: 200, body: 'ordinary' }, { status: 200, body: 'ordinary' }]);
      expect(gate.expired()).toBe(mode === 'deadline');
      expect(f.proxy.timeline.filter(event => event.phase === 'original-infra-inspect-reply-held')).toHaveLength(2);
      expect(f.proxy.timeline.filter(event => event.phase === 'fixture-infra-inspect-released')).toHaveLength(1);
    } finally { await f.close(); }
  }, 7000);
  const healthCliAvailable = (() => { try { execFileSync('docker', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  it.runIf(healthCliAvailable).each(['disconnect', 'unavailable'] as const)('original Docker CLI applies its real retry/failure behavior to controlled %s', async mode => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-infra-cli-'));
    const backendPath = path.join(root, 'daemon.sock'), proxyPath = path.join(root, 'proxy.sock');
    const calls: string[] = [], sockets = new Set<net.Socket>();
    const backend = http.createServer((request, response) => {
      calls.push(request.url || '');
      response.writeHead(200, { 'Content-Type': 'application/json', 'Api-Version': '1.45' });
      response.end(request.url?.endsWith('/json') ? JSON.stringify({ Id: 'a'.repeat(64), Name: '/owned-infra', State: { Health: { Status: 'healthy' } } }) : 'OK');
    });
    backend.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise<void>(resolve => backend.listen(backendPath, resolve));
    const proxy = await createProbeDaemonProxy(proxyPath, backendPath), gate = proxy.holdInfraInspects('owned-infra', 1, mode);
    try {
      const command = promisify(execFile)('docker', ['--host', `unix://${proxyPath}`, 'inspect', '--format', '{{.State.Health.Status}}', 'owned-infra'],
        { encoding: 'utf8', timeout: 5000, env: { ...process.env, DOCKER_API_VERSION: '1.45' } });
      const result = command.then(value => ({ passed: true, stdout: value.stdout }), error => ({ passed: false, code: error.code, message: String(error.message) }));
      expect(await gate.caught).toHaveLength(1); gate.release(); const observed = await result;
      if (mode === 'unavailable') { expect(observed.passed).toBe(false); expect('code' in observed && observed.code).toBe(1); }
      else { expect(observed.passed).toBe(true); expect('stdout' in observed && observed.stdout.trim()).toBe('healthy'); }
      expect(calls.filter(url => url.endsWith('/containers/owned-infra/json'))).toHaveLength(mode === 'disconnect' ? 2 : 1);
    } finally { gate.release(); await proxy.close(); for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => backend.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); }
  }, 10_000);
  it('keeps numerical exit evidence and removal symbols without retaining arbitrary event or stack contents', () => {
    expect(numericProbeExitCode('0')).toBe(0); expect(numericProbeExitCode('137')).toBe(137);
    for (const value of ['secret-value', '0 secret-value', '2147483648', '', null, 0]) expect(numericProbeExitCode(value)).toBeNull();
    const result = removalStackSummary('goroutine 12 [syscall]:\nos.removeAll(0x123, "secret-value")\n\t/private/secret-value.go:12\ngithub.com/docker/docker/daemon.(*Daemon).cleanupContainer(0x123, 0x456)\n\t/owned/secret-value.go:5\n\ngoroutine 15 [chan receive]:\nmain.credentials("secret-value")\n');
    expect(result.matched).toEqual([{ state: 'syscall', functions: ['os.removeAll', 'github.com/docker/docker/daemon.(*Daemon).cleanupContainer'] }]);
    expect(JSON.stringify(result)).not.toContain('secret-value'); expect(JSON.stringify(result)).not.toContain('0x123');
  });
  it('forwards the exact wait result while recording only its numerical terminal outcome', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-proxy-wait-'));
    const backendPath = path.join(root, 'daemon.sock'), proxyPath = path.join(root, 'proxy.sock');
    const sockets = new Set<net.Socket>(), body = JSON.stringify({ StatusCode: 23, Error: { Message: 'secret-value' } });
    const backend = http.createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(body); });
    backend.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise<void>(resolve => backend.listen(backendPath, resolve));
    const samples: unknown[] = [], proxy = await createProbeDaemonProxy(proxyPath, backendPath, 'client-disconnect', async (...args) => { samples.push(args); });
    proxy.enableTrace();
    try {
      const actual = await new Promise<string>((resolve, reject) => {
        const request = http.request({ socketPath: proxyPath, method: 'POST', path: '/v1.53/containers/' + 'a'.repeat(64) + '/wait?condition=removed' }, response => {
          let text = ''; response.on('data', chunk => { text += chunk; }); response.once('end', () => resolve(text)); response.once('error', reject);
        }); request.once('error', reject); request.end();
      });
      expect(actual).toBe(body); expect(samples).toEqual([]);
      expect(proxy.requestTimeline).toContainEqual(expect.objectContaining({ phase: 'wait-terminal', exitCode: 23, errorPresent: true, boundedBody: true }));
      expect(JSON.stringify(proxy.requestTimeline)).not.toContain('secret-value');
    } finally { await proxy.close(); for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => backend.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); }
  });
  it.each(['client-disconnect', 'daemon-created'] as const)('retains the original create body and cancellation order at %s boundary', async boundary => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-proxy-create-'));
    const backendPath = path.join(root, 'daemon.sock'), proxyPath = path.join(root, 'proxy.sock');
    const id = 'c'.repeat(64), bodies: string[] = [], sockets = new Set<net.Socket>();
    let received!: () => void, reply!: () => void;
    const backendReceived = new Promise<void>(resolve => { received = resolve; });
    const backend = http.createServer((request, response) => {
      let body = ''; request.on('data', chunk => { body += chunk; });
      request.once('end', () => {
        bodies.push(body); reply = () => { response.writeHead(201, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ Id: id })); };
        received();
      });
    });
    backend.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise<void>(resolve => backend.listen(backendPath, resolve));
    const proxy = await createProbeDaemonProxy(proxyPath, backendPath, boundary); proxy.arm();
    const body = JSON.stringify({ Image: 'owned-create-fixture', Cmd: ['true'], Entrypoint: [],
      Labels: { 'cds.agent.probe': 'runtime-validation', 'cds.agent.probe.operation': 'd'.repeat(32), 'cds.instance': 'e'.repeat(12) },
      HostConfig: { Memory: 134217728, NanoCpus: 250000000, PidsLimit: 64, ReadonlyRootfs: true, AutoRemove: true, NetworkMode: 'none' } });
    let clientReceivedHeaders = false, caught = false;
    void proxy.caught.then(() => { caught = true; });
    const client = http.request({ socketPath: proxyPath, method: 'POST', path: '/v1.53/containers/create?name=owned-create-fixture' },
      response => { clientReceivedHeaders = true; response.resume(); });
    client.on('error', () => {});
    try {
      client.end(body);
      if (boundary === 'client-disconnect') {
        await proxy.caught; expect(bodies).toHaveLength(0); client.destroy();
        await backendReceived; reply();
      } else {
        await backendReceived; expect(caught).toBe(false); reply(); await proxy.caught;
        expect(clientReceivedHeaders).toBe(false); client.destroy();
      }
      await proxy.settle();
      const deadline = performance.now() + 1000;
      while (!proxy.timeline.some(event => event.phase === 'original-client-disconnected')) {
        if (performance.now() >= deadline) throw new Error('original create client did not disconnect');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(bodies).toEqual([body]); expect(clientReceivedHeaders).toBe(false);
      const phases = proxy.timeline.map(event => event.phase);
      const disconnected = phases.indexOf('original-client-disconnected'), replied = phases.indexOf('backend-create-replied');
      if (boundary === 'daemon-created') { expect(replied).toBeLessThan(disconnected); expect(phases).not.toContain('forward-after-client-disconnect'); }
      else { expect(disconnected).toBeLessThan(phases.indexOf('forward-after-client-disconnect')); expect(disconnected).toBeLessThan(replied); }
      expect(proxy.timeline.find(event => event.phase === 'backend-create-replied')).toMatchObject({ status: 201, containerId: id });
    } finally { client.destroy(); await proxy.close(); for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => backend.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); }
  });

  it('retains stdout after the client closes only the upgraded input side, matching the direct backend', async () => {
    const f = await fixture();
    try {
      const direct = await attach(f.backendPath); expect(direct).toContain('stdout-after-stdin-EOF');
      const proxied = await attach(f.proxyPath);
      expect(proxied).toEqual(direct); expect(f.peerEnded).toBe(true);
    } finally { await f.close(); }
  });
  const cliAvailable = (() => { try { execFileSync('docker', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  it.runIf(cliAvailable)('holds the actual detached Docker CLI only after its original daemon create and start', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-proxy-app-cli-'));
    const backendPath = path.join(root, 'daemon.sock'), proxyPath = path.join(root, 'proxy.sock'), id = 'f'.repeat(64);
    const imageReference = `127.0.0.1:43210/owned-api@sha256:${'e'.repeat(64)}`;
    const target = { projectId: 'owned-project', branchId: 'owned-branch', profileId: 'owned-api', imageReference };
    const labels = { 'cds.managed': 'true', 'cds.type': 'app', 'cds.project.id': target.projectId,
      'cds.branch.id': target.branchId, 'cds.profile.id': target.profileId };
    const sockets = new Set<net.Socket>(), rows: Array<{ url: string; body: string }> = [];
    const backend = http.createServer((request, response) => {
      let body = ''; request.on('data', chunk => { body += chunk; }); request.once('end', () => {
        rows.push({ url: request.url!, body });
        if (request.url!.endsWith('/_ping')) { response.writeHead(200, { 'API-Version': '1.53', OSType: 'linux' }); response.end('OK'); }
        else if (request.url!.includes('/containers/create')) { response.writeHead(201, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ Id: id, Warnings: [] })); }
        else if (request.url!.endsWith('/start')) { response.writeHead(204); response.end(); }
        else { response.writeHead(404, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ message: 'unsupported fixture request' })); }
      });
    });
    backend.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise<void>(resolve => backend.listen(backendPath, resolve));
    const proxy = await createProbeDaemonProxy(proxyPath, backendPath), gate = proxy.holdNextAppStart(target);
    const args = ['--host', `unix://${proxyPath}`, 'run', '-d', '--pull', 'never', '--name', 'owned-app-api',
      ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]), imageReference];
    let completed = false;
    const command = promisify(execFile)('docker', args, { timeout: 8000, encoding: 'utf8' }).then(result => { completed = true; return result; });
    void command.catch(() => {});
    try {
      const held = await Promise.race([gate.caught, command.then(() => { throw new Error('actual CLI completed without start gate'); })]);
      expect(held.containerId).toBe(id); expect(completed).toBe(false);
      const creation = rows.find(row => row.url.includes('/containers/create')); expect(creation).toBeDefined();
      expect(JSON.parse(creation!.body)).toMatchObject({ Image: imageReference, Labels: labels });
      expect(rows.filter(row => row.url.endsWith(`/${id}/start`))).toHaveLength(1);
      gate.release(); const result = await command; expect(result.stdout.trim()).toBe(id);
      expect(gate.expired()).toBe(false); expect(proxy.timeline.filter(event => event.phase === 'original-app-create-replied')).toHaveLength(1);
    } finally { gate.release(); await command.catch(() => {}); await proxy.close(); for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => backend.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); }
  }, 12_000);

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
