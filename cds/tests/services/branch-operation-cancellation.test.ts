import { describe, expect, it } from 'vitest';
import { BranchOperationCoordinator } from '../../src/services/branch-operation-coordinator.js';
import { ShellExecutor, withShellExecutionContext } from '../../src/services/shell-executor.js';

const request = { branchId: 'isolated-test', kind: 'deploy' as const, trigger: 'webhook' as const,
  commitPinned: true, commitSha: 'a'.repeat(40), configHash: 'unchanged' };

describe('P3-02: operation cancellation reaches real commands', () => {
  it('aborts superseded execution and releases queued commands, without touching a different branch', async () => {
    const coordinator = new BranchOperationCoordinator();
    const lease = coordinator.begin(request).lease!;
    const other = coordinator.begin({ ...request, branchId: 'other-test' }).lease!;
    const shell = new ShellExecutor({ maxConcurrent: 1 });
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    try {
      const running = withShellExecutionContext({ signal: lease.signal }, () => shell.exec('printf ready; exec sleep 10',
        { timeout: 2000, onData: chunk => { if (chunk.includes('ready')) ready(); } }));
      const queued = withShellExecutionContext({ signal: lease.signal }, () => shell.exec('printf should-not-start', { timeout: 2000 }));
      await started;
      coordinator.begin({ branchId: request.branchId, kind: 'stop', trigger: 'manual' });
      expect(lease.signal?.aborted).toBe(true);
      expect(other.signal?.aborted).toBe(false);
      expect((await running).exitCode).toBe(130);
      const result = await queued;
      expect(result.exitCode).toBe(130);
      expect(result.stdout).toBe('');
      expect((await shell.exec('printf released')).stdout).toBe('released');
    } finally { await shell.close(); }
  });

  it('joins an identical target without aborting its lease', () => {
    const coordinator = new BranchOperationCoordinator();
    const lease = coordinator.begin(request).lease!;
    expect(coordinator.begin(request).status).toBe('joined');
    expect(lease.signal).toBeDefined();
    expect(lease.signal?.aborted).toBe(false);
    coordinator.cancelBranch(request.branchId, 'test cleanup');
    expect(lease.signal?.aborted).toBe(true);
  });

  it('preserves operation cancellation across nested context and a separate command signal', async () => {
    const shell = new ShellExecutor();
    const operation = new AbortController();
    const command = new AbortController();
    operation.abort();
    try {
      const result = await withShellExecutionContext({ signal: operation.signal }, () =>
        withShellExecutionContext({ priority: 'delivery' }, () => shell.exec('printf should-not-start',
          { signal: command.signal, timeout: 2000 })));
      expect(result.exitCode).toBe(130);
      expect(result.stdout).toBe('');
      expect(command.signal.aborted).toBe(false);
    } finally { await shell.close(); }
  });
});
