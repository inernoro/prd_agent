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
            }
          : { Accept: 'application/json' },
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

  it('uses the configured default redirect when login starts without a redirect', async () => {
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

    const exchange = await call(server, 'POST', '/api/auth/sso/exchange', {
      code: 'a'.repeat(43),
      state,
    });

    expect(exchange.status).toBe(200);
    expect(exchange.body.redirect).toBe('/reports?project=cds-self');
  });
});
