import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryAuthStore } from '../../src/infra/auth-store/memory-store.js';
import { AuthService, AuthServiceError } from '../../src/services/auth-service.js';
import { GitHubOAuthClient, type FetchLike } from '../../src/services/github-oauth-client.js';

/**
 * Build a stub fetch that serves canned responses for the three GitHub
 * endpoints used by GitHubOAuthClient:
 *   POST /login/oauth/access_token  → returns access_token
 *   GET  /user                       → returns profile
 *   GET  /user/orgs                  → returns org list
 *
 * Overrides let individual tests tweak the returned values without
 * rebuilding the whole fixture.
 */
function stubFetch(overrides: Partial<{
  profile: any;
  orgs: any[];
  accessToken: string;
  tokenStatus: number;
  userStatus: number;
}> = {}): FetchLike {
  const profile = overrides.profile ?? {
    id: 42,
    login: 'alice',
    name: 'Alice Smith',
    email: 'alice@example.com',
    avatar_url: 'https://example.com/a.png',
  };
  const orgs = overrides.orgs ?? [{ id: 100, login: 'inernoro' }];
  const accessToken = overrides.accessToken ?? 'ghat-test-token';
  const tokenStatus = overrides.tokenStatus ?? 200;
  const userStatus = overrides.userStatus ?? 200;

  return async (input: string, _init?: any) => {
    if (input.includes('/login/oauth/access_token')) {
      return {
        ok: tokenStatus >= 200 && tokenStatus < 300,
        status: tokenStatus,
        statusText: 'OK',
        json: async () => ({ access_token: accessToken, token_type: 'bearer' }),
        text: async () => '',
      };
    }
    if (input.endsWith('/user')) {
      return {
        ok: userStatus >= 200 && userStatus < 300,
        status: userStatus,
        statusText: 'OK',
        json: async () => profile,
        text: async () => '',
      };
    }
    if (input.endsWith('/user/orgs')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => orgs,
        text: async () => '',
      };
    }
    throw new Error(`stubFetch: unexpected URL ${input}`);
  };
}

function buildService(config: {
  allowedOrgs?: string[];
  fetchImpl?: FetchLike;
} = {}) {
  const store = new MemoryAuthStore();
  const github = new GitHubOAuthClient({
    clientId: 'test-id',
    clientSecret: 'test-secret',
    fetchImpl: config.fetchImpl ?? stubFetch(),
    oauthBaseUrl: 'https://github.com',
    apiBaseUrl: 'https://api.github.com',
  });
  const service = new AuthService({
    store,
    github,
    config: { allowedOrgs: config.allowedOrgs ?? ['inernoro'] },
  });
  return { store, github, service };
}

describe('AuthService', () => {
  describe('startLogin', () => {
    it('returns an authorize URL containing state', () => {
      const { service } = buildService();
      const result = service.startLogin('https://cds.example.com/api/auth/github/callback', '/projects.html');
      expect(result.authorizeUrl).toContain('https://github.com/login/oauth/authorize');
      expect(result.authorizeUrl).toContain('client_id=test-id');
      expect(result.authorizeUrl).toContain(`state=${result.state}`);
      expect(result.state).toBeTruthy();
    });

    it('stores the post-login redirect under the state token', () => {
      const { service } = buildService();
      service.startLogin('https://x/cb', '/custom-target');
      expect(service._stateStoreSize()).toBe(1);
    });
  });

  describe('handleCallback', () => {
    it('completes the full OAuth flow and creates a session', async () => {
      const { service, store } = buildService();
      const { state } = service.startLogin('https://x/cb', '/projects.html');

      const result = await service.handleCallback({
        code: 'test-code',
        state,
        redirectUri: 'https://x/cb',
        userAgent: 'test-agent',
        ipAddress: '127.0.0.1',
      });

      expect(result.user.githubLogin).toBe('alice');
      expect(result.session.token).toBeTruthy();
      expect(result.redirect).toBe('/projects.html');
      expect(result.bootstrapped).toBe(true); // first user
      expect(await store.countUsers()).toBe(1);
      // first-login bootstrap creates a personal workspace
      expect(await store.countWorkspaces()).toBe(1);
    });

    it('sets isSystemOwner for the first user but not subsequent ones', async () => {
      const { service, store } = buildService();

      const first = service.startLogin('https://x/cb', '/projects.html');
      const firstResult = await service.handleCallback({
        code: 'code1',
        state: first.state,
        redirectUri: 'https://x/cb',
        userAgent: null,
        ipAddress: null,
      });
      expect(firstResult.user.isSystemOwner).toBe(true);
      expect(firstResult.bootstrapped).toBe(true);

      // Second user — different github id
      const store2Fetch = stubFetch({
        profile: { id: 99, login: 'bob', name: 'Bob', email: null, avatar_url: null },
      });
      const { service: svc2 } = buildService({ fetchImpl: store2Fetch });
      // Re-use the original store to simulate a shared deployment
      const svc2Shared = new AuthService({
        store,
        github: new GitHubOAuthClient({
          clientId: 'test-id',
          clientSecret: 'test-secret',
          fetchImpl: store2Fetch,
          oauthBaseUrl: 'https://github.com',
          apiBaseUrl: 'https://api.github.com',
        }),
        config: { allowedOrgs: ['inernoro'] },
      });
      const second = svc2Shared.startLogin('https://x/cb', '/projects.html');
      const secondResult = await svc2Shared.handleCallback({
        code: 'code2',
        state: second.state,
        redirectUri: 'https://x/cb',
        userAgent: null,
        ipAddress: null,
      });
      expect(secondResult.user.isSystemOwner).toBe(false);
      expect(secondResult.bootstrapped).toBe(false);
      expect(await store.countUsers()).toBe(2);
    });

    it('rejects when user is not in any allowed org', async () => {
      const { service } = buildService({
        allowedOrgs: ['only-this-org'],
        fetchImpl: stubFetch({ orgs: [{ id: 200, login: 'some-other-org' }] }),
      });
      const { state } = service.startLogin('https://x/cb', '/projects.html');

      await expect(
        service.handleCallback({
          code: 'code',
          state,
          redirectUri: 'https://x/cb',
          userAgent: null,
          ipAddress: null,
        }),
      ).rejects.toThrow(AuthServiceError);
    });

    it('allows any user when allowedOrgs is empty', async () => {
      const { service } = buildService({
        allowedOrgs: [],
        fetchImpl: stubFetch({ orgs: [] }),
      });
      const { state } = service.startLogin('https://x/cb', '/projects.html');

      const result = await service.handleCallback({
        code: 'code',
        state,
        redirectUri: 'https://x/cb',
        userAgent: null,
        ipAddress: null,
      });
      expect(result.user.githubLogin).toBe('alice');
    });

    it('rejects when state token is unknown (CSRF protection)', async () => {
      const { service } = buildService();
      // Skip startLogin — no state token was registered.
      await expect(
        service.handleCallback({
          code: 'code',
          state: 'forged-state',
          redirectUri: 'https://x/cb',
          userAgent: null,
          ipAddress: null,
        }),
      ).rejects.toThrow(AuthServiceError);
    });

    it('consumes the state token so it cannot be reused', async () => {
      const { service } = buildService();
      const { state } = service.startLogin('https://x/cb', '/projects.html');

      await service.handleCallback({
        code: 'code',
        state,
        redirectUri: 'https://x/cb',
        userAgent: null,
        ipAddress: null,
      });

      await expect(
        service.handleCallback({
          code: 'code',
          state,
          redirectUri: 'https://x/cb',
          userAgent: null,
          ipAddress: null,
        }),
      ).rejects.toThrow(AuthServiceError);
    });

    it('maps upstream GitHub token errors to oauth_upstream', async () => {
      const { service } = buildService({
        fetchImpl: stubFetch({ tokenStatus: 500 }),
      });
      const { state } = service.startLogin('https://x/cb', '/projects.html');

      await expect(
        service.handleCallback({
          code: 'code',
          state,
          redirectUri: 'https://x/cb',
          userAgent: null,
          ipAddress: null,
        }),
      ).rejects.toMatchObject({
        name: 'AuthServiceError',
        code: 'oauth_upstream',
      });
    });
  });

  describe('validateSession', () => {
    it('returns null for missing token', async () => {
      const { service } = buildService();
      expect(await service.validateSession(null)).toBeNull();
    });

    it('returns user+session for a valid token', async () => {
      const { service } = buildService();
      const { state } = service.startLogin('https://x/cb', '/projects.html');
      const result = await service.handleCallback({
        code: 'code',
        state,
        redirectUri: 'https://x/cb',
        userAgent: null,
        ipAddress: null,
      });

      const validated = await service.validateSession(result.session.token);
      expect(validated?.user.id).toBe(result.user.id);
    });

    it('returns null for disabled users', async () => {
      const { service, store } = buildService();
      const { state } = service.startLogin('https://x/cb', '/projects.html');
      const result = await service.handleCallback({
        code: 'code',
        state,
        redirectUri: 'https://x/cb',
        userAgent: null,
        ipAddress: null,
      });
      await store.setUserStatus(result.user.id, 'disabled');

      const validated = await service.validateSession(result.session.token);
      expect(validated).toBeNull();
    });
  });

  describe('logout', () => {
    it('destroys the session so validation returns null', async () => {
      const { service } = buildService();
      const { state } = service.startLogin('https://x/cb', '/projects.html');
      const result = await service.handleCallback({
        code: 'code',
        state,
        redirectUri: 'https://x/cb',
        userAgent: null,
        ipAddress: null,
      });

      await service.logout(result.session.token);
      expect(await service.validateSession(result.session.token)).toBeNull();
    });
  });
});
