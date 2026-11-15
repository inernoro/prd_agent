import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackupRetentionService } from '../../src/services/backup-retention.js';
import { StateService } from '../../src/services/state.js';

function fixture() {
  const service = new BackupRetentionService({ shell: {} as any, state: {} as any, repoRoot: '/owned', instanceId: 'lineage-test' });
  vi.spyOn(service as any, 'directories').mockReturnValue(['/owned']);
  const run = vi.spyOn(service as any, 'run').mockResolvedValue({ registered: true });
  const capture = vi.spyOn(service, 'captureSource').mockResolvedValue('a'.repeat(64));
  return { service, run, capture };
}
describe('backup lineage cannot be inferred from a current container name', () => {
  it('captures the requested project when infrastructure IDs overlap, including legacy default ownership', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-project-source-'));
    const state = new StateService(path.join(root, 'state.json'), root);state.load();
    try {
      for (const [projectId, containerName] of [['first', 'first-mysql'], ['second', 'second-mysql']]) state.addInfraService({
        id: 'db', projectId, containerName, name: 'db', dockerImage: 'mysql:8', containerPort: 3306,
        hostPort: 0, status: 'running', volumes: [], env: {}, createdAt: new Date().toISOString(),
      });
      const service = new BackupRetentionService({ shell: {} as any, state, repoRoot: root, instanceId: 'scope-test' });
      vi.spyOn(service as any, 'directories').mockReturnValue([root]);
      const run = vi.spyOn(service as any, 'run').mockResolvedValue({ sourceFingerprint: 'b'.repeat(64) });
      expect(await service.captureSource('second', 'db')).toBe('b'.repeat(64));
      expect(run).toHaveBeenLastCalledWith(root, expect.objectContaining({ projectId: 'second', containerName: 'second-mysql' }));
      expect(await service.captureSource('missing', 'db')).toBeUndefined();expect(run).toHaveBeenCalledTimes(1);
      // Persisted legacy entries predate the projectId field; exercise the real composite lookup.
      const legacy = state.getInfraServiceForProjectAndId('first', 'db')!;legacy.projectId = undefined;
      expect(await service.captureSource('default', 'db')).toBe('b'.repeat(64));
      expect(run).toHaveBeenLastCalledWith(root, expect.objectContaining({ projectId: 'default', containerName: 'first-mysql' }));
    } finally { await state.flush();fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('registers a historical manual archive as unconfirmed without querying the current source', async () => {
    const f = fixture();await f.service.register('/owned/old.gz', 'p', 'db', 'historical', { attestedBy: 'owner' });
    expect(f.capture).not.toHaveBeenCalled();expect(f.run).toHaveBeenCalledWith('/owned', expect.objectContaining({ origin: 'historical', sourceFingerprint: undefined, requireManagedOutput: false }));
  });
  it('binds explicit historical lineage while keeping the archive ineligible as an automatic replacement', async () => {
    const f = fixture();await f.service.register('/owned/old.gz', 'p', 'db', 'manual', { attestedBy: 'owner', lineageAttestation: 'Original export records match this physical source' });
    expect(f.capture).toHaveBeenCalledWith('p', 'db');expect(f.run).toHaveBeenCalledWith('/owned', expect.objectContaining({ origin: 'manual', sourceFingerprint: 'a'.repeat(64), requireManagedOutput: false }));
    expect(f.run.mock.calls[0][1]).not.toHaveProperty('sourceComplete', true);
  });
  it('keeps the archive unregistered when an explicitly requested physical-source query fails', async () => {
    const f = fixture();f.capture.mockResolvedValue(undefined);
    await expect(f.service.register('/owned/old.gz', 'p', 'db', 'historical', { attestedBy: 'owner', lineageAttestation: 'Original export evidence' })).rejects.toThrow('物理来源尚未确认');expect(f.run).not.toHaveBeenCalled();
  });
  it('requires the managed-output promotion proof for current CDS automatic exports', async () => {
    const f = fixture();await f.service.register('/owned/new.gz', 'p', 'db', 'automatic', { sourceFingerprint: 'b'.repeat(64), sourceComplete: true });
    expect(f.capture).not.toHaveBeenCalled();expect(f.run).toHaveBeenCalledWith('/owned', expect.objectContaining({ requireManagedOutput: true, sourceComplete: true }));
  });
});
