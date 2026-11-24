import { describe, expect, it, vi } from 'vitest';
import { runBackupTargetWithLease } from '../../src/services/infra-backup-target.js';
import type { BackupOutcome } from '../../src/services/infra-backup-schedule.js';
import type { BackupRetentionService } from '../../src/services/backup-retention.js';

describe('automatic backup target lease failures', () => {
  it('does not export past an unconfirmed lease and still records the next project target', async () => {
    const outcomes: BackupOutcome[] = [], firstExport = vi.fn();
    const retention = { withLease: vi.fn(async (_dir, project, _id, _kind, work) => {
      if (project === 'first') throw new Error('native lease unavailable');
      return work();
    }) } as unknown as Pick<BackupRetentionService, 'withLease'>;
    await runBackupTargetWithLease({ retention, directory: '/owned', projectId: 'first', serviceId: 'db', outcomes, operation: firstExport });
    await runBackupTargetWithLease({ retention, directory: '/owned', projectId: 'second', serviceId: 'db', outcomes,
      operation: async () => { outcomes.push({ id: 'db', projectId: 'second', ok: true, fileName: 'verified.gz' }); } });
    expect(firstExport).not.toHaveBeenCalled();
    expect(outcomes).toEqual([expect.objectContaining({ projectId: 'first', id: 'db', ok: false }),
      expect.objectContaining({ projectId: 'second', id: 'db', ok: true })]);
  });

  it('retains verified output metadata but cannot report success if lease finalization fails', async () => {
    const outcomes: BackupOutcome[] = [], audit = vi.fn();
    const retention = { withLease: async (_dir, _project, _id, _kind, work) => { await work(); throw new Error('release unconfirmed'); } } as Pick<BackupRetentionService, 'withLease'>;
    await runBackupTargetWithLease({ retention, directory: '/owned', projectId: 'p', serviceId: 'db', outcomes, onUnconfirmed: audit,
      operation: async () => { outcomes.push({ id: 'db', projectId: 'p', ok: true, fileName: 'verified.gz', bytes: 32, sha256: 'a'.repeat(64) }); } });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toEqual(expect.objectContaining({ ok: false, fileName: 'verified.gz', bytes: 32, sha256: 'a'.repeat(64) }));
    expect(outcomes[0].error).toContain('release unconfirmed');
    expect(audit).toHaveBeenCalledOnce();
  });

  it('preserves an earlier export failure instead of adding a duplicate target on cleanup failure', async () => {
    const outcomes: BackupOutcome[] = [];
    const retention = { withLease: async (_dir, _project, _id, _kind, work) => { await work(); throw new Error('release unconfirmed'); } } as Pick<BackupRetentionService, 'withLease'>;
    await runBackupTargetWithLease({ retention, directory: '/owned', projectId: 'p', serviceId: 'db', outcomes,
      operation: async () => { outcomes.push({ id: 'db', projectId: 'p', ok: false, error: 'dump failed' }); } });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].error).toContain('dump failed');
    expect(outcomes[0].error).toContain('release unconfirmed');
  });
});
