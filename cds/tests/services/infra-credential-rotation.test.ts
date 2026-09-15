import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InfraCredentialRotationRecord, InfraService } from '../../src/types.js';
import {
  InfraCredentialRotationService,
  RotationStepError,
  type InfraCredentialRotationBackend,
  type InfraCredentialRotationStore,
  type RotationPreparedCredential,
} from '../../src/services/infra-credential-rotation.js';
import {
  markRotationRecoveryArtifactsForCleanup,
  markRotationRecoveryArtifactsForManualReview,
  pruneExpiredRotationRecoveryArtifacts,
} from '../../src/services/infra-local-recovery-drill.js';

function infra(id = 'mongodb'): InfraService {
  return {
    id,
    projectId: 'project-a',
    name: id,
    dockerImage: id === 'redis' ? 'redis:7' : 'mongo:7',
    containerPort: id === 'redis' ? 6379 : 27017,
    hostPort: id === 'redis' ? 16379 : 17017,
    containerName: `cds-infra-${id}`,
    status: 'running',
    volumes: [],
    env: {},
    createdAt: '2026-09-06T00:00:00.000Z',
  };
}

class MemoryStore implements InfraCredentialRotationStore {
  constructor(readonly service: InfraService) {}
  getService(projectId: string, serviceId: string): InfraService | undefined {
    return projectId === this.service.projectId && serviceId === this.service.id ? this.service : undefined;
  }
  saveRecord(_projectId: string, _serviceId: string, record: InfraCredentialRotationRecord): void {
    this.service.credentialRotation = structuredClone(record);
  }
}

function backend(overrides: Partial<InfraCredentialRotationBackend> = {}): InfraCredentialRotationBackend {
  const prepared: RotationPreparedCredential = {
    previousFingerprint: '1111111111111111',
    nextFingerprint: '2222222222222222',
    opaque: { previousSecret: 'old-secret', nextSecret: 'new-secret' },
  };
  return {
    enumerateConsumers: vi.fn(async () => ['branch-b', 'branch-a', 'branch-a']),
    verifyRecovery: vi.fn(async () => ({
      backupId: 'backup-1',
      backupSha256: 'a'.repeat(64),
      drillId: 'drill-1',
      restoredItemCount: 9,
      verifiedAt: '2026-09-06T00:00:00.000Z',
    })),
    prepare: vi.fn(async () => prepared),
    issue: vi.fn(async () => undefined),
    deploy: vi.fn(async () => ({ revision: 'deploy-abc' })),
    verify: vi.fn(async (_service, _prepared, _consumerIds, phase) => phase === 'after-revoke' ? ({
      backupId: 'backup-2',
      backupSha256: 'b'.repeat(64),
      drillId: 'drill-2',
      restoredItemCount: 9,
      verifiedAt: '2026-09-06T00:05:00.000Z',
    }) : undefined),
    waitForQuiescence: vi.fn(async () => ({ activeJobIds: [] })),
    revoke: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('项目共享凭据轮换状态机', () => {
  it('严格按恢复门禁、并行签发、部署、双重验证、撤销顺序执行', async () => {
    const store = new MemoryStore(infra());
    const driver = backend();
    const service = new InfraCredentialRotationService(store, driver, {
      idFactory: () => 'icr-test',
      now: () => new Date('2026-09-06T01:02:03.000Z'),
    });
    const result = await service.execute('project-a', 'mongodb', 'request-1234');

    expect(result.stage).toBe('verified_after_revoke');
    expect(result.consumerIds).toEqual(['branch-a', 'branch-b']);
    expect(result.rollback).toBe('not-required');
    expect(result.events.map((event) => event.stage)).toEqual([
      'prepared', 'recovery_verified', 'issued', 'deployed', 'verified', 'quiescence_verified', 'revoked', 'verified_after_revoke',
    ]);
    expect(driver.verify).toHaveBeenNthCalledWith(1, store.service, expect.anything(), result.consumerIds, 'before-revoke');
    expect(driver.verify).toHaveBeenNthCalledWith(2, store.service, expect.anything(), result.consumerIds, 'after-revoke');
    expect(JSON.stringify(result)).not.toContain('old-secret');
    expect(JSON.stringify(result)).not.toContain('new-secret');
    expect(result.events[1].evidence?.backupSha256).toBe('a'.repeat(16));
    expect(result.events.at(-1)?.evidence?.backupId).toBe('backup-2');
  });

  it('部署后验证失败会回滚，失败记录不收录驱动错误或凭据', async () => {
    const store = new MemoryStore(infra('redis'));
    const driver = backend({
      verify: vi.fn(async () => { throw new Error('new-secret accidentally mentioned'); }),
    });
    const service = new InfraCredentialRotationService(store, driver, { idFactory: () => 'icr-failed' });

    await expect(service.execute('project-a', 'redis', 'request-5678'))
      .rejects.toEqual(new RotationStepError('rotation.verify_before_revoke_failed'));
    expect(driver.rollback).toHaveBeenCalledOnce();
    expect(store.service.credentialRotation?.stage).toBe('failed');
    expect(store.service.credentialRotation?.rollback).toBe('completed');
    expect(JSON.stringify(store.service.credentialRotation)).not.toContain('new-secret');
    expect(JSON.stringify(store.service.credentialRotation)).not.toContain('accidentally mentioned');
  });

  it('撤销前存在持久在途作业时 fail-closed，台账只记录作业 id 与数量', async () => {
    const store = new MemoryStore(infra());
    const driver = backend({
      waitForQuiescence: vi.fn(async () => ({
        activeJobIds: ['maintenance:imj-safe-id', 'migration:migration-safe-id'],
      })),
    });

    await expect(new InfraCredentialRotationService(store, driver)
      .execute('project-a', 'mongodb', 'request-active-jobs'))
      .rejects.toThrow('rotation.active_jobs_in_progress');

    expect(driver.revoke).not.toHaveBeenCalled();
    expect(driver.rollback).toHaveBeenCalledOnce();
    const blocked = store.service.credentialRotation?.events.find((event) => event.stage === 'quiescence_blocked');
    expect(blocked?.evidence).toEqual({
      activeJobCount: 2,
      activeJobIds: 'maintenance:imj-safe-id,migration:migration-safe-id',
      activeJobIdsTruncated: false,
    });
    expect(JSON.stringify(blocked)).not.toMatch(/secret|password/i);
  });

  it('部分分支部署成功后失败会逐分支耐久记账并只回滚已切换消费者', async () => {
    const store = new MemoryStore(infra());
    const driver = backend({
      enumerateConsumers: vi.fn(async () => ['branch-a/api', 'branch-b/api']),
      deploy: vi.fn(async (_service, _prepared, _consumerIds, onProgress) => {
        await onProgress?.(['branch-a/api']);
        throw new Error('second branch failed');
      }),
    });
    const service = new InfraCredentialRotationService(store, driver, { idFactory: () => 'icr-partial' });

    await expect(service.execute('project-a', 'mongodb', 'request-partial'))
      .rejects.toThrow('rotation.deploy_failed');
    expect(store.service.credentialRotation?.deployedConsumerIds).toEqual(['branch-a/api']);
    expect(driver.rollback).toHaveBeenCalledWith(
      store.service, expect.anything(), ['prepared', 'issued'], ['branch-a/api'],
    );
  });

  it('进程在 rollback_started 后重启只重放幂等回滚，不会继续正向撤销', async () => {
    const target = infra();
    target.credentialRotation = {
      id: 'icr-rollback-resume', idempotencyKey: 'request-rollback-resume', projectId: 'project-a', serviceId: 'mongodb',
      runtime: 'mongodb', stage: 'failed', previousFingerprint: '1111111111111111', nextFingerprint: '2222222222222222',
      consumerIds: ['branch-a/api', 'branch-b/api'], deployedConsumerIds: ['branch-a/api'],
      failureCode: 'rotation.deploy_failed', rollback: 'started',
      startedAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:01:00.000Z',
      events: [
        { stage: 'prepared', at: '2026-09-06T00:00:00.000Z' },
        { stage: 'issued', at: '2026-09-06T00:00:10.000Z' },
        { stage: 'failed', at: '2026-09-06T00:01:00.000Z' },
        { stage: 'rollback_started', at: '2026-09-06T00:01:00.000Z' },
      ],
    };
    const store = new MemoryStore(target);
    const driver = backend({ finalize: vi.fn(async () => undefined) });
    const result = await new InfraCredentialRotationService(store, driver)
      .execute('project-a', 'mongodb', 'request-rollback-resume');

    expect(result.rollback).toBe('completed');
    expect(result.events.map((event) => event.stage)).toContain('rollback_completed');
    expect(driver.rollback).toHaveBeenCalledWith(target, expect.anything(), ['prepared', 'issued'], ['branch-a/api']);
    expect(driver.issue).not.toHaveBeenCalled();
    expect(driver.deploy).not.toHaveBeenCalled();
    expect(driver.revoke).not.toHaveBeenCalled();
  });

  it('撤销后复验失败同样重建旧凭据并回滚消费者', async () => {
    const store = new MemoryStore(infra());
    let verification = 0;
    const driver = backend({
      verify: vi.fn(async () => {
        verification += 1;
        if (verification === 2) throw new Error('old credential accepted');
      }),
    });
    const service = new InfraCredentialRotationService(store, driver);
    await expect(service.execute('project-a', 'mongodb', 'request-9012')).rejects.toThrow('rotation.verify_after_revoke_failed');
    expect(driver.rollback).toHaveBeenCalledWith(
      store.service, expect.anything(), ['prepared', 'issued', 'deployed', 'verified', 'revoked'], ['branch-a', 'branch-b'],
    );
    expect(store.service.credentialRotation?.events.map((event) => event.stage)).toContain('rollback_completed');
  });

  it('success finalize 中途失败转回滚后，人工处置必须压过已经写入的 TTL', async () => {
    const recoveryDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cds-finalize-rollback-'));
    const artifactRoot = path.join(recoveryDir, 'rotation-a1b2c3');
    const backupId = 'local:project-a:mongodb:rotation-a1b2c3:1111111111111111';
    await fs.promises.mkdir(artifactRoot, { mode: 0o700 });
    try {
      const store = new MemoryStore(infra());
      const finalize = vi.fn(async (
        _service: InfraService,
        _prepared: RotationPreparedCredential,
        outcome: 'success' | 'rollback-completed' | 'rollback-failed',
        record: InfraCredentialRotationRecord,
      ) => {
        if (outcome === 'success') {
          await markRotationRecoveryArtifactsForCleanup({ recoveryDir, backupIds: [backupId], retentionMs: 1 });
          throw new Error('simulated vault flush failure');
        }
        await markRotationRecoveryArtifactsForManualReview({
          recoveryDir, backupIds: [backupId], operationId: record.id, reason: outcome,
        });
      });
      const recoveryEvidence = {
        backupId, backupSha256: 'a'.repeat(64), drillId: 'drill-finalize', restoredItemCount: 1,
        verifiedAt: '2026-09-06T00:00:00.000Z',
      };
      const driver = backend({
        verifyRecovery: vi.fn(async () => recoveryEvidence),
        verify: vi.fn(async (_service, _prepared, _consumers, phase) => phase === 'after-revoke' ? recoveryEvidence : undefined),
        finalize,
      });

      await expect(new InfraCredentialRotationService(store, driver)
        .execute('project-a', 'mongodb', 'request-finalize-failure'))
        .rejects.toThrow('rotation.verify_after_revoke_failed');
      expect(driver.rollback).toHaveBeenCalledOnce();
      expect(store.service.credentialRotation?.rollback).toBe('completed');
      expect(fs.existsSync(path.join(artifactRoot, '.manual-review.json'))).toBe(true);
      expect(fs.existsSync(path.join(artifactRoot, '.cleanup.json'))).toBe(false);

      // 模拟两文件操作之间崩溃留下双 marker；下一次启动 prune 也必须保留。
      await fs.promises.writeFile(path.join(artifactRoot, '.cleanup.json'), JSON.stringify({
        backupId, expiresAt: '2026-09-06T00:00:00.000Z',
      }), { mode: 0o600 });
      await pruneExpiredRotationRecoveryArtifacts(recoveryDir, new Date('2026-09-07T00:00:00.000Z'));
      expect(fs.existsSync(artifactRoot)).toBe(true);
      expect(fs.existsSync(path.join(artifactRoot, '.cleanup.json'))).toBe(false);
    } finally {
      await fs.promises.rm(recoveryDir, { recursive: true, force: true });
    }
  });

  it('同一幂等键并发与完成后重放都只执行一次', async () => {
    const store = new MemoryStore(infra());
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const driver = backend({ issue: vi.fn(async () => { await gate; }) });
    const service = new InfraCredentialRotationService(store, driver, { idFactory: () => 'icr-idempotent' });
    const one = service.execute('project-a', 'mongodb', 'request-abcd');
    const two = service.execute('project-a', 'mongodb', 'request-abcd');
    release?.();
    const [a, b] = await Promise.all([one, two]);
    const replay = await service.execute('project-a', 'mongodb', 'request-abcd');

    expect(a.id).toBe(b.id);
    expect(replay.id).toBe(a.id);
    expect(driver.issue).toHaveBeenCalledOnce();
    expect(driver.revoke).toHaveBeenCalledOnce();
  });

  it('不同幂等键不能并发进入同一资源', async () => {
    const store = new MemoryStore(infra());
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const driver = backend({ issue: vi.fn(async () => { await gate; }) });
    const service = new InfraCredentialRotationService(store, driver);
    const first = service.execute('project-a', 'mongodb', 'request-first');
    await expect(service.execute('project-a', 'mongodb', 'request-other'))
      .rejects.toThrow('rotation.another_operation_incomplete');
    release?.();
    await first;
    expect(driver.issue).toHaveBeenCalledOnce();
  });

  it('进程重启后从密封上下文对应的已持久阶段续跑', async () => {
    const target = infra();
    target.credentialRotation = {
      id: 'icr-resume', idempotencyKey: 'request-resume', projectId: 'project-a', serviceId: 'mongodb',
      runtime: 'mongodb', stage: 'deployed', previousFingerprint: '1111111111111111',
      nextFingerprint: '2222222222222222', consumerIds: ['branch-a'], deploymentRevision: 'revision-a',
      startedAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:01:00.000Z',
      events: [
        { stage: 'recovery_verified', at: '2026-09-06T00:00:00.000Z' },
        { stage: 'prepared', at: '2026-09-06T00:00:01.000Z' },
        { stage: 'issued', at: '2026-09-06T00:00:02.000Z' },
        { stage: 'deployed', at: '2026-09-06T00:01:00.000Z' },
      ],
    };
    const store = new MemoryStore(target);
    const driver = backend();
    const resumed = await new InfraCredentialRotationService(store, driver)
      .execute('project-a', 'mongodb', 'request-resume');
    expect(resumed.stage).toBe('verified_after_revoke');
    expect(driver.issue).not.toHaveBeenCalled();
    expect(driver.deploy).not.toHaveBeenCalled();
    expect(driver.verify).toHaveBeenCalledTimes(2);
    expect(driver.revoke).toHaveBeenCalledOnce();
  });

  it('没有消费者不建立意图；恢复证据不完整时只密封意图而不签发新凭据', async () => {
    const store = new MemoryStore(infra());
    const noConsumers = backend({ enumerateConsumers: vi.fn(async () => []) });
    await expect(new InfraCredentialRotationService(store, noConsumers)
      .execute('project-a', 'mongodb', 'request-none'))
      .rejects.toThrow('rotation.consumers_not_found');
    expect(noConsumers.prepare).not.toHaveBeenCalled();

    const badRecovery = backend({
      verifyRecovery: vi.fn(async () => ({
        backupId: '', backupSha256: '', drillId: '', restoredItemCount: 0, verifiedAt: '',
      })),
    });
    await expect(new InfraCredentialRotationService(new MemoryStore(infra()), badRecovery)
      .execute('project-a', 'mongodb', 'request-gate'))
      .rejects.toThrow('rotation.recovery_gate_invalid');
    expect(badRecovery.prepare).toHaveBeenCalledOnce();
    expect(badRecovery.issue).not.toHaveBeenCalled();
  });
});
