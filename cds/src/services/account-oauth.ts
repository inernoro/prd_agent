import type { GitHubOAuthClient } from './github-oauth-client.js';

export interface AccountOAuthDriver {
  authorizationUrl(input: { redirectUri: string; state: string; codeChallenge: string }): string;
  complete(input: { code: string; redirectUri: string; codeVerifier: string }): Promise<{ subject: string; label: string }>;
}

export function githubAccountOAuth(client: GitHubOAuthClient, allowedOrgs: string[]): AccountOAuthDriver {
  return {
    authorizationUrl: ({ state, redirectUri, codeChallenge }) => client.buildAuthorizeUrl(state, redirectUri, codeChallenge),
    async complete({ code, redirectUri, codeVerifier }) {
      const token = await client.exchangeCodeForToken(code, redirectUri, codeVerifier);
      const profile = await client.fetchProfile(token);
      if (allowedOrgs.length) {
        const orgs = await client.fetchOrgs(token);
        if (!orgs.some(org => allowedOrgs.some(allowed => allowed.toLowerCase() === org.login.toLowerCase()))) {
          throw new Error('GitHub organisation is not allowed');
        }
      }
      return { subject: String(profile.id), label: profile.login };
    },
  };
}

export function googleAccountOAuth(clientId: string, clientSecret: string): AccountOAuthDriver {
  return {
    authorizationUrl({ redirectUri, state, codeChallenge }) {
      const query = new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
        scope: 'openid profile email', state, code_challenge: codeChallenge, code_challenge_method: 'S256',
        prompt: 'select_account',
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${query}`;
    },
    async complete({ code, redirectUri, codeVerifier }) {
      const exchange = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        body: new URLSearchParams({
          code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri,
          grant_type: 'authorization_code', code_verifier: codeVerifier,
        }),
      });
      if (!exchange.ok) throw new Error('Google token exchange failed');
      const response = await exchange.json() as { access_token?: string };
      if (!response.access_token) throw new Error('Google access token unavailable');
      // The subject is obtained from Google's UserInfo endpoint using the
      // access token exchanged directly for this browser's verified code.
      const result = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${response.access_token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!result.ok) throw new Error('Google identity lookup failed');
      const identity = await result.json() as { sub?: string; name?: string; email?: string; email_verified?: boolean };
      if (!identity.sub) throw new Error('Google subject unavailable');
      return { subject: identity.sub, label: identity.name || (identity.email_verified ? identity.email : undefined) || 'Google' };
    },
  };
}
