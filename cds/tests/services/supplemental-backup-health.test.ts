import { describe, expect, it } from 'vitest';
import { assessSupplementalBackups, supplementalBackupFindings } from '../../src/services/supplemental-backup-health.js';
import { buildBackupPanel, type BackupHealthRecord } from '../../src/services/backup-panel.js';

const now = new Date('2026-11-22T04:00:00Z');
const at = (hours: number) => new Date(now.getTime() - hours * 3600_000).toISOString();
const hash = 'a'.repeat(64);
const config = {
  stateDirectory: '/var/lib/cds-supplemental-backup',
  targets: [
    { project: 'ms', service: 'minio', kind: 'minio' },
    { project: 'ms', service: 'kafka', kind: 'kafka' },
    { project: 'md', service: 'object-store', kind: 'rustfs' },
    { project: 'md', service: 'rabbitmq', kind: 'rabbitmq' },
    { project: 'map', service: 'upstream', kind: 'stateless' },
    { project: 'map', service: 'dts', kind: 'state-runtime' },
  ],
};
const success = { at: at(0.8), bytes: 32, sha256: hash, recovery: { queues: 69, persistentMessages: 792 } };
const latest = {
  version: 2,
  completedAt: at(0.5),
  targets: config.targets.slice(0, 4).map(({ project, service, kind }) => ({
    projectId: project, id: service, kind, ok: true, lastVerified: success,
  })),
};
const probe = {
  version: 2,
  completedAt: at(0.2),
  targets: [config.targets[1], ...config.targets.slice(4)].map(({ project, service, kind }) => ({
    projectId: project, id: service, kind, ok: true,
  })),
};
const health: BackupHealthRecord = {
  completedAt: at(1),
  coverageGaps: config.targets.map(({ project, service }) => ({ projectId: project, id: service })),
  objects: [{ projectId: '__system__', id: 'cds-state-mongo', bytes: 64, sha256: hash, remoteObjectKey: 'confirmed' }],
};

describe('supplemental backup coverage', () => {
  it('uses verified receipts, the proxy inspection, and the state backup for the six original gaps', () => {
    const facts = assessSupplementalBackups(config, latest, probe, health, now);
    expect(facts.map((fact) => fact.status)).toEqual(['verified', 'verified', 'verified', 'verified', 'exempt', 'verified']);
    expect(facts[3].message).toContain('792 条持久消息');
    expect(facts[5]).toMatchObject({ source: 'state-backup', verifiedAt: at(1), bytes: null });
    expect(supplementalBackupFindings(facts)).toEqual([]);
    const view = buildBackupPanel({ projectId: 'ms', health, files: [], now, supplemental: facts,
      infra: [{ id: 'minio', dockerImage: 'minio/minio' }, { id: 'kafka', dockerImage: 'apache/kafka' }] });
    expect(view.targets.map((t) => [t.id, t.status, t.offsite, t.fileCount])).toEqual([
      ['kafka', 'ok', true, 0], ['minio', 'ok', true, 0],
    ]);
    expect(view.verdict.headline).toBe('2 个目标有已验证的副本');
  });

  it('fails closed on missing, expired, future, duplicated or cross-project receipts', () => {
    const alert = (value: unknown) => assessSupplementalBackups(config, value, probe, health, now)[0];
    expect(alert(null).code).toBe('receipt-unavailable');
    expect(alert({ ...latest, completedAt: at(31), targets: latest.targets.map((t) =>
      ({ ...t, lastVerified: { ...success, at: at(32) } })) }).code).toBe('receipt-stale');
    expect(alert({ ...latest, completedAt: at(-1) }).code).toBe('receipt-unavailable');
    expect(alert({ ...latest, targets: [...latest.targets, latest.targets[0]] }).code).toBe('receipt-unavailable');
    expect(alert({ ...latest, targets: [{ ...latest.targets[0], projectId: 'foreign' }] }).code).toBe('receipt-unavailable');
  });

  it('surfaces RabbitMQ recovery failure and Kafka data even with an earlier valid copy', () => {
    const failed = { ...latest, targets: latest.targets.map((t) => t.kind === 'rabbitmq'
      ? { ...t, ok: false, code: 'rabbitmq-restore-failed', error: 'sensitive diagnostic' } : t) };
    const observed = { ...probe, targets: probe.targets.map((t) => t.kind === 'kafka'
      ? { ...t, ok: false, code: 'kafka-data-present' } : t) };
    const facts = assessSupplementalBackups(config, failed, observed, health, now);
    expect(facts[1]).toMatchObject({ status: 'alert', code: 'kafka-data-present', verifiedAt: success.at });
    expect(facts[3]).toMatchObject({ status: 'alert', code: 'rabbitmq-restore-failed', verifiedAt: success.at });
    expect(supplementalBackupFindings(facts).map((finding) => finding.id)).toEqual([
      'backup.supplemental.ms.kafka.kafka-data-present', 'backup.supplemental.md.rabbitmq.rabbitmq-restore-failed',
    ]);
    expect(JSON.stringify(facts)).not.toContain('sensitive diagnostic');
    const view = buildBackupPanel({ projectId: 'ms', health, files: [], now, supplemental: facts,
      infra: [{ id: 'minio' }, { id: 'kafka' }] });
    expect(view.targets[0]).toMatchObject({ id: 'kafka', status: 'supplemental-alert', offsite: false });
    expect(view.verdict.tone).toBe('bad');
  });

  it('audits runtime changes and refuses an expired probe or unverified state backup', () => {
    const facts = assessSupplementalBackups(config, latest, { ...probe, completedAt: at(2) }, health, now);
    expect(facts[1].code).toBe('probe-stale');
    const unverifiedState = { ...health, offsiteOnlyTargets: [{ projectId: '__system__', id: 'cds-state-mongo' }] };
    expect(assessSupplementalBackups(config, latest, probe, unverifiedState, now)[5].code).toBe('state-backup-unverified');
    const observed = { ...probe, targets: probe.targets.map((t) => t.kind === 'state-runtime'
      ? { ...t, ok: false, code: 'runtime-data-present' } : t) };
    expect(assessSupplementalBackups(config, latest, observed, health, now)[5].code).toBe('runtime-data-present');
  });
});
