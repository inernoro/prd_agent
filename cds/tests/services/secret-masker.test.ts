import { describe, it, expect } from 'vitest';
import {
  isSensitiveKey,
  maskLine,
  maskSecrets,
  maskSecretsInObject,
  maskEnvRecord,
  maskBranchExtraProfilesEnv,
  looksLikeUrlWithCredentials,
  shouldMask,
} from '../../src/services/secret-masker.js';

/**
 * F15 secret-masker tests.
 *
 * These cases are written from the threat model perspective:
 * each test pretends to be a different leak vector that was actually
 * possible before this masker existed.
 *
 * Sensitive output flows that we cover:
 *   1. `env` / `printenv` from container-exec
 *   2. Build logs that echo env exports
 *   3. HTTP debug output containing Authorization headers
 *   4. JSON object leaves (stdout / stderr field of exec response)
 *
 * Negative cases ensure we don't mangle legitimate output:
 *   - Non-sensitive keys (`NODE_ENV=production`) pass through
 *   - Stack traces / source lines pass through
 *   - Empty / null input stays empty
 */
describe('secret-masker.isSensitiveKey', () => {
  it.each([
    'GITHUB_PAT',
    'GITHUB_TOKEN',
    'R2_ACCESS_KEY',
    'R2_ACCESS_KEY_ID',
    'MYSQL_ROOT_PASSWORD',
    'MYSQL_PASSWORD',
    'PG_DATABASE_PASSWORD',
    'SMTP_PASSWORD',
    'JWT_SECRET',
    'APP_SECRET',
    'API_KEY',
    'STRIPE_API_KEY',
    'CLIENT_SECRET',
    'PRIVATE_KEY',
    'AWS_ACCESS_KEY',
    'AWS_SECRET_ACCESS_KEY',
    'OAUTH_TOKEN',
    'SLACK_WEBHOOK_URL',
  ])('flags %s as sensitive', (k) => {
    expect(isSensitiveKey(k)).toBe(true);
  });

  it.each([
    'NODE_ENV',
    'LOG_LEVEL',
    'PATH',
    'HOME',
    'USER',
    'PORT',
    'HOST',
    'TZ',
    'LANG',
    'NPM_CONFIG_REGISTRY',
    'BUILD_DIR',
    'CACHE_TTL',
  ])('does NOT flag %s as sensitive', (k) => {
    expect(isSensitiveKey(k)).toBe(false);
  });

  // Regression: .NET / camelCase config keys (Changelog__GitHubToken, etc.) put
  // the sensitive word at a camelCase boundary the `_`-anchored patterns never
  // saw, so these secrets leaked in plaintext through the provenance endpoint.
  it.each([
    'Changelog__GitHubToken',
    'GitHubOAuth__ClientSecret',
    'ApiKeyCrypto__LegacySecrets',
    'ApiKeyCrypto__Secret',
    'ClaudeSdkExecutor__CdsDiscovery__SharedSidecarToken',
    'Jwt__Secret',
  ])('flags .NET/camelCase key %s as sensitive', (k) => {
    expect(isSensitiveKey(k)).toBe(true);
  });

  it.each([
    'MongoDB__DatabaseName',
    'MongoDB__ConnectionString',
    'AspNetCoreEnvironment',
    'PreviewDomain',
    'Changelog__RootPath',
    'GitHubOAuth__ClientId', // OAuth kept atomic → public client id stays visible
  ])('does NOT over-flag innocuous camelCase key %s', (k) => {
    expect(isSensitiveKey(k)).toBe(false);
  });
});

describe('secret-masker.maskLine', () => {
  it('masks GITHUB_PAT=...', () => {
    const result = maskLine('GITHUB_PAT=ghp_AbCdEfGh1234567890');
    expect(result).toBe('GITHUB_PAT=***[masked]***');
    expect(result).not.toContain('ghp_');
  });

  it('masks MYSQL_ROOT_PASSWORD=...', () => {
    const result = maskLine('MYSQL_ROOT_PASSWORD=p4ssw0rd!');
    expect(result).toBe('MYSQL_ROOT_PASSWORD=***[masked]***');
  });

  it('masks JWT_SECRET=... in middle of line', () => {
    const result = maskLine('export JWT_SECRET=abc123 && echo done');
    expect(result).toContain('JWT_SECRET=***[masked]***');
    expect(result).not.toContain('abc123');
  });

  it('preserves NODE_ENV=production', () => {
    const result = maskLine('NODE_ENV=production');
    expect(result).toBe('NODE_ENV=production');
  });

  it('preserves PATH=/usr/bin:/bin', () => {
    const result = maskLine('PATH=/usr/bin:/bin');
    expect(result).toBe('PATH=/usr/bin:/bin');
  });

  it('masks Authorization: Bearer header', () => {
    const result = maskLine('Authorization: Bearer eyJhbGc.token.payload');
    expect(result).toBe('Authorization: Bearer ***[masked]***');
    expect(result).not.toContain('eyJ');
  });

  it('masks Authorization: Basic header', () => {
    const result = maskLine('Authorization: Basic dXNlcjpwYXNz');
    expect(result).toBe('Authorization: Basic ***[masked]***');
    expect(result).not.toContain('dXNl');
  });

  it('masks bare Bearer <token> (no surrounding KEY=VALUE)', () => {
    // Plain Bearer token in the middle of a debug log line — no `token:`
    // prefix to confuse the order of passes.
    const result = maskLine('curl -H "Bearer eyJhbGc.token.payload"');
    expect(result).toContain('Bearer ***[masked]***');
    expect(result).not.toContain('eyJ');
  });

  it('masks bare token after `token:` label (over-masking is OK)', () => {
    // When a debug line has `token: Bearer xxx`, BOTH the `token:` envelope
    // and the inner Bearer token get masked. The test only asserts that
    // the secret value is gone — the exact placement of the marker is an
    // implementation detail of the regex pass order.
    const result = maskLine('  > sent token: Bearer eyJhbGc.token.payload');
    expect(result).not.toContain('eyJ');
    expect(result).not.toContain('eyJhbGc.token.payload');
  });

  it('does not mask the literal word "Bearer" alone', () => {
    const result = maskLine('Use scheme: Bearer');
    expect(result).toBe('Use scheme: Bearer');
  });

  it('masks both quoted and unquoted values', () => {
    const result = maskLine('SMTP_PASSWORD="my password with spaces"');
    expect(result).toContain('SMTP_PASSWORD=***[masked]***');
    expect(result).not.toContain('my password');
  });
});

describe('secret-masker.maskSecrets (multi-line)', () => {
  it('masks `env` output line by line', () => {
    const envOutput = [
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      'HOME=/root',
      'NODE_ENV=production',
      'GITHUB_PAT=ghp_DontLeakThis',
      'MYSQL_ROOT_PASSWORD=secretdbpw',
      'PORT=5000',
      'JWT_SECRET=abc123',
    ].join('\n');

    const result = maskSecrets(envOutput);

    // Sensitive lines masked
    expect(result).toContain('GITHUB_PAT=***[masked]***');
    expect(result).toContain('MYSQL_ROOT_PASSWORD=***[masked]***');
    expect(result).toContain('JWT_SECRET=***[masked]***');

    // Non-sensitive lines preserved verbatim
    expect(result).toContain('PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
    expect(result).toContain('HOME=/root');
    expect(result).toContain('NODE_ENV=production');
    expect(result).toContain('PORT=5000');

    // No raw secret values present
    expect(result).not.toContain('ghp_DontLeakThis');
    expect(result).not.toContain('secretdbpw');
    expect(result).not.toContain('abc123');
  });

  it('preserves stack traces / source lines', () => {
    const stack = [
      'TypeError: Cannot read property foo of undefined',
      '  at /app/src/index.js:42:10',
      '  at processTicksAndRejections (node:internal/process/task_queues:96:5)',
    ].join('\n');
    expect(maskSecrets(stack)).toBe(stack);
  });

  it('handles empty / null / undefined gracefully', () => {
    expect(maskSecrets('')).toBe('');
    expect(maskSecrets(null)).toBe('');
    expect(maskSecrets(undefined)).toBe('');
  });

  it('passes through unchanged when mask: false', () => {
    const sensitive = 'GITHUB_PAT=ghp_secret';
    expect(maskSecrets(sensitive, { mask: false })).toBe(sensitive);
  });
});

describe('secret-masker.maskSecretsInObject', () => {
  it('masks string leaves in nested objects', () => {
    const payload = {
      stdout: 'GITHUB_PAT=ghp_xxx',
      stderr: 'JWT_SECRET=abc',
      exitCode: 0,
      meta: {
        cwd: '/app',
        env: ['HOME=/root', 'API_KEY=k123'],
      },
    };
    const result = maskSecretsInObject(payload);
    expect(result.stdout).toContain('***[masked]***');
    expect(result.stderr).toContain('***[masked]***');
    expect(result.exitCode).toBe(0); // numbers untouched
    expect(result.meta.cwd).toBe('/app'); // safe path untouched
    expect(result.meta.env[0]).toBe('HOME=/root');
    expect(result.meta.env[1]).toContain('***[masked]***');
  });

  it('passes through unchanged when mask: false', () => {
    const payload = { stdout: 'TOKEN=secret' };
    expect(maskSecretsInObject(payload, { mask: false })).toEqual(payload);
  });
});

describe('secret-masker.maskEnvRecord', () => {
  it('masks by sensitive key name', () => {
    const out = maskEnvRecord({ JWT_SECRET: 'abc', MY_PASSWORD: 'p', LOG_LEVEL: 'info' });
    expect(out.JWT_SECRET).toBe('***');
    expect(out.MY_PASSWORD).toBe('***');
    expect(out.LOG_LEVEL).toBe('info'); // non-sensitive untouched
  });

  it('masks webhook/SMTP/auth-style secret keys via the broader isSensitiveKey coverage (Codex P1)', () => {
    const out = maskEnvRecord({
      WEBHOOK_URL: 'https://hooks.example.com/abc',
      SLACK_WEBHOOK: 'https://hooks.slack.com/services/T/B/xyz',
      SMTP_URL: 'smtps://mail.example.com',
      AUTH_URL: 'https://auth.example.com/oauth',
      PUBLIC_PAGE_URL: 'https://example.com', // not sensitive → unchanged
    });
    expect(out.WEBHOOK_URL).toBe('***');
    expect(out.SLACK_WEBHOOK).toBe('***');
    expect(out.SMTP_URL).toBe('***');
    expect(out.AUTH_URL).toBe('***');
    expect(out.PUBLIC_PAGE_URL).toBe('https://example.com');
  });

  it('masks URL-style values carrying inline credentials even when the key is not sensitive (Codex P2)', () => {
    const out = maskEnvRecord({
      DATABASE_URL: 'postgres://user:pass@host:5432/db',
      MONGODB_URI: 'mongodb://admin:s3cr3t@mongo:27017',
      REDIS_URL: 'redis://:onlypass@redis:6379',
      PUBLIC_API_URL: 'https://api.example.com/v1', // no creds → not masked
    });
    expect(out.DATABASE_URL).toBe('***');
    expect(out.MONGODB_URI).toBe('***');
    expect(out.REDIS_URL).toBe('***');
    expect(out.PUBLIC_API_URL).toBe('https://api.example.com/v1');
  });

  it('masks ADO.NET/SQL connection-string values with inline Password= (provenance leak fix)', () => {
    const out = maskEnvRecord({
      SQLSERVER_URL: 'Server=sqlserver,1433;Database=master;User Id=sa;Password=hunter2;TrustServerCertificate=True;',
      MongoDB__ConnectionString: 'mongodb://172.17.0.1:10001', // no creds → not masked
      R2_PUBLIC_BASE_URL: 'https://cfi.miduo.org', // plain public URL → not masked
    });
    expect(out.SQLSERVER_URL).toBe('***');
    expect(out['MongoDB__ConnectionString']).toBe('mongodb://172.17.0.1:10001');
    expect(out.R2_PUBLIC_BASE_URL).toBe('https://cfi.miduo.org');
  });

  it('masks .NET/camelCase secret keys (provenance leak fix)', () => {
    const out = maskEnvRecord({
      Changelog__GitHubToken: 'ghp_realtoken',
      GitHubOAuth__ClientSecret: 'oauthsecret',
      ApiKeyCrypto__LegacySecrets: 'legacy==',
      GitHubOAuth__ClientId: 'Ov23liPublicId', // public client id → stays visible
      MongoDB__DatabaseName: 'prdagent', // neutral camelCase key → not masked
    });
    expect(out['Changelog__GitHubToken']).toBe('***');
    expect(out['GitHubOAuth__ClientSecret']).toBe('***');
    expect(out['ApiKeyCrypto__LegacySecrets']).toBe('***');
    expect(out['GitHubOAuth__ClientId']).toBe('Ov23liPublicId');
    expect(out['MongoDB__DatabaseName']).toBe('prdagent');
  });

  it('masks recognizable secret VALUE shapes under neutral key names (defense in depth)', () => {
    const out = maskEnvRecord({
      NEUTRAL_A: 'ghp_' + 'a'.repeat(36), // GitHub PAT shape
      NEUTRAL_B: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', // JWT
      NEUTRAL_C: 'AKIAIOSFODNN7EXAMPLE', // AWS access key id
      // must NOT be masked: not secret shapes
      CDS_COMMIT_SHA: '6779b9f2fb4531af95e007d1446c53141fc75621', // 40-hex commit
      R2_ACCOUNT_ID: 'b821db9da72264f7e790a2b8d8cc6a58', // 32-hex public id
      APP_NAME: 'prd-agent',
    });
    expect(out.NEUTRAL_A).toBe('***');
    expect(out.NEUTRAL_B).toBe('***');
    expect(out.NEUTRAL_C).toBe('***');
    expect(out.CDS_COMMIT_SHA).toBe('6779b9f2fb4531af95e007d1446c53141fc75621');
    expect(out.R2_ACCOUNT_ID).toBe('b821db9da72264f7e790a2b8d8cc6a58');
    expect(out.APP_NAME).toBe('prd-agent');
  });
});

describe('secret-masker.looksLikeUrlWithCredentials', () => {
  it('detects connection strings with inline credentials', () => {
    expect(looksLikeUrlWithCredentials('postgres://u:p@h:5432/db')).toBe(true);
    expect(looksLikeUrlWithCredentials('mongodb://admin:s3cr3t@mongo:27017')).toBe(true);
    expect(looksLikeUrlWithCredentials('redis://:onlypass@redis:6379')).toBe(true);
  });
  it('does not flag URLs without inline credentials or plain values', () => {
    expect(looksLikeUrlWithCredentials('https://api.example.com/v1')).toBe(false);
    expect(looksLikeUrlWithCredentials('redis://redis:6379')).toBe(false);
    expect(looksLikeUrlWithCredentials('info')).toBe(false);
    expect(looksLikeUrlWithCredentials('')).toBe(false);
  });
});

describe('secret-masker.maskBranchExtraProfilesEnv', () => {
  it('masks extraProfiles[].env and leaves other fields + branches without extras untouched', () => {
    const branch = {
      id: 'b1',
      status: 'running',
      extraProfiles: [
        { id: 'svc', env: { DATABASE_URL: 'postgres://u:p@h/db', PORT: '8080' } },
        { id: 'noenv' },
      ],
    };
    const view = maskBranchExtraProfilesEnv(branch);
    expect(view.extraProfiles![0].env).toEqual({ DATABASE_URL: '***', PORT: '8080' });
    expect(view.status).toBe('running'); // non-env fields untouched
    expect(branch.extraProfiles[0].env!.DATABASE_URL).toBe('postgres://u:p@h/db'); // original not mutated

    const plain = { id: 'b2', status: 'idle' };
    expect(maskBranchExtraProfilesEnv(plain)).toBe(plain); // no extras → same ref
  });

  it('masks ALL profileOverrides env in the branch view (covers stale/cleared extra overrides) (Codex/Bugbot)', () => {
    const branch = {
      id: 'b1',
      extraProfiles: [{ id: 'svc', env: { TOKEN: 'sek' } }],
      profileOverrides: {
        svc: { env: { TOKEN: 'override-secret', PORT: '8080' } }, // current extra → masked
        api: { env: { DB_PASSWORD: 'projsecret' } },               // any override → masked in the view too
      },
    };
    const view = maskBranchExtraProfilesEnv(branch);
    expect(view.profileOverrides!.svc.env).toEqual({ TOKEN: '***', PORT: '8080' });
    expect(view.profileOverrides!.api.env).toEqual({ DB_PASSWORD: '***' });
    // original not mutated
    expect(branch.profileOverrides.svc.env.TOKEN).toBe('override-secret');
  });

  it('masks leftover override env even after the extra service was cleared (extraProfiles absent) — Bugbot "Stale extra overrides leak secrets"', () => {
    const branch = {
      id: 'b1',
      // extra services were cleared → no extraProfiles, but a stale override with a secret remains.
      profileOverrides: {
        'old-extra': { env: { API_TOKEN: 'still-secret', PORT: '9000' } },
      },
    };
    const view = maskBranchExtraProfilesEnv(branch);
    expect(view.profileOverrides!['old-extra'].env).toEqual({ API_TOKEN: '***', PORT: '9000' });
    expect(branch.profileOverrides['old-extra'].env.API_TOKEN).toBe('still-secret');
  });
});

describe('secret-masker.shouldMask', () => {
  it('defaults to true', () => {
    expect(shouldMask({})).toBe(true);
    expect(shouldMask({ query: {} })).toBe(true);
  });

  it('returns false on ?unmask=1', () => {
    expect(shouldMask({ query: { unmask: '1' } })).toBe(false);
  });

  it('returns false on ?unmask=true', () => {
    expect(shouldMask({ query: { unmask: 'true' } })).toBe(false);
  });

  it('returns true on other ?unmask values', () => {
    expect(shouldMask({ query: { unmask: '0' } })).toBe(true);
    expect(shouldMask({ query: { unmask: 'false' } })).toBe(true);
    expect(shouldMask({ query: { unmask: 'maybe' } })).toBe(true);
  });
});
