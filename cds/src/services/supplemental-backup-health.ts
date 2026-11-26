import fs from 'node:fs';
import { isPreviewInstance } from './preview-instance.js';
import { BACKUP_STALE_AFTER_MS } from './platform-daily-health.js';
import type { BackupHealthRecord } from './backup-panel.js';

const CONFIG = '/etc/cds-supplemental-backup.json';
const STATE_DIR = '/var/lib/cds-supplemental-backup';
const RECEIPT_FRESH_MS = 30 * 60 * 60_000;
const PROBE_FRESH_MS = 75 * 60_000;
const MAX_FILE_BYTES = 128 * 1024;
const KINDS = ['minio', 'rustfs', 'kafka', 'rabbitmq', 'stateless', 'state-runtime'] as const;
type Kind = typeof KINDS[number];

type Dict = Record<string, unknown>;
const dict = (value: unknown): Dict | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Dict : undefined;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const matchesId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9_][a-z0-9_-]{0,100}$/.test(value);
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const sha256 = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

const WARNINGS = {
  'receipt-unavailable': '没有读到有效的补充备份回执，请检查补充备份任务。',
  'receipt-stale': '补充备份回执已超过 30 小时，请运行补充备份并确认离机校验通过。',
  'probe-unavailable': '没有读到有效的运行状态检查，请检查覆盖巡检任务。',
  'probe-stale': '运行状态检查已过期，请重新执行覆盖巡检。',
  'probe-failed': '运行状态检查失败，请确认服务可用并重跑巡检。',
  'backup-failed': '最近一次补充备份失败，请检查备份任务并重跑。',
  'kafka-data-present': 'Kafka 已出现业务消息或消费位点。请配置消息和消费位点复制，空主题备份只能恢复主题定义。',
  'rabbitmq-restore-failed': 'RabbitMQ 隔离恢复验证失败。请排查恢复记录并重跑，新的恢复点尚未通过验证。',
  'stateless-changed': '代理实例的启动配置或挂载已变更，请重新核对是否需要备份。',
  'runtime-data-present': '同步运行时的数据卷已出现文件，请为卷内的数据配置备份。',
  'runtime-data-unconfirmed': '无法确认同步运行时数据卷的状态，请运行覆盖巡检。',
  'state-backup-unverified': '同步运行时的数据卷为空，但状态库离机备份尚未确认有效，请检查状态库备份。',
} as const;
type WarningCode = keyof typeof WARNINGS;

interface Target {
  projectId: string;
  id: string;
  kind: Kind;
}

export interface SupplementalBackupFact extends Target {
  status: 'verified' | 'exempt' | 'alert';
  source: 'supplemental' | 'state-backup' | 'stateless';
  code?: WarningCode;
  message: string;
  verifiedAt: string | null;
  bytes: number | null;
}

interface Point {
  at: string;
  bytes: number;
  recoveredQueues?: number;
  recoveredMessages?: number;
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value)) {
    return NaN;
  }
  return Date.parse(value);
}

function receiptRow(receipt: Dict | undefined, target: Target) {
  if (receipt?.version !== 2) return undefined;
  const rows = list(receipt.targets).map(dict).filter((row) =>
    row?.projectId === target.projectId && row?.id === target.id);
  return rows.length === 1 && rows[0]?.kind === target.kind ? rows[0] : undefined;
}

function readPoint(row: Dict | undefined, completed: number, kind: Kind): Point | undefined {
  const point = dict(row?.lastVerified);
  const at = timestamp(point?.at);
  if (!point || !Number.isFinite(at) || at > completed || !sha256(point.sha256) || !positive(point.bytes)) return;
  const result: Point = { at: new Date(at).toISOString(), bytes: point.bytes };
  if (kind !== 'rabbitmq') return result;
  const recovery = dict(point.recovery);
  const messages = recovery?.persistentMessages;
  if (!positive(recovery?.queues) || typeof messages !== 'number' || !Number.isSafeInteger(messages) || messages < 0) return;
  return { ...result, recoveredQueues: recovery.queues, recoveredMessages: messages };
}

function verifiedStateBackup(health: BackupHealthRecord | null, now: number): string | null {
  const ownsState = (row: unknown) => dict(row)?.projectId === '__system__' && dict(row)?.id === 'cds-state-mongo';
  const point = dict(list(health?.objects).find(ownsState));
  const at = timestamp(health?.completedAt);
  if (at > now || !(now - at <= BACKUP_STALE_AFTER_MS) || !point?.remoteObjectKey
      || !positive(point.bytes) || !sha256(point.sha256)
      || list(health?.failedTargets).some(ownsState) || list(health?.offsiteOnlyTargets).some(ownsState)
      || list(health?.coverageGaps).some(ownsState)) return null;
  return new Date(at).toISOString();
}

export function assessSupplementalBackups(
  config: unknown, latest: unknown, observed: unknown, health: BackupHealthRecord | null, now: Date,
): SupplementalBackupFact[] {
  const configuration = dict(config);
  if (configuration?.stateDirectory !== STATE_DIR) return [];
  const backup = dict(latest);
  const probe = dict(observed);
  const time = now.getTime();
  const backupAt = timestamp(backup?.completedAt);
  const probeAt = timestamp(probe?.completedAt);
  const seen = new Set<string>();
  const facts: SupplementalBackupFact[] = [];
  for (const raw of list(configuration.targets)) {
    const value = dict(raw);
    if (!matchesId(value?.project) || !matchesId(value.service) || !KINDS.includes(value.kind as Kind)) continue;
    const target: Target = { projectId: value.project, id: value.service, kind: value.kind as Kind };
    const key = target.projectId + '/' + target.id;
    if (seen.has(key)) {
      const prior = facts.findIndex((fact) => fact.projectId === target.projectId && fact.id === target.id);
      if (prior >= 0) facts.splice(prior, 1);
      continue;
    }
    seen.add(key);
    const { kind } = target;
    const source = kind === 'stateless' ? 'stateless' : kind === 'state-runtime' ? 'state-backup' : 'supplemental';
    const round = receiptRow(backup, target);
    const observation = receiptRow(probe, target);
    const point = backupAt <= time ? readPoint(round, backupAt, kind) : undefined;
    const details = { ...target, source, verifiedAt: point?.at ?? null, bytes: point?.bytes ?? null } as const;
    const warn = (code: WarningCode): SupplementalBackupFact => ({ ...details, status: 'alert', code, message: WARNINGS[code] });
    const needsProbe = kind === 'kafka' || kind === 'stateless' || kind === 'state-runtime';
    if (needsProbe) {
      const code = observation?.code;
      const probeIsCurrent = Number.isFinite(probeAt) && probeAt <= time;
      if (probeIsCurrent && observation?.ok === false && (
        (kind === 'kafka' && code === 'kafka-data-present')
        || (kind === 'stateless' && code === 'stateless-changed')
        || (kind === 'state-runtime' && (code === 'runtime-data-present' || code === 'runtime-data-unconfirmed'))
      )) { facts.push(warn(code)); continue; }
      if (!observation || !probeIsCurrent) { facts.push(warn('probe-unavailable')); continue; }
      if (time - probeAt > PROBE_FRESH_MS) { facts.push(warn('probe-stale')); continue; }
      if (observation.ok !== true) { facts.push(warn('probe-failed')); continue; }
    }
    if (kind === 'stateless') {
      facts.push({ ...details, status: 'exempt', message: '已核对代理的启动配置和挂载，无需单独备份。' });
      continue;
    }
    if (kind === 'state-runtime') {
      const verifiedAt = verifiedStateBackup(health, time);
      facts.push(verifiedAt
        ? { ...details, status: 'verified', verifiedAt,
          message: '运行时数据卷为空，持久配置已随 CDS 状态库完成离机备份。' }
        : warn('state-backup-unverified'));
      continue;
    }
    if (!round || !Number.isFinite(backupAt) || backupAt > time) { facts.push(warn('receipt-unavailable')); continue; }
    if (round.ok === false) {
      facts.push(warn(kind === 'rabbitmq' && round.code === 'rabbitmq-restore-failed' ? 'rabbitmq-restore-failed'
        : kind === 'kafka' && round.code === 'kafka-data-present' ? 'kafka-data-present' : 'backup-failed'));
      continue;
    }
    if (round.ok !== true || !point) { facts.push(warn('receipt-unavailable')); continue; }
    if (time - backupAt > RECEIPT_FRESH_MS || time - Date.parse(point.at) > RECEIPT_FRESH_MS) {
      facts.push(warn('receipt-stale'));
      continue;
    }
    const message = kind === 'rabbitmq'
      ? `已通过隔离恢复验证，核对了 ${point.recoveredQueues} 个队列和 ${point.recoveredMessages} 条持久消息。`
      : kind === 'kafka' ? '主题定义已完成离机备份。最近巡检未发现业务消息或消费位点。'
        : '对象与桶配置已完成离机备份并通过回读校验。';
    facts.push({ ...details, status: 'verified', message });
  }
  return facts;
}

function readRootJson(path: string): unknown {
  try {
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.size > MAX_FILE_BYTES) return undefined;
      const buffer = Buffer.alloc(stat.size);
      if (fs.readSync(fd, buffer, 0, buffer.length, 0) !== buffer.length) return undefined;
      return JSON.parse(buffer.toString('utf8'));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

export function readSupplementalBackupHealth(health: BackupHealthRecord | null, now: Date): SupplementalBackupFact[] {
  if (isPreviewInstance()) return [];
  const configuration = readRootJson(CONFIG);
  if (!configuration) return [];
  return assessSupplementalBackups(configuration, readRootJson(`${STATE_DIR}/latest.json`),
    readRootJson(`${STATE_DIR}/probe.json`), health, now);
}

export function supplementalBackupFindings(facts: readonly SupplementalBackupFact[]) {
  return facts.filter((fact) => fact.status === 'alert').map((fact) => ({
    id: `backup.supplemental.${fact.projectId}.${fact.id}.${fact.code}`,
    severity: 'warn' as const,
    message: `${fact.id} · ${fact.message}`,
  }));
}
