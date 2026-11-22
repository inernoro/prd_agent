import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import {
  createTicketSsoConfigRouter,
  createTicketSsoPublicRouter,
} from '../../src/routes/ticket-sso.js';
import {
  TicketSsoSessionStore,
  TicketSsoStateStore,
  normalizeTicketSsoConfig,
} from '../../src/services/ticket-sso.js';

type TestResponse = {
  status: number;
  body: any;
  headers: http.IncomingHttpHeaders;
};

async function start(app: express.Express): Promise<http.Server> {
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

async function call(
  server: http.Server,
  method: string,
  path: string,
  body?: unknown,
  headers?: http.OutgoingHttpHeaders,
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const send = () => {
      const address = server.address() as { port: number };
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({
        hostname: '127.0.0.1',
        port: address.port,
        path,
        method,
        headers: payload
          ? {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              'Content-Length': String(Buffer.byteLength(payload)),
              ...headers,
            }
          : { Accept: 'application/json', ...headers },
      }, (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => {
          raw += chunk.toString();
        });
        res.on('end', () => {
          let parsed: unknown = raw;
          try {
            parsed = JSON.parse(raw);
          } catch {
            // Redirect responses intentionally have a non-JSON body.
          }
          resolve({
            status: res.statusCode || 0,
            body: parsed,
            headers: res.headers,
          });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    };
    if (server.listening) send();
    else server.once('listening', send);
  });
}

describe('ticket SSO routes', () => {
  let server: http.Server | null = null;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  it('requires a verified human owner before changing global SSO config', async () => {
    const saveConfig = vi.fn();
    const app = express();
    app.use(express.json());
    app.use('/api', createTicketSsoConfigRouter({
      getConfig: () => normalizeTicketSsoConfig({ enabled: false }),
      saveConfig,
      normalizeConfig: normalizeTicketSsoConfig,
      canWriteConfig: () => false,
    }));
    server = await start(app);

    const readResponse = await call(server, 'GET', '/api/auth/sso/config');
    expect(readResponse.status).toBe(403);
    expect(readResponse.body.error).toBe('human_owner_required');

    const response = await call(server, 'PUT', '/api/auth/sso/config', {
      enabled: false,
      label: '组织账号登录',
    });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('human_owner_required');
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('allows a verified human owner to change global SSO config', async () => {
    const saveConfig = vi.fn();
    const app = express();
    app.use(express.json());
    app.use('/api', createTicketSsoConfigRouter({
      getConfig: () => normalizeTicketSsoConfig({ enabled: false }),
      saveConfig,
      normalizeConfig: normalizeTicketSsoConfig,
      canWriteConfig: () => true,
    }));
    server = await start(app);

    const response = await call(server, 'PUT', '/api/auth/sso/config', {
      enabled: false,
      label: '组织账号登录',
    });

    expect(response.status).toBe(200);
    expect(response.body.label).toBe('组织账号登录');
    expect(saveConfig).toHaveBeenCalledOnce();
  });

  it('keeps environment-managed SSO config read-only without persisting effective secrets', async () => {
    const saveConfig = vi.fn();
    const app = express();
    app.use(express.json());
    app.use('/api', createTicketSsoConfigRouter({
      getConfig: () => normalizeTicketSsoConfig({
        enabled: true,
        authorizationUrl: 'https://map.example/authorize',
        tokenUrl: 'https://map.example/token',
        clientId: 'cds-console',
        clientSecret: 'environment-secret',
      }),
      saveConfig,
      normalizeConfig: normalizeTicketSsoConfig,
      canWriteConfig: () => true,
      isEnvironmentManaged: () => true,
    }));
    server = await start(app);

    const readResponse = await call(server, 'GET', '/api/auth/sso/config');
    expect(readResponse.status).toBe(200);
    expect(readResponse.body.managedByEnvironment).toBe(true);
    expect(readResponse.body.clientSecret).toBeUndefined();

    const writeResponse = await call(server, 'PUT', '/api/auth/sso/config', {
      enabled: true,
      label: '新的登录名称',
    });
    expect(writeResponse.status).toBe(409);
    expect(writeResponse.body.error).toBe('sso_config_managed_by_environment');
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it.each([
    { hostSessionCookies: false, prefix: '' },
    { hostSessionCookies: true, prefix: '__Host-' },
  ])('preserves the default Ticket SSO redirect with host session cookies set to $hostSessionCookies', async ({ hostSessionCookies, prefix }) => {
    const config = normalizeTicketSsoConfig({
      enabled: true,
      authorizationUrl: 'https://map.example/api/console-sso/authorize',
      tokenUrl: 'https://map.example/api/console-sso/token',
      clientId: 'cds-console',
      clientSecret: 'secret-value',
      defaultRedirect: '/reports?project=cds-self',
    });
    const app = express();
    app.use(express.json());
    app.use('/api', createTicketSsoPublicRouter({
      resolveConfig: () => config,
      publicBaseUrl: 'https://cds.example',
      cookieSecure: true,
      hostSessionCookies,
      stateStore: new TicketSsoStateStore(),
      sessionStore: new TicketSsoSessionStore(),
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        success: true,
        data: {
          subject: 'map:user-1',
          username: 'operator',
          displayName: 'Operator',
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch,
    }));
    server = await start(app);

    const startResponse = await call(server, 'GET', '/api/auth/sso/start');
    expect(startResponse.status).toBe(302);
    const state = new URL(String(startResponse.headers.location)).searchParams.get('state');
    expect(state).toBeTruthy();
    const flow = startResponse.headers['set-cookie']?.find(cookie => cookie.startsWith('__Host-cds-ticket-flow='));
    if (hostSessionCookies) {
      expect(flow).toContain('; Secure');
      const unbound = await call(server, 'POST', '/api/auth/sso/exchange', { code: 'a'.repeat(43), state });
      expect(unbound.status).toBe(400);
      expect(unbound.body.code).toBe('sso_state_invalid');
    } else {
      expect(flow).toBeUndefined();
    }

    const exchange = await call(server, 'POST', '/api/auth/sso/exchange', {
      code: 'a'.repeat(43),
      state,
    }, {
      Cookie: flow?.split(';')[0] ?? 'cds_gh_session=github-token; cds_token=basic-token',
    });

    expect(exchange.status).toBe(200);
    expect(exchange.body.redirect).toBe('/reports?project=cds-self');
    expect(exchange.headers['set-cookie']).toEqual(expect.arrayContaining([
      expect.stringMatching(new RegExp(`^${prefix}cds_sso_session=.*; Secure`)),
      expect.stringMatching(new RegExp(`^${prefix}cds_gh_session=.*Max-Age=0`)),
      expect.stringMatching(new RegExp(`^${prefix}cds_token=.*Max-Age=0`)),
    ]));
  });

  it('uses the canonical public base URL instead of forwarded host headers', async () => {
    const config = normalizeTicketSsoConfig({
      enabled: true,
      authorizationUrl: 'https://map.example/api/console-sso/authorize',
      tokenUrl: 'https://map.example/api/console-sso/token',
      clientId: 'cds-console',
      clientSecret: 'secret-value',
    });
    const app = express();
    app.use(express.json());
    app.use('/api', createTicketSsoPublicRouter({
      resolveConfig: () => config,
      publicBaseUrl: 'https://cds.example/base-path',
      cookieSecure: true,
      stateStore: new TicketSsoStateStore(),
      sessionStore: new TicketSsoSessionStore(),
    }));
    server = await start(app);

    const response = await call(server, 'GET', '/api/auth/sso/start', undefined, {
      'X-Forwarded-Host': 'attacker.allowed.example',
      'X-Forwarded-Proto': 'https',
    });

    expect(response.status).toBe(302);
    const location = new URL(String(response.headers.location));
    expect(location.searchParams.get('redirect_uri')).toBe('https://cds.example/auth/sso');
  });

  it('keeps two preview return paths independently bound under host-only sessions', async () => {
    const config = normalizeTicketSsoConfig({
      enabled: true, providerId: 'cds-preview', authorizationUrl: 'https://parent.example/preview/authorize',
      tokenUrl: 'https://parent.example/api/auth/preview/token', clientId: 'fixture', clientSecret: 'fixture-secret',
    });
    const requests: unknown[] = [];
    const app = express();
    app.use(express.json());
    app.use('/api', createTicketSsoPublicRouter({
      resolveConfig: () => config, publicBaseUrl: 'https://preview.example', cookieSecure: true, hostSessionCookies: true,
      stateStore: new TicketSsoStateStore(), sessionStore: new TicketSsoSessionStore(),
      fetchImpl: vi.fn(async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ success: true, data: { subject: 'fixture-user', username: 'member', displayName: 'Fixture member' } }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch,
    }));
    server = await start(app);
    const destinations = ['/engineering-planning?view=board#proposal', '/design?version=2#spec'];
    const flows = await Promise.all(destinations.map(async destination => {
      const response = await call(server!, 'GET', '/api/auth/sso/start?' + new URLSearchParams({ redirect: destination }));
      expect(response.status).toBe(302);
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      const target = new URL(String(response.headers.location));
      expect(target.searchParams.get('return_to')).toBe(destination);
      const cookies = response.headers['set-cookie'];
      expect(cookies).toEqual([expect.stringMatching(/^__Host-cds_preview_flow_.*; Secure/)]);
      return { state: target.searchParams.get('state'), cookie: cookies![0].split(';')[0] };
    }));
    expect(flows[0].cookie.split('=')[0]).not.toBe(flows[1].cookie.split('=')[0]);
    const exchange = (index: number, cookie: string) => call(server!, 'POST', '/api/auth/sso/exchange', {
      state: flows[index].state, code: 'a'.repeat(43),
    }, { Cookie: cookie });
    expect((await exchange(0, flows[1].cookie)).status).toBe(400);
    expect(requests).toHaveLength(0);
    for (const index of [1, 0]) {
      const result = await exchange(index, flows[index].cookie);
      expect(result.status).toBe(200);
      expect(result.body.redirect).toBe(destinations[index]);
      expect(result.headers['set-cookie']).toEqual(expect.arrayContaining([
        expect.stringContaining(`${flows[index].cookie.split('=')[0]}=;`),
        expect.stringMatching(/^__Host-cds_sso_session=.*; Secure/),
      ]));
    }
    expect(requests).toMatchObject([{ state: flows[1].state }, { state: flows[0].state }]);
  });

  it('rejects excess SSO starts without invalidating an existing authorization state', async () => {
    const config = normalizeTicketSsoConfig({
      enabled: true,
      authorizationUrl: 'https://map.example/api/console-sso/authorize',
      tokenUrl: 'https://map.example/api/console-sso/token',
      clientId: 'cds-console',
      clientSecret: 'secret-value',
    });
    const stateStore = new TicketSsoStateStore({ maxEntries: 1 });
    const app = express();
    app.use('/api', createTicketSsoPublicRouter({
      resolveConfig: () => config,
      publicBaseUrl: 'https://cds.example',
      cookieSecure: true,
      stateStore,
      sessionStore: new TicketSsoSessionStore(),
    }));
    server = await start(app);

    const first = await call(server, 'GET', '/api/auth/sso/start?redirect=%2Fproject-list');
    const firstState = new URL(String(first.headers.location)).searchParams.get('state');
    const excess = await call(server, 'GET', '/api/auth/sso/start');

    expect(excess.status).toBe(429);
    expect(excess.body.code).toBe('sso_state_capacity_exceeded');
    expect(stateStore.consume(firstState)).toMatchObject({ redirect: '/project-list' });
  });

  it('reports provider timeouts separately from invalid tickets', async () => {
    const config = normalizeTicketSsoConfig({
      enabled: true,
      authorizationUrl: 'https://map.example/api/console-sso/authorize',
      tokenUrl: 'https://map.example/api/console-sso/token',
      clientId: 'cds-console',
      clientSecret: 'secret-value',
    });
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      })
    ));
    const app = express();
    app.use(express.json());
    app.use('/api', createTicketSsoPublicRouter({
      resolveConfig: () => config,
      publicBaseUrl: 'https://cds.example',
      cookieSecure: true,
      stateStore: new TicketSsoStateStore(),
      sessionStore: new TicketSsoSessionStore(),
      fetchImpl: fetchImpl as typeof fetch,
      tokenExchangeTimeoutMs: 5,
    }));
    server = await start(app);

    const startResponse = await call(server, 'GET', '/api/auth/sso/start');
    const state = new URL(String(startResponse.headers.location)).searchParams.get('state');
    const exchange = await call(server, 'POST', '/api/auth/sso/exchange', {
      code: 'a'.repeat(43),
      state,
    });

    expect(exchange.status).toBe(504);
    expect(exchange.body.code).toBe('sso_provider_timeout');
  });

  it('reports provider connection failures separately from invalid tickets', async () => {
    const config = normalizeTicketSsoConfig({
      enabled: true,
      authorizationUrl: 'https://map.example/api/console-sso/authorize',
      tokenUrl: 'https://map.example/api/console-sso/token',
      clientId: 'cds-console',
      clientSecret: 'secret-value',
    });
    const app = express();
    app.use(express.json());
    app.use('/api', createTicketSsoPublicRouter({
      resolveConfig: () => config,
      publicBaseUrl: 'https://cds.example',
      cookieSecure: true,
      stateStore: new TicketSsoStateStore(),
      sessionStore: new TicketSsoSessionStore(),
      fetchImpl: vi.fn(async () => {
        throw new TypeError('connection refused');
      }) as typeof fetch,
    }));
    server = await start(app);

    const startResponse = await call(server, 'GET', '/api/auth/sso/start');
    const state = new URL(String(startResponse.headers.location)).searchParams.get('state');
    const exchange = await call(server, 'POST', '/api/auth/sso/exchange', {
      code: 'a'.repeat(43),
      state,
    });

    expect(exchange.status).toBe(502);
    expect(exchange.body.code).toBe('sso_provider_unavailable');
  });

  it('classifies provider 5xx responses as unavailable and explicit ticket rejection as invalid', async () => {
    const config = normalizeTicketSsoConfig({
      enabled: true,
      authorizationUrl: 'https://map.example/api/console-sso/authorize',
      tokenUrl: 'https://map.example/api/console-sso/token',
      clientId: 'cds-console',
      clientSecret: 'secret-value',
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('upstream unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: false,
        error: { message: 'ticket expired' },
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }));
    const app = express();
    app.use(express.json());
    app.use('/api', createTicketSsoPublicRouter({
      resolveConfig: () => config,
      publicBaseUrl: 'https://cds.example',
      cookieSecure: true,
      stateStore: new TicketSsoStateStore(),
      sessionStore: new TicketSsoSessionStore(),
      fetchImpl: fetchImpl as typeof fetch,
    }));
    server = await start(app);

    const firstStart = await call(server, 'GET', '/api/auth/sso/start');
    const firstState = new URL(String(firstStart.headers.location)).searchParams.get('state');
    const unavailable = await call(server, 'POST', '/api/auth/sso/exchange', {
      code: 'a'.repeat(43),
      state: firstState,
    });
    expect(unavailable.status).toBe(502);
    expect(unavailable.body.code).toBe('sso_provider_unavailable');

    const secondStart = await call(server, 'GET', '/api/auth/sso/start');
    const secondState = new URL(String(secondStart.headers.location)).searchParams.get('state');
    const rejected = await call(server, 'POST', '/api/auth/sso/exchange', {
      code: 'b'.repeat(43),
      state: secondState,
    });
    expect(rejected.status).toBe(401);
    expect(rejected.body.code).toBe('sso_exchange_failed');
  });

  it('rejects non-loopback callback hosts when no canonical base URL is configured', async () => {
    const config = normalizeTicketSsoConfig({
      enabled: true,
      authorizationUrl: 'https://map.example/api/console-sso/authorize',
      tokenUrl: 'https://map.example/api/console-sso/token',
      clientId: 'cds-console',
      clientSecret: 'secret-value',
    });
    const app = express();
    app.use('/api', createTicketSsoPublicRouter({
      resolveConfig: () => config,
      cookieSecure: false,
      stateStore: new TicketSsoStateStore(),
      sessionStore: new TicketSsoSessionStore(),
    }));
    server = await start(app);

    const response = await call(server, 'GET', '/api/auth/sso/start', undefined, {
      Host: 'attacker.allowed.example',
      'X-Forwarded-Host': 'attacker.allowed.example',
      'X-Forwarded-Proto': 'https',
    });

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/login?sso_error=invalid_callback');
  });

  it('clears every CDS login cookie and invalidates the alternate server session on SSO logout', async () => {
    const sessionStore = new TicketSsoSessionStore();
    const ssoSession = sessionStore.create({
      subject: 'provider:user-1',
      username: 'sso-user',
      displayName: 'SSO User',
    });
    const logoutGithubSession = vi.fn(async () => undefined);
    const app = express();
    app.use('/api', createTicketSsoPublicRouter({
      resolveConfig: () => normalizeTicketSsoConfig({ enabled: false }),
      publicBaseUrl: 'https://cds.example',
      cookieSecure: true,
      stateStore: new TicketSsoStateStore(),
      sessionStore,
      logoutGithubSession,
    }));
    server = await start(app);

    const response = await call(server, 'POST', '/api/auth/sso/logout', undefined, {
      Cookie: `cds_sso_session=${ssoSession.token}; cds_gh_session=github-token; cds_token=basic-token`,
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(sessionStore.get(ssoSession.token)).toBeNull();
    expect(logoutGithubSession).toHaveBeenCalledWith('github-token');
    const cleared = response.headers['set-cookie'] as string[];
    expect(cleared).toHaveLength(3);
    expect(cleared).toEqual(expect.arrayContaining([
      expect.stringMatching(/^cds_sso_session=.*Max-Age=0/),
      expect.stringMatching(/^cds_gh_session=.*Max-Age=0/),
      expect.stringMatching(/^cds_token=.*Max-Age=0/),
    ]));
  });

  it('still clears browser login cookies when alternate server session invalidation fails', async () => {
    const app = express();
    app.use('/api', createTicketSsoPublicRouter({
      resolveConfig: () => normalizeTicketSsoConfig({ enabled: false }),
      publicBaseUrl: 'https://cds.example',
      cookieSecure: true,
      stateStore: new TicketSsoStateStore(),
      sessionStore: new TicketSsoSessionStore(),
      logoutGithubSession: vi.fn(async () => {
        throw new Error('store unavailable');
      }),
    }));
    server = await start(app);

    const response = await call(server, 'POST', '/api/auth/sso/logout', undefined, {
      Cookie: 'cds_gh_session=github-token; cds_token=basic-token',
    });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      success: false,
      error: 'alternate_session_logout_failed',
    });
    const cleared = response.headers['set-cookie'] as string[];
    expect(cleared).toHaveLength(3);
    expect(cleared.every((cookie) => cookie.includes('Max-Age=0'))).toBe(true);
  });
});
