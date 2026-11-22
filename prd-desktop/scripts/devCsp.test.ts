import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { expect, it } from 'vitest';
import { devCsp, DEV_CSP_NONCE } from './devCsp';

it('serves a fresh matching CSP nonce on each real dev HTML response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-csp-'));
  await writeFile(join(root, 'index.html'), '<!doctype html><html><head></head><body><script>window.bootstrap = true</script></body></html>');
  const server = await createServer({
    configFile: false,
    root,
    plugins: [devCsp("default-src 'self'; script-src 'self'")],
    html: { cspNonce: DEV_CSP_NONCE },
    server: { host: '127.0.0.1', port: 0 },
  });
  try {
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw new Error('missing HTTP port');
    const nonces: string[] = [];
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`http://127.0.0.1:${address.port}/`);
      const html = await response.text();
      const nonce = response.headers.get('content-security-policy')?.match(/'nonce-([^']+)'/)?.[1];
      expect(nonce).toBeTruthy();
      expect(html).toContain(`nonce="${nonce}"`);
      expect(html).not.toContain(DEV_CSP_NONCE);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(Number(response.headers.get('content-length'))).toBe(Buffer.byteLength(html));
      nonces.push(nonce!);
    }
    expect(nonces[0]).not.toBe(nonces[1]);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
