/**
 * 复制隔离克隆阶段失败的还原契约（Codex 第十五轮 P2）：第 1 步 dump/restore
 * 失败时成员容器一个都没动过——必须把摘流的健康成员恢复到隔离前状态（回到
 * 分流），只留失败说明；不许全员标 error 把健康副本永久踢出路由（rs.isolated
 * 未落地，计划回滚也救不了它们）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../src/services/replica-db-clone.js', () => ({
  cloneReplicaDb: async (): Promise<never> => { throw new Error('mongodump 认证失败'); },
  dropReplicaDb: async (): Promise<void> => undefined,
  resolveReplicaDbTarget: () => ({
    target: {
      engine: 'mongo', sourceDb: 'appdb', envKeys: ['MongoDB__DatabaseName'],
      infra: { id: 'mongodb', containerName: 'cds-infra-mongo', env: {}, containerPort: 27017 },
    },
  }),
  envOverrideFromSnapshot: () => ({}),
  dedicatedAuthFromContainer: async () => null,
}));

import { StateService } from '../../src/services/state.js';
import { ReplicaSetService } from '../../src/services/replica-set.js';
import type { BranchEntry, BuildProfile } from '../../src/types.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

let tmpDir: string;
let state: StateService;
let svc: ReplicaSetService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-rsisofail-'));
  state = new StateService(path.join(tmpDir, 'state.json'));
  state.addProject({ id: 'proj', slug: 'demo', name: 'demo', createdAt: new Date().toISOString() } as Parameters<typeof state.addProject>[0]);
  state.addInfraService({
    id: 'mongodb', projectId: 'proj', name: 'MongoDB', dockerImage: 'mongo:8',
    containerPort: 27017, hostPort: 27017, containerName: 'cds-infra-mongo',
    status: 'running', volumes: [], env: {}, createdAt: new Date().toISOString(),
  });
  state.getState().buildProfiles.push({
    id: 'api', projectId: 'proj', name: 'api', dockerImage: 'app:1', containerPort: 8080, dbScope: 'shared',
    env: { MongoDB__DatabaseName: 'appdb' },
  } as unknown as BuildProfile);
  const branch: BranchEntry = {
    id: 'proj-main', projectId: 'proj', branch: 'main', worktreePath: '/tmp/x',
    services: { api: { profileId: 'api', containerName: 'c-api', hostPort: 9100, status: 'running' } },
    status: 'running', createdAt: new Date().toISOString(),
    replicaSets: {
      api: {
        profileId: 'api', enabled: true, primaryWeight: 50,
        members: [{
          id: 'res-1', versionId: 'dv1', weight: 50, image: 'img', status: 'running',
          dbMode: 'shared', containerName: 'cds-proj-main-api-res-1', hostPort: 9300,
          createdAt: new Date().toISOString(),
        }],
        updatedAt: new Date().toISOString(),
      },
    },
  } as unknown as BranchEntry;
  state.addBranch(branch);
  svc = new ReplicaSetService({
    state,
    container: { remove: async () => undefined } as never,
    versions: { get: () => undefined, assertReusable: () => undefined } as never,
    shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) } as never,
    portStart: 10000,
  });
});

afterEach(async () => {
  await flushAllJsonStateStores();
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('isolateProfile 克隆阶段失败', () => {
  it('MongoDB 凭据轮换未结束时拒绝在首个克隆 I/O 前启动', () => {
    state.updateInfraService('mongodb', {
      credentialRotation: {
        id: 'rotation-active', idempotencyKey: 'rotation-request', projectId: 'proj', serviceId: 'mongodb',
        runtime: 'mongodb', stage: 'deployed', previousFingerprint: '1'.repeat(16), nextFingerprint: '2'.repeat(16),
        consumerIds: ['proj-main/api'], startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        events: [{ stage: 'deployed', at: new Date().toISOString() }],
      },
    }, 'proj');

    const r = svc.isolateProfile('proj-main', 'api');
    expect(r).toMatchObject({ accepted: false });
    expect(r.reason).toContain('轮换凭据');
    expect(() => svc.addMember('proj-main', 'api', { dbMode: 'isolated' })).toThrow('轮换凭据');
    expect(state.listActiveInfraMaintenanceJobs({ projectId: 'proj', serviceId: 'mongodb' })).toEqual([]);
    expect(state.getBranch('proj-main')!.replicaSets!.api.members[0].status).toBe('running');
  });

  it('健康成员恢复 running 回到分流（不毒化），隔离标记不落地', async () => {
    const r = svc.isolateProfile('proj-main', 'api');
    expect(r.accepted).toBe(true);
    // 同步阶段先摘流：成员应立即进 provisioning
    const memberNow = state.getBranch('proj-main')!.replicaSets!.api.members[0];
    expect(memberNow.status).toBe('provisioning');
    // 等异步克隆失败并走还原分支
    for (let i = 0; i < 200; i += 1) {
      const m = state.getBranch('proj-main')!.replicaSets!.api.members[0];
      if (m.status !== 'provisioning') break;
      await new Promise((res) => setTimeout(res, 10));
    }
    const rs = state.getBranch('proj-main')!.replicaSets!.api;
    expect(rs.members[0].status).toBe('running');
    expect(rs.members[0].statusMessage).toContain('克隆阶段');
    expect(rs.members[0].statusMessage).toContain('mongodump 认证失败');
    expect(rs.isolated).toBeUndefined();
  });
});
