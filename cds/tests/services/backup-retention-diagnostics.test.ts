import { describe, expect, it, vi } from 'vitest';
import { BackupRetentionOperationError, BackupRetentionService } from '../../src/services/backup-retention.js';
import { ShellExecutor } from '../../src/services/shell-executor.js';
import type { IShellExecutor } from '../../src/types.js';
import type { StateService } from '../../src/services/state.js';

vi.mock('../../src/services/backup-retention-program.js', () => ({
  BACKUP_RETENTION_PROGRAM: "raise PermissionError(13, 'NEVER_EMIT_NATIVE_SECRET')",
}));

function service(shell: IShellExecutor) {
  const state = { resourceRetirementJournal: () => undefined } as unknown as StateService;
  return new BackupRetentionService({ shell, state, repoRoot: '/owned', instanceId: 'fixture' });
}

describe('backup native failure evidence', () => {
  it('records the real exception type, errno and native line without its message', async () => {
    const work = vi.fn();
    const error = await service(new ShellExecutor()).withLease('/owned', 'p', 'db', 'backup', work).catch(e => e);
    expect(error).toBeInstanceOf(BackupRetentionOperationError);
    expect(error.diagnostic).toEqual({ action: 'lease', failureKind: 'native-exit', exitCode: 70,
      nativeException: 'PermissionError', errno: 13, nativeLines: [1] });
    expect(JSON.stringify(error)).not.toContain('NEVER_EMIT_NATIVE_SECRET');
    expect(error.message).not.toContain('NEVER_EMIT_NATIVE_SECRET');
    expect(work).not.toHaveBeenCalled();
  });

  it.each([
    ['nonzero exit', { exitCode: 1, stdout: '', stderr: 'NEVER_EMIT_NATIVE_SECRET' }, 'native-exit'],
    ['invalid JSON', { exitCode: 0, stdout: 'NEVER_EMIT_NATIVE_SECRET', stderr: '' }, 'invalid-result'],
    ['null result', { exitCode: 0, stdout: 'null', stderr: '' }, 'invalid-result'],
    ['over budget', { exitCode: 0, stdout: 'x'.repeat(4 * 1024 * 1024 + 1), stderr: '' }, 'output-budget'],
  ])('fails closed without copying native output (%s)', async (_name, result, kind) => {
    const shell = { exec: vi.fn(async () => result) } as unknown as IShellExecutor;
    const work = vi.fn();
    const error = await service(shell).withLease('/owned', 'p', 'db', 'backup', work).catch(e => e);
    expect(error.diagnostic.failureKind).toBe(kind);
    expect(error.message).not.toContain('NEVER_EMIT_NATIVE_SECRET');
    expect(work).not.toHaveBeenCalled();
  });

  it('reports an executor failure as unknown transport rather than a successful empty scan', async () => {
    const shell = { exec: vi.fn(async () => { throw new Error('NEVER_EMIT_NATIVE_SECRET'); }) } as unknown as IShellExecutor;
    const error = await service(shell).withLease('/owned', 'p', 'db', 'backup', vi.fn()).catch(e => e);
    expect(error.diagnostic).toEqual({ action: 'lease', failureKind: 'transport', exitCode: null });
    expect(error.message).not.toContain('NEVER_EMIT_NATIVE_SECRET');
  });
});
