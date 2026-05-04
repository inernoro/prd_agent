/**
 * Phase B (2026-05-04) — pin parsing of `docker stats --format` output.
 *
 * `parseDockerSize` is non-exported in container.ts (kept private to discourage
 * misuse outside getServiceStats). We exercise it indirectly through
 * getServiceStats with a MockShellExecutor that returns synthetic docker
 * output. This way the test pins the *behavior* rather than the helper's
 * exact symbol — refactor-safe.
 */

import { describe, it, expect } from 'vitest';
import { ContainerService } from '../../src/services/container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { CdsConfig } from '../../src/types.js';

function makeConfig(): CdsConfig {
  return {
    repoRoot: '/tmp/cds-stats-test',
    worktreeBase: '/tmp/cds-stats-test/worktrees',
    masterPort: 9900,
    workerPort: 5500,
    dockerNetwork: 'cds-network',
    portStart: 10001,
    sharedEnv: {},
    jwt: { secret: 'test-secret', issuer: 'cds' },
  };
}

describe('ContainerService.getServiceStats — docker stats parsing', () => {
  it('returns empty map when called with no container names (short-circuit)', async () => {
    const shell = new MockShellExecutor();
    const svc = new ContainerService(shell, makeConfig());
    const result = await svc.getServiceStats([]);
    expect(result.size).toBe(0);
  });

  it('parses a single-container stats line correctly', async () => {
    const shell = new MockShellExecutor();
    // docker stats output: name\tcpu%\tmem-used / mem-limit\tmem%\tnet-rx / net-tx\tblock-r / block-w\tpids
    shell.addResponsePattern(/docker stats/, () => ({
      stdout: 'cds-foo-main-api\t12.34%\t128MiB / 512MiB\t25.00%\t1.5kB / 800B\t0B / 0B\t8',
      stderr: '',
      exitCode: 0,
    }));
    const svc = new ContainerService(shell, makeConfig());
    const result = await svc.getServiceStats(['cds-foo-main-api']);
    const stats = result.get('cds-foo-main-api');
    expect(stats).toBeDefined();
    expect(stats!.cpuPercent).toBeCloseTo(12.34);
    expect(stats!.memUsedBytes).toBe(128 * 1024 * 1024);
    expect(stats!.memLimitBytes).toBe(512 * 1024 * 1024);
    expect(stats!.memPercent).toBeCloseTo(25.0);
    expect(stats!.netRxBytes).toBe(1.5 * 1024);
    expect(stats!.netTxBytes).toBe(800);
    expect(stats!.pids).toBe(8);
  });

  it('parses multiple containers in one batch', async () => {
    const shell = new MockShellExecutor();
    shell.addResponsePattern(/docker stats/, () => ({
      stdout: [
        'cds-foo-main-api\t5.0%\t100MiB / 1GiB\t9.77%\t0B / 0B\t0B / 0B\t3',
        'cds-foo-main-db\t1.2%\t50MiB / 512MiB\t9.77%\t0B / 0B\t0B / 0B\t1',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    }));
    const svc = new ContainerService(shell, makeConfig());
    const result = await svc.getServiceStats(['cds-foo-main-api', 'cds-foo-main-db']);
    expect(result.size).toBe(2);
    expect(result.get('cds-foo-main-api')!.cpuPercent).toBeCloseTo(5.0);
    expect(result.get('cds-foo-main-db')!.memUsedBytes).toBe(50 * 1024 * 1024);
  });

  it('returns empty map (no throw) when docker fails (e.g. no such container)', async () => {
    const shell = new MockShellExecutor();
    shell.addResponsePattern(/docker stats/, () => ({
      stdout: '',
      stderr: 'Error response from daemon: No such container',
      exitCode: 1,
    }));
    const svc = new ContainerService(shell, makeConfig());
    const result = await svc.getServiceStats(['cds-ghost-main-api']);
    expect(result.size).toBe(0);
  });

  it('handles GiB / kB / B units', async () => {
    const shell = new MockShellExecutor();
    shell.addResponsePattern(/docker stats/, () => ({
      stdout: 'cds-x\t0%\t1GiB / 2GiB\t50%\t2kB / 0B\t512B / 256B\t10',
      stderr: '',
      exitCode: 0,
    }));
    const svc = new ContainerService(shell, makeConfig());
    const result = await svc.getServiceStats(['cds-x']);
    const stats = result.get('cds-x')!;
    expect(stats.memUsedBytes).toBe(1 * 1024 * 1024 * 1024);
    expect(stats.memLimitBytes).toBe(2 * 1024 * 1024 * 1024);
    expect(stats.netRxBytes).toBe(2 * 1024);
    expect(stats.blockReadBytes).toBe(512);
    expect(stats.blockWriteBytes).toBe(256);
  });
});
