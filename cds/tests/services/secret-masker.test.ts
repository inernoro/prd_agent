import { describe, it, expect } from 'vitest';
import {
  isSensitiveKey,
  maskLine,
  maskSecrets,
  maskSecretsInObject,
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
