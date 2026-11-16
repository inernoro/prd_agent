import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostCapacityObservationService, validateCapacityReport } from '../../src/services/host-capacity-observation.js';
import { cdsEventsBus } from '../../src/services/cds-events-bus.js';
import { NoticeLedgerService, startNoticeLedger } from '../../src/services/notice-ledger.js';

const GIB = 1024 ** 3;
const now = Date.UTC(2026, 10, 16, 8);
export function report(status: 'warning' | 'ok' | 'unknown' = 'warning') {
  const rate = status === 'unknown' ? null : status === 'ok' ? -GIB : 10 * GIB;
  const trend = { deltaBytes: rate, bytesPerDay: rate, windowSeconds: rate === null ? null : 86400 };
  return { version: 1, host: 'isolated-host', at: now / 1000, status,
    sources: { cache: { path: '/isolated/cache', device: '1', bytes: 20 * GIB, ...trend } },
    filesystems: { '1': { totalBytes: 100 * GIB, usedBytes: 60 * GIB, availableBytes: 40 * GIB,
      totalInodes: 1000, availableInodes: 900, ...trend, usedPercent: 60, inodeUsedPercent: 10,
      daysToFull: status === 'warning' ? 4 : null, daysToReserve: status === 'warning' ? 3.4 : null } },
    alerts: status === 'ok' ? [] : [{ code: status === 'warning' ? 'reserve-exhaustion-forecast' : 'growth-baseline-missing', severity: status, device: '1' }],
    policy: { warningPercent: 75, criticalPercent: 90, reserveBytes: 6 * GIB, horizonDays: 7, maxSamples: 192 } };
}
const dirs: string[] = [];
const stops: Array<() => void> = [];
afterEach(async () => { stops.splice(0).forEach(f => f()); vi.restoreAllMocks(); vi.useRealTimers(); await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'host-capacity-')); dirs.push(dir);
  const file = path.join(dir, 'latest.json');
  const write = (value: unknown) => fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
  await write(report());
  return { dir, file, write };
}
async function settle(check: () => void) {
  for (let n = 0; n < 200; n++) {
    try { check(); return; } catch { await new Promise(resolve => setImmediate(resolve)); }
  }
  check();
}
describe('可信采样桥接', () => {
  it('低于水位的 3.4 天预测进入真实总线/账本/外发，同态去重，恢复不解除回收故障', async () => {
    const f = await fixture(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); vi.setSystemTime(now);
    const publicEvents: unknown[] = [];
    stops.push(cdsEventsBus.subscribe(event => { if (event.type.startsWith('capacity.observation.')) publicEvents.push(event.data); }));
    const ledger = new NoticeLedgerService({ storePath: '' });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { id: 'fixture-receipt' } }), { status: 200 }));
    const handler = startNoticeLedger({ ledger, outbound: { baseUrl: 'https://map.example.test', token: 'fixture', source: 'system-alert' }, fetchImpl }); stops.push(handler.stop);
    const service = new HostCapacityObservationService({ reportPath: f.file, expectedHost: 'isolated-host', publish: (type, data) => cdsEventsBus.publish(type, data) }); stops.push(() => service.stop());
    service.start(); await settle(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(service.getSnapshot().report?.filesystems['1']).toMatchObject({ usedPercent: 60, daysToReserve: 3.4 });
    expect(ledger.list()[0]).toMatchObject({ eventType: 'capacity.observation.risk', href: '/cds-settings#scheduler' });
    await vi.advanceTimersByTimeAsync(60_000); await settle(() => expect(service.getSnapshot().status).toBe('warning'));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    cdsEventsBus.publish('capacity.risk', { targetId: 'janitor', message: '隔离回收失败仍存在' });
    await f.write(report('ok')); await vi.advanceTimersByTimeAsync(60_000);
    await settle(() => expect(ledger.list().some(n => n.eventType === 'capacity.observation.recovered')).toBe(true));
    expect(ledger.list().some(n => n.eventType === 'capacity.risk')).toBe(true);
    expect(ledger.list().some(n => n.eventType === 'capacity.recovered')).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(publicEvents)).not.toContain('/isolated/cache');
    expect(JSON.stringify(publicEvents)).not.toContain('isolated-host');
    expect(JSON.stringify(publicEvents)).not.toContain('\"report\"');
    service.stop(); await vi.advanceTimersByTimeAsync(3600_000); expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it('不完整、过期、未来、身份不符、伪安全均拒绝', () => {
    expect(validateCapacityReport(report('unknown'), 'isolated-host', now).status).toBe('unknown');
    for (const value of [ { ...report(), at: now / 1000 - 7201 }, { ...report(), at: now / 1000 + 301 },
      { ...report(), host: 'wrong' }, { ...report(), sources: {} }, { ...report(), status: 'ok' },
      { ...report(), alerts: [], status: 'ok' }, { ...report(), policy: {} } ]) {
      expect(() => validateCapacityReport(value, 'isolated-host', now)).toThrow();
    }
  });
  it.each(['missing', 'symlink', 'fifo', 'oversize', 'public', 'corrupt'])('%s 文件只能显示未知', async kind => {
    const f = await fixture(); await fs.unlink(f.file);
    if (kind === 'symlink') { await f.write(report()); await fs.rename(f.file, f.file + '.real'); await fs.symlink(f.file + '.real', f.file); }
    if (kind === 'fifo') { const { execFileSync } = await import('node:child_process'); execFileSync('mkfifo', [f.file]); }
    if (kind === 'oversize') await fs.writeFile(f.file, Buffer.alloc(4 * 1024 ** 2 + 1), { mode: 0o600 });
    if (kind === 'public') { await f.write(report()); await fs.chmod(f.file, 0o644); }
    if (kind === 'corrupt') await fs.writeFile(f.file, '{', { mode: 0o600 });
    const publish = vi.fn(); const service = new HostCapacityObservationService({ reportPath: f.file, expectedHost: 'isolated-host', now: () => now, publish }); stops.push(() => service.stop());
    service.start(); await settle(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(service.getSnapshot()).toMatchObject({ status: 'unknown' }); expect(service.getSnapshot().report).toBeUndefined();
  });
  it('未配置不产生定时器或假恢复；停止后的迟到读取不能发布或续订', async () => {
    const f = await fixture(); const publish = vi.fn();
    const unconfigured = new HostCapacityObservationService({ publish }); unconfigured.start(); unconfigured.stop(); expect(publish).not.toHaveBeenCalled();
    const open = fs.open.bind(fs); let resume!: () => void;
    const gate = new Promise<void>(r => { resume = r; });
    let closed!: () => void; const closedPromise = new Promise<void>(r => { closed = r; });
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      await gate; const handle = await open(...args); const close = handle.close.bind(handle);
      handle.close = async () => { await close(); closed(); }; return handle;
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const service = new HostCapacityObservationService({ reportPath: f.file, expectedHost: 'isolated-host', now: () => now, publish }); stops.push(() => service.stop());
    service.start(); service.stop(); resume(); await closedPromise;
    await new Promise(resolve => setImmediate(resolve));
    expect(vi.getTimerCount()).toBe(0); expect(publish).not.toHaveBeenCalled();
  });
});
