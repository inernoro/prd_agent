import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import type { CdsEventType } from './cds-events-bus.js';

export type CapacityStatus = 'ok' | 'warning' | 'critical' | 'unknown';
interface Trend { deltaBytes: number | null; bytesPerDay: number | null; windowSeconds: number | null }
export interface CapacityReport {
  version: 1; at: number; host: string; status: CapacityStatus;
  sources: Record<string, Trend & { path: string; device: string | null; bytes: number | null }>;
  filesystems: Record<string, Trend & { totalBytes: number; usedBytes: number; availableBytes: number;
    totalInodes: number; availableInodes: number; usedPercent: number; inodeUsedPercent: number | null;
    daysToFull: number | null; daysToReserve: number | null }>;
  alerts: Array<{ code: string; severity: Exclude<CapacityStatus, 'ok'>; device?: string }>;
  policy: { warningPercent: number; criticalPercent: number; reserveBytes: number; horizonDays: number; maxSamples: number };
}
export interface CapacityObservation {
  status: CapacityStatus; sampledAt: string | null; reason?: string; report?: CapacityReport;
}
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_AGE_MS = 2 * 3600_000;
const statuses = ['ok', 'warning', 'critical', 'unknown'];
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER;
const bytes = (v: unknown): v is number => finite(v) && Number.isSafeInteger(v) && v >= 0;
const nullable = (v: unknown) => v === null || finite(v);
const trend = (v: Record<string, any>) => nullable(v.deltaBytes) && nullable(v.bytesPerDay)
  && (v.windowSeconds === null || (finite(v.windowSeconds) && v.windowSeconds >= 900 && v.windowSeconds <= 8 * 86400))
  && ((v.windowSeconds === null) === (v.bytesPerDay === null)) && ((v.windowSeconds === null) === (v.deltaBytes === null));
function invalid(): never { throw new Error('invalid-capacity-report'); }

/** Producer schema is finite; malformed or incomplete readings never become green. */
export function validateCapacityReport(raw: unknown, host: string, now: number): CapacityObservation {
  if (!object(raw) || raw.version !== 1 || raw.host !== host || !finite(raw.at) || raw.at <= 0
    || raw.at * 1000 > now + 300_000 || now - raw.at * 1000 > MAX_AGE_MS || !statuses.includes(raw.status)
    || !Array.isArray(raw.alerts) || raw.alerts.length > 256) invalid();
  for (const a of raw.alerts) if (!object(a) || typeof a.code !== 'string' || a.code.length > 160
    || !['warning', 'critical', 'unknown'].includes(a.severity)) invalid();
  const sampledAt = new Date(raw.at * 1000).toISOString();
  // The collector can only publish a minimal unknown when collection/state itself failed.
  if (!raw.sources && raw.status === 'unknown' && raw.alerts.some((a: any) => a.severity === 'unknown'))
    return { status: 'unknown', sampledAt, reason: '容量采集失败，增长与安全余量未知' };
  if (!object(raw.sources) || !object(raw.filesystems) || !object(raw.policy)) invalid();
  const sourceRows = Object.values(raw.sources), disks = Object.values(raw.filesystems), p = raw.policy;
  if (sourceRows.length < 1 || sourceRows.length > 32 || disks.length < 1 || disks.length > 32
    || !finite(p.warningPercent) || !finite(p.criticalPercent) || !(0 < p.warningPercent && p.warningPercent < p.criticalPercent && p.criticalPercent <= 100)
    || !bytes(p.reserveBytes) || !finite(p.horizonDays) || p.horizonDays <= 0 || p.maxSamples !== 192) invalid();
  for (const s of sourceRows) if (!object(s) || typeof s.path !== 'string' || s.path.length > 4096
    || !(s.device === null || typeof s.device === 'string') || !(s.bytes === null || bytes(s.bytes)) || !trend(s)) invalid();
  const requireAlert = (device: string, code: string, condition: boolean) => {
    if (condition && !raw.alerts.some((a: any) => a.device === device && a.code === code)) invalid();
  };
  for (const [device, d] of Object.entries(raw.filesystems)) {
    if (!object(d) || !bytes(d.totalBytes) || d.totalBytes === 0 || !bytes(d.usedBytes) || d.usedBytes > d.totalBytes
      || !bytes(d.availableBytes) || d.availableBytes > d.totalBytes || !bytes(d.totalInodes) || !bytes(d.availableInodes)
      || d.availableInodes > d.totalInodes || !trend(d) || !finite(d.usedPercent) || d.usedPercent < 0 || d.usedPercent > 100
      || !nullable(d.inodeUsedPercent) || !nullable(d.daysToFull) || !nullable(d.daysToReserve)) invalid();
    const percent = 100 * (d.totalBytes - d.availableBytes) / d.totalBytes;
    if (Math.abs(percent - d.usedPercent) > 0.0001) invalid();
    const days = d.bytesPerDay !== null && d.bytesPerDay > 0 ? Math.max(0, d.availableBytes - p.reserveBytes) / d.bytesPerDay : null;
    if ((days === null) !== (d.daysToReserve === null) || (days !== null && d.daysToReserve !== null && Math.abs(days - d.daysToReserve) > 0.0001)) invalid();
    const inodePercent = d.totalInodes ? 100 * (d.totalInodes - d.availableInodes) / d.totalInodes : null;
    if ((inodePercent === null) !== (d.inodeUsedPercent === null) || (inodePercent !== null && d.inodeUsedPercent !== null && Math.abs(inodePercent - d.inodeUsedPercent) > 0.0001)) invalid();
    requireAlert(device, 'inodes-critical', inodePercent !== null && inodePercent >= p.criticalPercent);
    requireAlert(device, 'inodes-warning', inodePercent !== null && inodePercent >= p.warningPercent && inodePercent < p.criticalPercent);
    requireAlert(device, 'bytes-critical', percent >= p.criticalPercent);
    requireAlert(device, 'bytes-warning', percent >= p.warningPercent && percent < p.criticalPercent);
    requireAlert(device, 'reserve-low', d.availableBytes <= p.reserveBytes);
    requireAlert(device, 'reserve-exhaustion-forecast', days !== null && days <= p.horizonDays);
    requireAlert(device, 'growth-baseline-missing', d.windowSeconds === null);
  }
  if (sourceRows.some(s => s.bytes === null) && !raw.alerts.some((a: any) => a.severity === 'unknown')) invalid();
  const expected = raw.alerts.some((a: any) => a.severity === 'critical') ? 'critical'
    : raw.alerts.some((a: any) => a.severity === 'unknown') ? 'unknown' : raw.alerts.length ? 'warning' : 'ok';
  if (raw.status !== expected) invalid();
  return { status: raw.status, sampledAt, report: raw as CapacityReport,
    ...(raw.status === 'unknown' ? { reason: '采样不足或读取不完整，增长与安全余量未知' } : {}) };
}

export class HostCapacityObservationService {
  private snapshot: CapacityObservation = { status: 'unknown', sampledAt: null, reason: '尚未收到可信容量采样' };
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private running = false;
  private reading = false;
  private lastAt = 0;
  private unavailableAfter = 0;
  private lastConfiguredHost?: string;
  private risk = false;
  private lastSignal = '';
  private lastSignalAt = 0;
  constructor(private readonly options: {
    reportPath?: string; expectedHost?: string; now?: () => number;
    publish: (type: CdsEventType, data: unknown) => void;
  }) { this.lastConfiguredHost = options.expectedHost; }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  getSnapshot(): CapacityObservation {
    if (this.snapshot.sampledAt && this.now() - Date.parse(this.snapshot.sampledAt) > MAX_AGE_MS)
      return { status: 'unknown', sampledAt: this.snapshot.sampledAt, reason: '容量采样已超过两小时，当前风险未知' };
    return structuredClone(this.snapshot);
  }
  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation++;
    if (!this.options.reportPath || !this.options.expectedHost) {
      this.snapshot = { status: 'unknown', sampledAt: null, reason: '尚未接入宿主容量采样，当前风险未知' };
      return;
    }
    void this.poll(this.generation);
  }
  stop(): void {
    this.running = false; this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  configure(reportPath?: string, expectedHost?: string): void {
    const changed = Boolean(expectedHost && this.lastConfiguredHost && expectedHost !== this.lastConfiguredHost);
    if (expectedHost) this.lastConfiguredHost = expectedHost;
    this.stop();
    this.options.reportPath = reportPath; this.options.expectedHost = expectedHost;
    this.lastAt = 0; this.unavailableAfter = this.now();
    if (changed) { this.risk = false; this.lastSignal = ''; }
    this.snapshot = { status: 'unknown', sampledAt: null, reason: reportPath ? '正在等待新的可信容量采样' : '已暂停容量采样，当前风险未知' };
    this.start();
  }
  markUnavailable(reason: string): void {
    this.unavailableAfter = Math.max(this.now(), this.lastAt + 1);
    this.snapshot = { status: 'unknown', sampledAt: null, reason };
  }
  async refresh(): Promise<void> {
    if (this.reading) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.poll(this.generation);
  }
  private async read(): Promise<CapacityObservation> {
    const handle = await fs.open(this.options.reportPath!, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES || stat.mode & 0o077) invalid();
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_BYTES) invalid();
      return validateCapacityReport(JSON.parse(buffer.subarray(0, length).toString('utf8')), this.options.expectedHost!, this.now());
    } finally { await handle.close(); }
  }
  private async poll(generation: number): Promise<void> {
    if (!this.running || generation !== this.generation) return;
    if (this.reading) {
      this.timer = setTimeout(() => void this.poll(generation), 60_000); return;
    }
    this.reading = true;
    let next: CapacityObservation;
    try {
      next = await this.read();
      const at = Date.parse(next.sampledAt!);
      if (at < this.lastAt || at < this.unavailableAfter) invalid();

    } catch { next = { status: 'unknown', sampledAt: null, reason: '容量报告缺失、过期或读取失败，当前风险未知' }; }
    finally { this.reading = false; }
    if (!this.running || generation !== this.generation) return;
    if (next.sampledAt) this.lastAt = Date.parse(next.sampledAt);
    this.snapshot = next;
    const signal = JSON.stringify([next.status, next.reason, next.report?.alerts]);
    if (next.status !== 'ok') {
      if (signal !== this.lastSignal || this.now() - this.lastSignalAt >= 3600_000) {
        this.options.publish('capacity.observation.risk', { targetId: 'host-capacity-observation', message:
          next.reason ?? `容量增长检查为${next.status === 'critical' ? '严重风险' : '预警'}；${Object.values(next.report?.filesystems ?? {}).map(d => `占用${d.usedPercent.toFixed(1)}%，文件节点占用${d.inodeUsedPercent === null ? '未知' : d.inodeUsedPercent.toFixed(1) + '%'}，预计${d.daysToReserve === null ? '未知' : d.daysToReserve.toFixed(1) + '天'}触及安全余量`).join('；')}。请核对来源增长与保留项`,
        });
        this.lastSignal = signal; this.lastSignalAt = this.now();
      }
      this.risk = true;
    } else if (this.risk) {
      this.options.publish('capacity.observation.recovered', { targetId: 'host-capacity-observation',
        message: '新采样的增长与安全余量检查已恢复；其他回收失败仍须分别核对', autoRestoredAt: new Date(this.now()).toISOString() });
      this.risk = false; this.lastSignal = ''; this.lastSignalAt = this.now();
    }
    if (this.running && generation === this.generation) this.timer = setTimeout(() => void this.poll(generation), 60_000);
  }
}
