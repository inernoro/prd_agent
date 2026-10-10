import { describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { ContainerService } from '../../src/services/container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { CdsConfig } from '../../src/types.js';
const config = { repoRoot: '/repo', worktreeBase: '/wt', masterPort: 9900, workerPort: 5500,
  dockerNetwork: 'cds-test', portStart: 10001, sharedEnv: {}, jwt: { secret: 'local-test', issuer: 'test' } } as CdsConfig;
const container = () => new ContainerService(new MockShellExecutor(), config);

describe('P3-02 readiness cancellation', () => {
  it('interrupts the initial liveness delay before any Docker inspect', async () => {
    const abort = new AbortController(); const shell = new MockShellExecutor();
    const service = new ContainerService(shell, config); const start = Date.now();
    const waiting = (service as any).waitForContainerAlive('owned-candidate', undefined, abort.signal);
    setTimeout(() => abort.abort(), 30);
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - start).toBeLessThan(300); expect(shell.commands).toEqual([]);
  });
  it('stops before opening a probe when the operation is already cancelled', async () => {
    const abort = new AbortController(); abort.abort(); let attempts = 0;
    const start = Date.now();
    expect(await container().waitForReadiness(1, { noHttp: true, intervalSeconds: 1, timeoutSeconds: 1 },
      () => { attempts++; }, undefined, undefined, abort.signal)).toBe(false);
    expect(attempts).toBe(0); expect(Date.now() - start).toBeLessThan(300);
  });
  it('cancels a retry delay instead of holding the operation for its interval', async () => {
    const abort = new AbortController();
    const reserve = net.createServer(); await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve));
    const port = (reserve.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reserve.close(() => resolve()));
    let attempts = 0; const start = Date.now();
    expect(await container().waitForReadiness(port, { noHttp: true, intervalSeconds: 1, timeoutSeconds: 1 },
      () => { attempts++; queueMicrotask(() => abort.abort()); }, undefined, undefined, abort.signal)).toBe(false);
    expect(attempts).toBe(1); expect(Date.now() - start).toBeLessThan(300);
  });
  it('destroys a pending real HTTP request when cancelled', async () => {
    const abort = new AbortController(); const sockets = new Set<net.Socket>();
    const server = http.createServer(() => abort.abort());
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const start = Date.now(); const port = (server.address() as net.AddressInfo).port;
      expect(await container().waitForReadiness(port, { intervalSeconds: 1, timeoutSeconds: 1 },
        undefined, undefined, undefined, abort.signal)).toBe(false);
      expect(Date.now() - start).toBeLessThan(300);
    } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
