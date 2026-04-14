/**
 * Tests for the P4 Part 18 hardening path:
 *   validateBuildReadiness() — the pnpm install + tsc pre-check
 *
 * These are unit tests against the helper with a MockShellExecutor
 * so we can script install/tsc success + failure cases without
 * actually running pnpm. The integration with /api/self-update and
 * /api/self-update-dry-run routes is covered by manual smoke tests
 * (the route just calls into this helper).
 */

import { describe, it, expect } from 'vitest';
import { validateBuildReadiness } from '../../src/routes/branches.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';

describe('validateBuildReadiness (P4 Part 18 hardening)', () => {
  it('returns ok when both install and tsc succeed', async () => {
    const shell = new MockShellExecutor();
    shell.addResponsePattern(/pnpm install --frozen-lockfile/, () => ({
      stdout: 'Lockfile is up to date',
      stderr: '',
      exitCode: 0,
    }));
    shell.addResponsePattern(/tsc --noEmit/, () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }));

    const result = await validateBuildReadiness(shell, '/fake/cds');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toContain('pnpm install');
      expect(result.summary).toContain('tsc');
    }
  });

  it('returns install failure with stderr when pnpm install fails', async () => {
    const shell = new MockShellExecutor();
    shell.addResponsePattern(/pnpm install --frozen-lockfile/, () => ({
      stdout: '',
      stderr: 'ERR_PNPM_LOCKFILE_MISSING_DEPS: mongodb not in lockfile',
      exitCode: 1,
    }));

    const result = await validateBuildReadiness(shell, '/fake/cds');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe('install');
      expect(result.error).toContain('mongodb not in lockfile');
    }
  });

  it('returns tsc failure with stderr when tsc exits non-zero', async () => {
    const shell = new MockShellExecutor();
    shell.addResponsePattern(/pnpm install --frozen-lockfile/, () => ({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
    }));
    shell.addResponsePattern(/tsc --noEmit/, () => ({
      stdout: 'src/server.ts(857,41): error TS2304: Cannot find name \'require\'.\n',
      stderr: '',
      exitCode: 2,
    }));

    const result = await validateBuildReadiness(shell, '/fake/cds');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe('tsc');
      // The critical bug this hardening was built to catch
      expect(result.error).toContain('Cannot find name \'require\'');
    }
  });

  it('caps error messages at 500-800 chars to avoid flooding the SSE stream', async () => {
    const shell = new MockShellExecutor();
    const hugeError = 'x'.repeat(5000);
    shell.addResponsePattern(/pnpm install --frozen-lockfile/, () => ({
      stdout: '',
      stderr: hugeError,
      exitCode: 1,
    }));

    const result = await validateBuildReadiness(shell, '/fake/cds');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Install errors cap at 500 chars
      expect(result.error.length).toBeLessThanOrEqual(500);
    }
  });

  it('runs install BEFORE tsc (order matters — if install fails, tsc would not find modules)', async () => {
    const shell = new MockShellExecutor();
    shell.addResponsePattern(/pnpm install --frozen-lockfile/, () => ({
      stdout: 'install ok',
      stderr: '',
      exitCode: 0,
    }));
    shell.addResponsePattern(/tsc --noEmit/, () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }));

    await validateBuildReadiness(shell, '/fake/cds');
    const installIdx = shell.commands.findIndex((c) => c.includes('pnpm install'));
    const tscIdx = shell.commands.findIndex((c) => c.includes('tsc --noEmit'));
    expect(installIdx).toBeGreaterThanOrEqual(0);
    expect(tscIdx).toBeGreaterThanOrEqual(0);
    expect(installIdx).toBeLessThan(tscIdx);
  });

  it('passes cdsDir as cwd to both commands', async () => {
    const shell = new MockShellExecutor();
    shell.addResponsePattern(/pnpm install/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    shell.addResponsePattern(/tsc/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

    await validateBuildReadiness(shell, '/opt/prd_agent/cds');

    const cwds = shell.cwds;
    expect(cwds).toContain('/opt/prd_agent/cds');
    // Both commands should run in that cwd
    expect(cwds.filter((c) => c === '/opt/prd_agent/cds').length).toBe(2);
  });
});
