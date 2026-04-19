/**
 * Unit tests for GitHubAppClient + verifyWebhookSignature.
 *
 * We stub `fetchImpl` instead of the global fetch so tests never talk to
 * github.com. JWT signing is validated with a known RSA key pair — we
 * re-verify the signature with Node's crypto to prove the client produced
 * a valid RS256 token.
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createVerify, createHmac } from 'node:crypto';
import {
  GitHubAppClient,
  verifyWebhookSignature,
  buildInstallUrl,
  type FetchLike,
} from '../../src/services/github-app-client.js';

function freshKeyPair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function scripted(scripts: Array<{ match: RegExp | string; response: any; status?: number }>): FetchLike {
  return async (url) => {
    for (const s of scripts) {
      const matched = typeof s.match === 'string' ? String(url).includes(s.match) : s.match.test(String(url));
      if (matched) {
        const status = s.status ?? 200;
        return {
          ok: status < 400,
          status,
          statusText: 'OK',
          json: async () => s.response,
          text: async () => (typeof s.response === 'string' ? s.response : JSON.stringify(s.response)),
        };
      }
    }
    throw new Error(`unmatched fetch ${url}`);
  };
}

describe('GitHubAppClient', () => {
  describe('generateAppJwt', () => {
    it('produces a valid RS256 JWT that the public key verifies', () => {
      const { publicKey, privateKey } = freshKeyPair();
      const client = new GitHubAppClient({ appId: '12345', privateKey });
      const jwt = client.generateAppJwt(1_700_000_000);

      const parts = jwt.split('.');
      expect(parts).toHaveLength(3);
      const [headerB64, payloadB64, signatureB64] = parts;

      const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf-8'));
      expect(header.alg).toBe('RS256');
      expect(header.typ).toBe('JWT');

      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));
      expect(payload.iss).toBe('12345');
      expect(payload.iat).toBe(1_700_000_000 - 30);
      expect(payload.exp).toBe(1_700_000_000 + 540);

      const verifier = createVerify('RSA-SHA256');
      verifier.update(`${headerB64}.${payloadB64}`);
      verifier.end();
      const sig = Buffer.from(signatureB64, 'base64url');
      expect(verifier.verify(publicKey, sig)).toBe(true);
    });
  });

  describe('getInstallationToken', () => {
    it('caches the token until it approaches expiry', async () => {
      const { privateKey } = freshKeyPair();
      let calls = 0;
      const fetchImpl = scripted([
        {
          match: /\/app\/installations\/42\/access_tokens$/,
          response: { token: 'ghs_tokenA', expires_at: new Date(Date.now() + 3_600_000).toISOString() },
        },
      ]);
      const wrapped: FetchLike = async (url, init) => {
        calls++;
        return fetchImpl(url, init);
      };
      const client = new GitHubAppClient({ appId: '1', privateKey, fetchImpl: wrapped });

      const t1 = await client.getInstallationToken(42);
      const t2 = await client.getInstallationToken(42);
      expect(t1).toBe('ghs_tokenA');
      expect(t2).toBe('ghs_tokenA');
      expect(calls).toBe(1);
    });

    it('throws GitHubAppError with status on HTTP failure', async () => {
      const { privateKey } = freshKeyPair();
      const fetchImpl = scripted([
        {
          match: /access_tokens$/,
          response: { message: 'Bad credentials' },
          status: 401,
        },
      ]);
      const client = new GitHubAppClient({ appId: '1', privateKey, fetchImpl });
      await expect(client.getInstallationToken(42)).rejects.toMatchObject({
        code: 'installation_token_failed',
        status: 401,
      });
    });
  });

  describe('createCheckRun', () => {
    it('POSTs to /repos/:owner/:repo/check-runs with expected body', async () => {
      const { privateKey } = freshKeyPair();
      let receivedBody: any = null;
      const fetchImpl: FetchLike = async (url, init) => {
        if (String(url).includes('access_tokens')) {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ token: 'tkn', expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
            text: async () => '',
          };
        }
        if (String(url).includes('/check-runs')) {
          receivedBody = JSON.parse(init?.body as string);
          return {
            ok: true,
            status: 201,
            statusText: 'Created',
            json: async () => ({ id: 9999, html_url: 'https://github.com/x/y/runs/9999' }),
            text: async () => '',
          };
        }
        throw new Error(`unmatched ${url}`);
      };
      const client = new GitHubAppClient({ appId: '1', privateKey, fetchImpl });
      const result = await client.createCheckRun(1, 'octo', 'repo', {
        name: 'CDS Deploy',
        headSha: 'abc1234',
        status: 'in_progress',
        detailsUrl: 'https://cds.example/x',
        externalId: 'feature-main',
        output: { title: 'Deploying…', summary: 'Starting' },
      });
      expect(result.id).toBe(9999);
      expect(receivedBody.name).toBe('CDS Deploy');
      expect(receivedBody.head_sha).toBe('abc1234');
      expect(receivedBody.status).toBe('in_progress');
      expect(receivedBody.details_url).toBe('https://cds.example/x');
      expect(receivedBody.external_id).toBe('feature-main');
      expect(receivedBody.output.title).toBe('Deploying…');
    });
  });

  describe('updateCheckRun', () => {
    it('PATCHes to the correct URL', async () => {
      const { privateKey } = freshKeyPair();
      let patchedUrl: string | null = null;
      const fetchImpl: FetchLike = async (url, init) => {
        if (String(url).includes('access_tokens')) {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ token: 't', expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
            text: async () => '',
          };
        }
        patchedUrl = String(url);
        expect(init?.method).toBe('PATCH');
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({}), text: async () => '' };
      };
      const client = new GitHubAppClient({ appId: '1', privateKey, fetchImpl });
      await client.updateCheckRun(1, 'octo', 'repo', 42, {
        status: 'completed',
        conclusion: 'success',
        output: { title: 'Done', summary: 'all good' },
      });
      expect(patchedUrl).toBe('https://api.github.com/repos/octo/repo/check-runs/42');
    });
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 'It\'s a Secret to Everybody';
  const body = Buffer.from('Hello, World!');

  function hmacHex(b: Buffer, s: string): string {
    return createHmac('sha256', s).update(b).digest('hex');
  }

  it('accepts a correct signature', () => {
    const header = `sha256=${hmacHex(body, secret)}`;
    expect(verifyWebhookSignature(body, header, secret)).toBe(true);
  });

  it('rejects a wrong signature', () => {
    const wrong = hmacHex(body, 'different-secret');
    expect(verifyWebhookSignature(body, `sha256=${wrong}`, secret)).toBe(false);
  });

  it('rejects a missing prefix', () => {
    const header = hmacHex(body, secret);
    expect(verifyWebhookSignature(body, header, secret)).toBe(false);
  });

  it('rejects a signature of wrong length', () => {
    expect(verifyWebhookSignature(body, 'sha256=abc', secret)).toBe(false);
  });

  it('rejects undefined signature', () => {
    expect(verifyWebhookSignature(body, undefined, secret)).toBe(false);
  });

  it('rejects non-hex characters', () => {
    // 64 chars but contains a `z`
    const badHex = 'z' + hmacHex(body, secret).slice(1);
    expect(verifyWebhookSignature(body, `sha256=${badHex}`, secret)).toBe(false);
  });
});

describe('buildInstallUrl', () => {
  it('returns null when app slug is missing', () => {
    expect(buildInstallUrl(undefined)).toBeNull();
  });
  it('produces a standard install URL', () => {
    expect(buildInstallUrl('cds-deploy')).toBe('https://github.com/apps/cds-deploy/installations/new');
  });
  it('appends state param when provided', () => {
    expect(buildInstallUrl('cds-deploy', 'proj:abc')).toBe(
      'https://github.com/apps/cds-deploy/installations/new?state=proj%3Aabc',
    );
  });
});
