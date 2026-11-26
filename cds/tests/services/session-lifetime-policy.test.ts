import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { listenLoopbackFixture } from '../helpers/loopback-http-fixture.js';

/**
 * 登录有效期是「一份策略管所有登录路径」：GitHub/本地密码会话、ticket SSO 会话、
 * basic 模式的 cds_token 都必须读同一个 sessionTtlMs，且都能滑动续期。
 *
 * 源码守卫覆盖各登录入口的统一时长，回环 HTTP 测试验证 basic 会话实际滑动续期。
 */
const serverSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../src/server.ts'),
  'utf8',
);

describe('session lifetime policy (single source)', () => {
  it('computes the TTL policy once and feeds every login path from it', () => {
    expect(serverSource).toContain('const sessionTtlMs = sessionTtlDays * 24 * 60 * 60 * 1000');
    // ticket SSO 会话
    expect(serverSource).toContain('new TicketSsoSessionStore(sessionTtlMs)');
    // GitHub / 本地密码会话
    expect(serverSource).toContain('config: { allowedOrgs, sessionTtlMs }');
    // basic 模式 cds_token
    expect(serverSource).toContain('basicSessionCookie(humanSessionToken, sessionTtlMs, cookieSecure, hostSessionCookies)');
  });

  it('never hardcodes a login window next to the cookie writers', () => {
    // 曾经的两处硬编码：basic 的 30 天、SSO 的 12 小时。
    expect(serverSource).not.toContain('Max-Age=${30 * 86400}');
    expect(serverSource).not.toContain('12 * 60 * 60 * 1000');
  });

  it('re-issues the basic-mode cookie on authenticated use so it slides', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cds-session-lifetime-'));
    const username = 'fixture-lifetime-owner';
    const password = 'Fixture-Lifetime-Password-83!';
    const ttlSeconds = 2 * 24 * 60 * 60;
    const startedAt = Math.floor(Date.now() / 1000) * 1000;
    let now = startedAt;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let server: Server | undefined;
    try {
      vi.stubEnv('CDS_AUTH_MODE', 'basic');
      vi.stubEnv('CDS_USERNAME', username);
      vi.stubEnv('CDS_PASSWORD', password);
      vi.stubEnv('CDS_BASIC_SESSION_GENERATION', 'fixture-session-generation');
      vi.stubEnv('CDS_SESSION_TTL_DAYS', '2');
      vi.stubEnv('CDS_ENV_FILE', join(root, 'fixture.env'));
      vi.stubEnv('CDS_PUBLIC_BASE_URL', 'http://127.0.0.1');
      vi.stubEnv('CDS_SSO_ENABLED', 'false');
      vi.stubEnv('CDS_PASSKEYS_ENABLED', 'false');

      const { createServer } = await import('../../src/server.js');
      const stateService = new StateService(join(root, 'state.json'));
      stateService.load();
      const shell = new MockShellExecutor();
      server = listenLoopbackFixture(createServer({
        stateService,
        worktreeService: new WorktreeService(shell, root),
        containerService: {} as Parameters<typeof createServer>[0]['containerService'],
        proxyService: {
          getProxyLog: () => [],
          setOnProxyLog: () => {},
          handleSwitchFromExpress: () => {},
        } as unknown as Parameters<typeof createServer>[0]['proxyService'],
        bridgeService: {} as Parameters<typeof createServer>[0]['bridgeService'],
        shell,
        config: {
          repoRoot: root,
          worktreeBase: join(root, 'worktrees'),
          masterPort: 9900,
          workerPort: 5500,
          dockerNetwork: 'cds-test',
          portStart: 10001,
          sharedEnv: {},
          jwt: { secret: 'fixture-only', issuer: 'fixture' },
          mode: 'standalone',
          executorPort: 9901,
          rootDomains: ['test.example.invalid'],
        },
      }));
      if (!server.address()) await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing loopback fixture');

      async function call(endpoint: string, init?: RequestInit) {
        const response = await fetch(`http://127.0.0.1:${address.port}${endpoint}`, {
          ...init, redirect: 'manual', signal: AbortSignal.timeout(3000),
        });
        await response.arrayBuffer();
        return response;
      }

      function authenticatedCookie(response: Response): string {
        expect(response.status).toBe(200);
        const cookie = response.headers.getSetCookie().find(value => /^(?:__Host-)?cds_token=[^;]+/.test(value));
        expect(cookie?.match(/; Max-Age=(\d+)/)?.[1]).toBe(String(ttlSeconds));
        return cookie!.split(';', 1)[0];
      }

      const login = await call('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
      });
      const initialCookie = authenticatedCookie(login);

      const originalExpiry = startedAt + ttlSeconds * 1000;
      now = originalExpiry - 30_000;
      const renewedCookie = authenticatedCookie(await call('/api/projects', { headers: { Cookie: initialCookie } }));
      expect(renewedCookie === initialCookie, 'authenticated use issues a fresh cookie').toBe(false);

      now = originalExpiry + 30_000;
      expect((await call('/api/projects', { headers: { Cookie: initialCookie } })).status).toBe(401);
      expect((await call('/api/projects', { headers: { Cookie: renewedCookie } })).status).toBe(200);

      const machineToken = createHash('sha256').update(`cds:${username}:${password}`).digest('hex');
      const machine = await call('/api/projects', { headers: { 'X-CDS-Token': machineToken } });
      expect(machine.status).toBe(200);
      expect(machine.headers.getSetCookie().length).toBe(0);
    } finally {
      clock.mockRestore();
      if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
      await flushAllJsonStateStores();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
