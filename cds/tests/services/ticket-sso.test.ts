import { describe, expect, it, vi } from 'vitest';
import {
  TicketSsoSessionStore,
  TicketSsoStateStore,
  buildTicketSsoAuthorizationUrl,
  exchangeTicketSsoCode,
  isTicketSsoEnvironmentManaged,
  normalizeTicketSsoConfig,
  publicTicketSsoConfig,
  resolveTicketSsoConfig,
} from '../../src/services/ticket-sso.js';
import type { StateService } from '../../src/services/state.js';

describe('ticket SSO', () => {
  const config = normalizeTicketSsoConfig({
    enabled: true,
    providerId: 'corporate',
    label: '使用公司账号登录',
    authorizationUrl: 'https://map.example/api/console-sso/authorize',
    tokenUrl: 'https://map.example/api/console-sso/token',
    clientId: 'cds-console',
    clientSecret: 'secret-value',
    defaultRedirect: '/project-list',
  });

  it('detects any environment-owned SSO field', () => {
    expect(isTicketSsoEnvironmentManaged({})).toBe(false);
    expect(isTicketSsoEnvironmentManaged({ CDS_SSO_LABEL: '组织账号登录' })).toBe(true);
    expect(isTicketSsoEnvironmentManaged({ CDS_SSO_ENABLED: '0' })).toBe(true);
  });

  it('builds a provider-neutral authorization URL and keeps the callback exact', () => {
    const url = new URL(buildTicketSsoAuthorizationUrl(
      config,
      'https://cds.example/auth/sso',
      'state-token',
    ));
    expect(url.origin + url.pathname).toBe('https://map.example/api/console-sso/authorize');
    expect(url.searchParams.get('client_id')).toBe('cds-console');
    expect(url.searchParams.get('redirect_uri')).toBe('https://cds.example/auth/sso');
    expect(url.searchParams.get('state')).toBe('state-token');
    expect(publicTicketSsoConfig(config)).toEqual({
      enabled: true,
      providerId: 'corporate',
      label: '使用公司账号登录',
    });
  });

  it('consumes login state once and rejects unsafe redirects', () => {
    const store = new TicketSsoStateStore();
    const issued = store.issue('https://evil.example', 'https://cds.example/auth/sso');
    expect(issued.redirect).toBe('/project-list');
    expect(store.consume(issued.state)).toEqual({
      redirect: '/project-list',
      callbackUrl: 'https://cds.example/auth/sso',
    });
    expect(store.consume(issued.state)).toBeNull();
  });

  it('rejects backslash-based SSO return paths before browser navigation', () => {
    const store = new TicketSsoStateStore();
    const decodedBackslash = store.issue('/\\evil.example/x.html', 'https://cds.example/auth/sso');
    const encodedBackslash = store.issue('/%5Cevil.example/x.html', 'https://cds.example/auth/sso');

    expect(store.consume(decodedBackslash.state)?.redirect).toBe('/project-list');
    expect(store.consume(encodedBackslash.state)?.redirect).toBe('/project-list');
  });

  it('preserves a missing redirect so exchange can use the configured default', () => {
    const store = new TicketSsoStateStore();
    const issued = store.issue(undefined, 'https://cds.example/auth/sso');
    expect(issued.redirect).toBeNull();
    expect(store.consume(issued.state)?.redirect).toBeNull();
  });

  it('caps outstanding login states by evicting the oldest state', () => {
    let now = 1_000;
    const store = new TicketSsoStateStore({
      maxEntries: 3,
      ttlMs: 300_000,
      gcIntervalMs: 30_000,
      now: () => now,
    });
    const first = store.issue('/first', 'https://cds.example/auth/sso');
    now += 1;
    const second = store.issue('/second', 'https://cds.example/auth/sso');
    now += 1;
    const third = store.issue('/third', 'https://cds.example/auth/sso');
    now += 1;
    const fourth = store.issue('/fourth', 'https://cds.example/auth/sso');

    expect(store.consume(first.state)).toBeNull();
    expect(store.consume(second.state)?.redirect).toBe('/second');
    expect(store.consume(third.state)?.redirect).toBe('/third');
    expect(store.consume(fourth.state)?.redirect).toBe('/fourth');
  });

  it('rejects an expired login state even between periodic cleanup passes', () => {
    let now = 5_000;
    const store = new TicketSsoStateStore({
      ttlMs: 100,
      gcIntervalMs: 10_000,
      now: () => now,
    });
    const issued = store.issue('/project-list', 'https://cds.example/auth/sso');
    now += 101;

    expect(store.consume(issued.state)).toBeNull();
  });

  it('accepts only HTTPS URLs or local HTTP development URLs', () => {
    expect(normalizeTicketSsoConfig({
      authorizationUrl: 'http://localhost:5500/authorize',
      tokenUrl: 'http://127.0.0.1:5000/token',
    })).toMatchObject({
      authorizationUrl: 'http://localhost:5500/authorize',
      tokenUrl: 'http://127.0.0.1:5000/token',
    });
    expect(normalizeTicketSsoConfig({
      authorizationUrl: 'ftp://localhost/authorize',
      tokenUrl: 'javascript://localhost/token',
    })).toMatchObject({
      authorizationUrl: '',
      tokenUrl: '',
    });
  });

  it('creates opaque sessions and deletes them on logout', () => {
    const sessions = new TicketSsoSessionStore();
    const identity = { subject: 'map:1', username: 'admin', displayName: 'Admin' };
    const session = sessions.create(identity);
    expect(session.token).not.toContain('admin');
    expect(sessions.get(session.token)).toEqual(identity);
    sessions.delete(session.token);
    expect(sessions.get(session.token)).toBeNull();
  });

  it('overrides only explicitly supplied environment fields and can disable stored SSO', () => {
    const stateService = {
      getSsoConfig: () => config,
    } as StateService;
    const labelOverride = resolveTicketSsoConfig(stateService, {
      CDS_SSO_LABEL: '组织账号登录',
    });
    expect(labelOverride.enabled).toBe(true);
    expect(labelOverride.clientId).toBe('cds-console');
    expect(labelOverride.label).toBe('组织账号登录');

    const disabled = resolveTicketSsoConfig(stateService, {
      CDS_SSO_ENABLED: 'false',
    });
    expect(disabled.enabled).toBe(false);
    expect(disabled.clientId).toBe('cds-console');
  });

  it('exchanges a single-use ticket without leaking client secret into the URL', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(String(_url)).toBe('https://map.example/api/console-sso/token');
      const body = JSON.parse(String(init?.body));
      expect(body.client_secret).toBe('secret-value');
      return new Response(JSON.stringify({
        success: true,
        data: {
          subject: 'map:user-1',
          username: 'inernoro',
          displayName: 'Iner Noro',
          email: 'user@example.com',
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const identity = await exchangeTicketSsoCode(
      config,
      'a'.repeat(43),
      'https://cds.example/auth/sso',
      fetchImpl as typeof fetch,
    );
    expect(identity).toEqual({
      subject: 'map:user-1',
      username: 'inernoro',
      displayName: 'Iner Noro',
      email: 'user@example.com',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
