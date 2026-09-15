import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InfraService } from '../../src/types.js';
import { StateService } from '../../src/services/state.js';

const roots: string[] = [];

function mongoService(): InfraService {
  return {
    id: 'mongodb', projectId: 'project-a', scope: 'project', name: 'MongoDB', dockerImage: 'mongo:7',
    containerPort: 27017, hostPort: 17017, containerName: 'cds-infra-mongodb', status: 'running',
    volumes: [], env: {}, createdAt: '2026-09-06T00:00:00.000Z',
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.promises.rm(root, { recursive: true, force: true });
});

describe('基础设施短作业持久门禁', () => {
  it('active 在 flush 后可跨进程读取，结束后不再阻断', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cds-maintenance-job-'));
    roots.push(root);
    const stateFile = path.join(root, 'state.json');
    const state = new StateService(stateFile, root);
    state.load();
    state.addInfraService(mongoService());
    state.save();
    await state.flush();

    const job = await state.beginInfraMaintenanceJob({
      projectId: 'project-a', serviceId: 'mongodb', runtime: 'mongodb', kind: 'automatic-backup',
    });
    const restarted = new StateService(stateFile, root);
    restarted.load();
    expect(restarted.listActiveInfraMaintenanceJobs({ projectId: 'project-a', serviceId: 'mongodb' }))
      .toEqual([expect.objectContaining({ id: job.id, status: 'active', kind: 'automatic-backup' })]);

    await restarted.finishInfraMaintenanceJob(job.id, 'completed');
    const afterFinish = new StateService(stateFile, root);
    afterFinish.load();
    expect(afterFinish.listActiveInfraMaintenanceJobs({ projectId: 'project-a', serviceId: 'mongodb' })).toEqual([]);
  });

  it('轮换非终态时拒绝启动新作业，终态后重新放行', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cds-maintenance-job-'));
    roots.push(root);
    const state = new StateService(path.join(root, 'state.json'), root);
    state.load();
    const service = mongoService();
    service.credentialRotation = {
      id: 'icr-active', idempotencyKey: 'request-active', projectId: 'project-a', serviceId: 'mongodb',
      runtime: 'mongodb', stage: 'verified', previousFingerprint: '1'.repeat(16), nextFingerprint: '2'.repeat(16),
      consumerIds: ['branch/api'], startedAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:01:00.000Z',
      events: [{ stage: 'verified', at: '2026-09-06T00:01:00.000Z' }],
    };
    state.addInfraService(service);

    await expect(state.beginInfraMaintenanceJob({
      projectId: 'project-a', serviceId: 'mongodb', runtime: 'mongodb', kind: 'automatic-backup',
    })).rejects.toThrow('infra_maintenance.credential_rotation_in_progress');

    state.updateInfraService('mongodb', {
      credentialRotation: { ...service.credentialRotation, stage: 'verified_after_revoke', rollback: 'not-required' },
    }, 'project-a');
    await expect(state.beginInfraMaintenanceJob({
      projectId: 'project-a', serviceId: 'mongodb', runtime: 'mongodb', kind: 'manual-restore',
    })).resolves.toMatchObject({ status: 'active', kind: 'manual-restore' });
  });
});
