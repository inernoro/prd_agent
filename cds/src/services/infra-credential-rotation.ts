import crypto from 'node:crypto';
import type {
  InfraCredentialRotationEvent,
  InfraCredentialRotationRecord,
  InfraCredentialRotationStage,
  InfraService,
} from '../types.js';

export interface RotationRecoveryEvidence {
  backupId: string;
  backupSha256: string;
  drillId: string;
  restoredItemCount: number;
  verifiedAt: string;
}

export interface RotationPreparedCredential {
  previousFingerprint: string;
  nextFingerprint: string;
  /** 驱动私有上下文，可持有本次调用期间所需的凭据；绝不进入台账或响应。 */
  opaque: unknown;
}

export interface RotationDeployResult {
  revision: string;
}

export interface RotationQuiescenceEvidence {
  activeJobIds: string[];
}

export type RotationDeploymentProgress = (consumerIds: readonly string[]) => Promise<void>;

export interface InfraCredentialRotationBackend {
  enumerateConsumers(service: InfraService): Promise<string[]>;
  verifyRecovery(service: InfraService): Promise<RotationRecoveryEvidence>;
  prepare(
    service: InfraService,
    operation: { operationId: string; idempotencyKey: string },
  ): Promise<RotationPreparedCredential>;
  issue(service: InfraService, prepared: RotationPreparedCredential): Promise<void>;
  deploy(
    service: InfraService,
    prepared: RotationPreparedCredential,
    consumerIds: readonly string[],
    onProgress?: RotationDeploymentProgress,
  ): Promise<RotationDeployResult>;
  verify(
    service: InfraService,
    prepared: RotationPreparedCredential,
    consumerIds: readonly string[],
    phase: 'before-revoke' | 'after-revoke',
  ): Promise<RotationRecoveryEvidence | void>;
  /** 撤销旧凭据前，等待所有会继续使用旧连接的非服务作业退出。 */
  waitForQuiescence(service: InfraService): Promise<RotationQuiescenceEvidence>;
  revoke(service: InfraService, prepared: RotationPreparedCredential): Promise<void>;
  rollback(
    service: InfraService,
    prepared: RotationPreparedCredential,
    completedStages: readonly InfraCredentialRotationStage[],
    consumerIds: readonly string[],
  ): Promise<void>;
  finalize?(
    service: InfraService,
    prepared: RotationPreparedCredential,
    outcome: 'success' | 'rollback-completed' | 'rollback-failed',
    record: InfraCredentialRotationRecord,
  ): Promise<void>;
}

export interface InfraCredentialRotationStore {
  getService(projectId: string, serviceId: string): InfraService | undefined;
  saveRecord(projectId: string, serviceId: string, record: InfraCredentialRotationRecord): Promise<void> | void;
}

export interface InfraCredentialRotationOptions {
  now?: () => Date;
  idFactory?: () => string;
}

export class RotationStepError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const RUNNING = new Map<string, { idempotencyKey: string; promise: Promise<InfraCredentialRotationRecord> }>();

function fingerprint(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

/** 生成只含 URL-safe 字符的 256-bit 口令，便于 Redis RESP 与连接串安全承载。 */
export function generateRotationSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function credentialFingerprint(user: string, secret: string): string {
  return fingerprint(`${String(user)}\0${String(secret)}`);
}

export function publicRotationRecord(record: InfraCredentialRotationRecord): InfraCredentialRotationRecord {
  return {
    id: record.id,
    idempotencyKey: record.idempotencyKey,
    projectId: record.projectId,
    serviceId: record.serviceId,
    runtime: record.runtime,
    stage: record.stage,
    previousFingerprint: record.previousFingerprint,
    nextFingerprint: record.nextFingerprint,
    consumerIds: [...record.consumerIds],
    ...(record.deployedConsumerIds ? { deployedConsumerIds: [...record.deployedConsumerIds] } : {}),
    ...(record.deploymentRevision ? { deploymentRevision: record.deploymentRevision } : {}),
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    ...(record.failureCode ? { failureCode: record.failureCode } : {}),
    ...(record.rollback ? { rollback: record.rollback } : {}),
    events: record.events.map((event) => ({
      stage: event.stage,
      at: event.at,
      ...(event.evidence ? { evidence: { ...event.evidence } } : {}),
    })),
  };
}

function runtimeOf(service: InfraService): 'mongodb' | 'redis' {
  const label = `${service.id} ${service.basePresetId || ''} ${service.dockerImage}`.toLowerCase();
  if (label.includes('mongo')) return 'mongodb';
  if (label.includes('redis')) return 'redis';
  throw new RotationStepError('rotation.runtime_unsupported');
}

export class InfraCredentialRotationService {
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(
    private readonly store: InfraCredentialRotationStore,
    private readonly backend: InfraCredentialRotationBackend,
    options: InfraCredentialRotationOptions = {},
  ) {
    this.now = options.now || (() => new Date());
    this.idFactory = options.idFactory || (() => `icr_${crypto.randomBytes(12).toString('hex')}`);
  }

  async execute(projectId: string, serviceId: string, idempotencyKey: string): Promise<InfraCredentialRotationRecord> {
    // 单飞锁必须按资源，而不是按幂等键。两个不同请求同时签发会互相覆盖甚至撤销。
    const key = `${projectId}\0${serviceId}`;
    const existingRun = RUNNING.get(key);
    if (existingRun) {
      if (existingRun.idempotencyKey !== idempotencyKey) {
        throw new RotationStepError('rotation.another_operation_incomplete');
      }
      return publicRotationRecord(await existingRun.promise);
    }
    const run = this.executeOnce(projectId, serviceId, idempotencyKey);
    RUNNING.set(key, { idempotencyKey, promise: run });
    try {
      return publicRotationRecord(await run);
    } finally {
      if (RUNNING.get(key)?.promise === run) RUNNING.delete(key);
    }
  }

  private async executeOnce(
    projectId: string,
    serviceId: string,
    idempotencyKey: string,
  ): Promise<InfraCredentialRotationRecord> {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
      throw new RotationStepError('rotation.idempotency_key_invalid');
    }
    const service = this.store.getService(projectId, serviceId);
    if (!service) throw new RotationStepError('rotation.service_not_found');
    const runtime = runtimeOf(service);
    const previous = service.credentialRotation;
    const vault = service.credentialRotationVault;
    if (vault && vault.idempotencyKey !== idempotencyKey) {
      throw new RotationStepError('rotation.another_operation_incomplete');
    }
    if (previous?.idempotencyKey === idempotencyKey) {
      if (previous.stage === 'verified_after_revoke') {
        if (vault) {
          const prepared = await this.backend.prepare(service, { operationId: previous.id, idempotencyKey });
          await this.backend.finalize?.(service, prepared, 'success', previous);
        }
        return publicRotationRecord(previous);
      }
      if (previous.stage === 'failed' && previous.rollback === 'completed') {
        if (vault) {
          const prepared = await this.backend.prepare(service, { operationId: previous.id, idempotencyKey });
          await this.backend.finalize?.(service, prepared, 'rollback-completed', previous);
        }
        return publicRotationRecord(previous);
      }
    }
    if (previous && previous.idempotencyKey !== idempotencyKey
      && previous.stage !== 'verified_after_revoke'
      && !(previous.stage === 'failed' && previous.rollback === 'completed')) {
      throw new RotationStepError('rotation.another_operation_incomplete');
    }

    const operationId = previous?.idempotencyKey === idempotencyKey
      ? previous.id
      : vault?.idempotencyKey === idempotencyKey
        ? vault.operationId
        : this.idFactory();
    const consumerIds = previous?.idempotencyKey === idempotencyKey
      ? [...previous.consumerIds]
      : [...new Set(await this.backend.enumerateConsumers(service))].sort();
    if (consumerIds.length === 0) throw new RotationStepError('rotation.consumers_not_found');
    // prepare 先把操作意图和新旧上下文密封落盘，且发生在恢复演练的 SAVE/dump
    // 以及任何数据库凭据 mutation 之前。演练失败时 vault 保留，同幂等键可续跑。
    const prepared = await this.backend.prepare(service, { operationId, idempotencyKey });
    if (!/^[0-9a-f]{16}$/i.test(prepared.previousFingerprint)
      || !/^[0-9a-f]{16}$/i.test(prepared.nextFingerprint)
      || prepared.previousFingerprint === prepared.nextFingerprint) {
      throw new RotationStepError('rotation.credential_fingerprint_invalid');
    }
    let recovery: RotationRecoveryEvidence | undefined;
    if (!previous || previous.idempotencyKey !== idempotencyKey) {
      recovery = await this.backend.verifyRecovery(service);
      const emptyRedisIsRecoverable = runtime === 'redis' && recovery.restoredItemCount === 0;
      if (!recovery.backupId || !/^[0-9a-f]{64}$/i.test(recovery.backupSha256)
        || !recovery.drillId || (recovery.restoredItemCount <= 0 && !emptyRedisIsRecoverable)) {
        throw new RotationStepError('rotation.recovery_gate_invalid');
      }
    }

    const at = this.now().toISOString();
    const record: InfraCredentialRotationRecord = previous?.idempotencyKey === idempotencyKey
      ? structuredClone(previous)
      : {
      id: operationId,
      idempotencyKey,
      projectId,
      serviceId,
      runtime,
      stage: 'prepared',
      previousFingerprint: prepared.previousFingerprint,
      nextFingerprint: prepared.nextFingerprint,
      consumerIds,
      startedAt: at,
      updatedAt: at,
      events: [{ stage: 'prepared', at }, {
        stage: 'recovery_verified', at, evidence: {
          backupId: recovery!.backupId,
          backupSha256: recovery!.backupSha256.slice(0, 16),
          drillId: recovery!.drillId,
          restoredItemCount: recovery!.restoredItemCount,
          verifiedAt: recovery!.verifiedAt,
        },
      }],
    };
    await this.store.saveRecord(projectId, serviceId, publicRotationRecord(record));
    const completed = record.events
      .map((event) => event.stage)
      .filter((stage): stage is InfraCredentialRotationStage =>
        ['prepared', 'issued', 'deployed', 'verified', 'revoked', 'verified_after_revoke'].includes(stage));

    const completeRollback = async (): Promise<InfraCredentialRotationRecord> => {
      const rollbackConsumers = record.deployedConsumerIds
        || (completed.includes('deployed') ? record.consumerIds : []);
      try {
        await this.backend.rollback(service, prepared, completed, rollbackConsumers);
        record.rollback = 'completed';
        record.updatedAt = this.now().toISOString();
        record.finishedAt = record.updatedAt;
        record.events.push({ stage: 'rollback_completed', at: record.updatedAt });
        await this.store.saveRecord(projectId, serviceId, publicRotationRecord(record));
      } catch {
        record.rollback = 'failed';
        record.updatedAt = this.now().toISOString();
        record.finishedAt = record.updatedAt;
        record.events.push({ stage: 'rollback_failed', at: record.updatedAt });
        await this.store.saveRecord(projectId, serviceId, publicRotationRecord(record));
        await this.backend.finalize?.(service, prepared, 'rollback-failed', record);
        throw new RotationStepError(record.failureCode || 'rotation.rollback_failed');
      }
      await this.backend.finalize?.(service, prepared, 'rollback-completed', record);
      return publicRotationRecord(record);
    };

    if (record.stage === 'failed' && (record.rollback === 'started' || record.rollback === 'failed')) {
      return await completeRollback();
    }

    const advance = async (
      stage: InfraCredentialRotationStage,
      evidence?: InfraCredentialRotationEvent['evidence'],
    ): Promise<void> => {
      const nextAt = this.now().toISOString();
      record.stage = stage;
      record.updatedAt = nextAt;
      record.events.push({ stage, at: nextAt, ...(evidence ? { evidence } : {}) });
      completed.push(stage);
      await this.store.saveRecord(projectId, serviceId, publicRotationRecord(record));
    };

    let activeStep = 'issue';
    try {
      if (!completed.includes('issued')) {
        await this.backend.issue(service, prepared);
        await advance('issued');
      }
      if (!completed.includes('deployed')) {
        activeStep = 'deploy';
        const alreadyDeployed = new Set(record.deployedConsumerIds || []);
        const pendingConsumers = consumerIds.filter((consumerId) => !alreadyDeployed.has(consumerId));
        const deployed = await this.backend.deploy(service, prepared, pendingConsumers, async (deployedIds) => {
          record.deployedConsumerIds = [...new Set([
            ...(record.deployedConsumerIds || []),
            ...deployedIds,
          ])].sort();
          record.updatedAt = this.now().toISOString();
          await this.store.saveRecord(projectId, serviceId, publicRotationRecord(record));
        });
        if (!deployed.revision) throw new RotationStepError('rotation.deployment_revision_missing');
        record.deployedConsumerIds = [...consumerIds];
        record.deploymentRevision = deployed.revision;
        await advance('deployed', { deploymentRevision: deployed.revision });
      }
      if (!completed.includes('verified')) {
        activeStep = 'verify_before_revoke';
        await this.backend.verify(service, prepared, consumerIds, 'before-revoke');
        await advance('verified');
      }
      if (!completed.includes('revoked')) {
        activeStep = 'drain_active_jobs';
        const quiescence = await this.backend.waitForQuiescence(service);
        const activeJobIds = [...new Set(quiescence.activeJobIds)].sort();
        const quiescenceAt = this.now().toISOString();
        record.updatedAt = quiescenceAt;
        record.events.push({
          stage: activeJobIds.length === 0 ? 'quiescence_verified' : 'quiescence_blocked',
          at: quiescenceAt,
          evidence: {
            activeJobCount: activeJobIds.length,
            // 台账只记不含秘密的作业 id；设长度上限，避免异常状态把控制面文档撑大。
            activeJobIds: activeJobIds.slice(0, 50).join(','),
            activeJobIdsTruncated: activeJobIds.length > 50,
          },
        });
        await this.store.saveRecord(projectId, serviceId, publicRotationRecord(record));
        if (activeJobIds.length > 0) throw new RotationStepError('rotation.active_jobs_in_progress');
        activeStep = 'revoke';
        await this.backend.revoke(service, prepared);
        await advance('revoked');
      }
      if (!completed.includes('verified_after_revoke')) {
        activeStep = 'verify_after_revoke';
        const postRecovery = await this.backend.verify(service, prepared, consumerIds, 'after-revoke');
        if (!postRecovery) throw new RotationStepError('rotation.post_revoke_recovery_missing');
        record.rollback = 'not-required';
        record.finishedAt = this.now().toISOString();
        await advance('verified_after_revoke', {
          backupId: postRecovery.backupId,
          backupSha256: postRecovery.backupSha256.slice(0, 16),
          drillId: postRecovery.drillId,
          restoredItemCount: postRecovery.restoredItemCount,
          verifiedAt: postRecovery.verifiedAt,
        });
      }
      await this.backend.finalize?.(service, prepared, 'success', record);
      return publicRotationRecord(record);
    } catch (error) {
      record.stage = 'failed';
      record.failureCode = error instanceof RotationStepError ? error.code : `rotation.${activeStep}_failed`;
      record.rollback = 'started';
      record.updatedAt = this.now().toISOString();
      record.events.push({ stage: 'failed', at: record.updatedAt, evidence: { failureCode: record.failureCode } });
      record.events.push({ stage: 'rollback_started', at: record.updatedAt });
      await this.store.saveRecord(projectId, serviceId, publicRotationRecord(record));
      await completeRollback();
      throw new RotationStepError(record.failureCode);
    }
  }
}
