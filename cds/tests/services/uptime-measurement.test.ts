import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { probeCustomMonitor } from '../../src/services/uptime-custom-monitor.js';
import { UptimeMonitorService, type UptimeMonitorConfig, type UptimeAlertEventData } from '../../src/services/uptime-monitor.js';
import { applyIncidentTransition, bucketizeSamples, type UptimeIncident, type UptimeMeasurement, type UptimeSample } from '../../src/services/uptime-metrics.js';
import { monitorIncidentPath } from '../../src/services/monitor-incident-link.js';
import { createUptimeRouter } from '../../src/routes/uptime.js';
import { renderNoticeFromEvent } from '../../src/services/notice-ledger.js';
import { resolveApiLabel } from '../../src/server.js';
import type { UptimeCustomMonitor } from '../../src/types.js';

const servers: http.Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()); })));
  dirs.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true }));
});
async function listen(app: http.RequestListener): Promise<string> {
  const s = http.createServer(app); servers.push(s);
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}
const reading = (actual: UptimeMeasurement['actual'], extra: Partial<UptimeMeasurement> = {}): UptimeMeasurement => ({
  name: 'query.p95', field: 'observedValue', actual, expected: '300', op: 'lte', unit: 'ms', ...extra,
});
const sample = (t: number, actual: UptimeMeasurement['actual'], extra: Partial<UptimeSample> = {}): UptimeSample => ({ t, up: true, ms: 4, measurement: reading(actual), ...extra });

describe('real health readings remain separate from transport timing', () => {
  it('captures actual and configured expected on both failure and success, including explicit zero', async () => {
    let actual = 1240;
    const url = await listen((_q, res) => res.end(JSON.stringify({ checks: { query: [{ componentId: 'query.p95', observedValue: actual, observedUnit: 'ms', unit: 'invented-unit' }] } })));
    const config = { kind: 'health-json', url, healthComponentId: 'query.p95', healthField: 'observedValue', healthOp: 'lte', healthValue: '300' } as const;
    const bad = await probeCustomMonitor(config, 2000);
    expect(bad.up).toBe(false); expect(bad.measurement).toEqual(reading(1240));
    actual = 0;
    const good = await probeCustomMonitor(config, 2000);
    expect(good.up).toBe(true); expect(good.measurement).toEqual(reading(0));
    expect(good.ms).toBeGreaterThanOrEqual(0);
  });
  it('does not create a metric or guess a unit when source fields do not exist', async () => {
    const url = await listen((_q, res) => res.end(JSON.stringify({ checks: {} })));
    const result = await probeCustomMonitor({ kind: 'health-json', url, healthComponentId: 'missing', healthField: 'observedValue', healthOp: 'eq', healthValue: '0' }, 2000);
    expect(result.up).toBe(false); expect(result.measurement).toBeUndefined();
    const httpResult = await probeCustomMonitor({ kind: 'http', url }, 2000);
    expect(httpResult.up).toBe(true); expect(httpResult.measurement).toBeUndefined();
  });
  it('keeps boolean readings and masks credential syntax instead of copying arbitrary structures', async () => {
    let value: unknown = false;
    const url = await listen((_q, res) => res.end(JSON.stringify({ checks: { test: { observedValue: value } } })));
    const config = { kind: 'health-json', url, healthComponentId: 'test', healthField: 'observedValue', healthOp: 'eq', healthValue: 'false' } as const;
    expect((await probeCustomMonitor(config, 2000)).measurement?.actual).toBe(false);
    value = 'Authorization: Bearer do-not-copy-this-secret';
    expect(JSON.stringify(await probeCustomMonitor(config, 2000))).not.toContain('do-not-copy-this-secret');
    expect(JSON.stringify(await probeCustomMonitor({ ...config, observeMode: 'passive' }, 2000))).not.toContain('do-not-copy-this-secret');
    value = { password: 'private-body' };
    expect((await probeCustomMonitor(config, 2000)).measurement).toBeUndefined();
  });
});

describe('historical metric means retain their actual meaning', () => {
  it('includes failed readings and excludes no-observation samples, independently of latency averages', () => {
    const buckets = bucketizeSamples([sample(10, 100), sample(20, 900, { up: false, ms: 8 }), sample(30, 5000, { noData: true })], 0, 100, 1);
    expect(buckets[0].measurement).toEqual({ ...reading(500), aggregation: 'average', sampleCount: 2 });
    expect(buckets[0].avgLatencyMs).toBe(4);
    expect(buckets[0].status).toBe('partial');
  });
  it.each([
    { measurement: reading(200, { expected: '500' }) },
    { measurement: reading(200, { unit: 's' }) },
    { measurement: reading('not-a-number') },
    { measurement: undefined },
  ])('leaves a real metric gap for mixed or unavailable contracts: %j', extra => {
    expect(bucketizeSamples([sample(10, 100), sample(20, 200, extra)], 0, 100, 1)[0].measurement).toBeUndefined();
  });
  it('does not turn empty/boolean readings or old samples into numeric zero', () => {
    for (const value of ['', false, null]) expect(bucketizeSamples([sample(10, value)], 0, 100, 1)[0].measurement).toBeUndefined();
    expect(bucketizeSamples([], 0, 100, 1)[0].measurement).toBeUndefined();
  });
});

describe('incident snapshots and scoped notification landing', () => {
  it('copies readings at transitions so later probe mutations cannot rewrite history', () => {
    const records: UptimeIncident[] = []; const failed = sample(1, 1240, { up: false });
    applyIncidentTransition(records, 'to-down', { targetId: 'monitor@a', at: 1, sample: failed });
    failed.measurement!.actual = 9000;
    const good = sample(2, 90); applyIncidentTransition(records, 'to-up', { targetId: 'monitor@a', at: 2, sample: good });
    good.measurement!.actual = 5;
    expect(records[0].startedSample?.measurement?.actual).toBe(1240);
    expect(records[0].endedSample?.measurement?.actual).toBe(90);
  });
  it('persistently records actual trigger-time samples without changing alert suppression and serves the scoped event over HTTP', async () => {
    let value = 1240, now = Date.UTC(2026, 10, 10);
    const url = await listen((_q, res) => res.end(JSON.stringify({ checks: { query: { observedValue: value, observedUnit: 'ms' } } })));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-metric-events-')); dirs.push(dir);
    const mon: UptimeCustomMonitor = { id: 'a/测试::api', name: '真实指标', projectId: 'p-a', kind: 'health-json', url, healthComponentId: 'query', healthField: 'observedValue', healthOp: 'lte', healthValue: '300', enabled: true, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
    const config: UptimeMonitorConfig = { enabled: true, intervalMs: 60_000, timeoutMs: 2000, failureThreshold: 1, recoveryThreshold: 1, maxSamples: 1440, excludePatterns: [], scope: 'all', storePath: path.join(dir, 'history.json') };
    const events: UptimeAlertEventData[] = [];
    const deps = { state: { getAllBranches: () => [], getUptimeMonitors: () => [mon] }, config, now: () => now, onAlert: (_t: unknown, data: UptimeAlertEventData) => events.push(data) };
    const service = new UptimeMonitorService(deps);
    await service.runCycle(); const incident = service.getIncidents()[0];
    expect(events[0].incidentId).toBe(incident.id);
    for (let i = 1; i <= 22; i++) { now += 31 * 60_000; value++; await service.runCycle(); }
    const latest = service.getIncident(incident.id)!;
    // Existing policy suppresses the same ongoing incident rather than resending every cooldown.
    expect(events).toHaveLength(1);
    expect(latest.notificationSamples).toHaveLength(1);
    expect(latest.notificationSamples![0].measurement?.actual).toBe(1240);
    expect(latest.startedSample?.measurement?.actual).toBe(1240);
    await service.markAlarmDelivered(events[0].targetId, 'local-test-channel', events[0].detectedAt);
    value = 90;
    for (let i = 0; i <= 10; i++) { now += 60_000; await service.runCycle(); }
    const recovered = service.getIncident(incident.id)!;
    expect(events).toHaveLength(2);
    expect(recovered.notificationSamples).toHaveLength(2);
    expect(recovered.notificationSamples!.at(-1)?.measurement?.actual).toBe(90);
    expect(recovered.endedSample!.t).toBeLessThan(recovered.notificationSamples!.at(-1)!.t);
    await service.flush();
    const cold = new UptimeMonitorService({ ...deps, onAlert: undefined });
    expect(cold.getIncident(incident.id, 'p-a')?.notificationSamples).toEqual(recovered.notificationSamples);
    expect(cold.getIncident(incident.id, 'p-b')).toBeUndefined();
    const app = express();
    app.use((req, _res, next) => { (req as unknown as { cdsProjectKey?: { projectId: string } }).cdsProjectKey = { projectId: String(req.headers['x-project']) }; next(); });
    app.use('/api', createUptimeRouter({ monitor: cold, store: {} as never }));
    const api = await listen(app);
    const route = `${api}/api/uptime/incidents/${encodeURIComponent(incident.id)}`;
    expect(resolveApiLabel('GET', `/uptime/incidents/${encodeURIComponent(incident.id)}`)).toBe('查看故障通知上下文');
    const allowed = await fetch(route, { headers: { 'x-project': 'p-a' } });
    expect(allowed.status).toBe(200); expect((await allowed.json()).incident.startedSample.measurement.actual).toBe(1240);
    const denied = await fetch(route, { headers: { 'x-project': 'p-b' } });
    const missing = await fetch(`${api}/api/uptime/incidents/missing`, { headers: { 'x-project': 'p-a' } });
    expect(denied.status).toBe(404); expect(await denied.json()).toEqual(await missing.json());
    cold.forgetTarget(events[0].targetId);
    expect((await fetch(route, { headers: { 'x-project': 'p-a' } })).status).toBe(404);
  });
  it('encodes only identity metadata in current and legacy notification links', () => {
    const targetId = 'monitor@a/b::中文'; const incidentId = `inc_${targetId}_123`;
    const detectedAt = '2026-11-10T01:02:03.000Z';
    const href = monitorIncidentPath(targetId, incidentId, detectedAt);
    const url = new URL(href, 'https://example.test');
    expect(Object.fromEntries(url.searchParams)).toEqual({ view: 'home', target: targetId, incident: incidentId, detectedAt });
    const notice = renderNoticeFromEvent({ type: 'uptime.target.down', ts: detectedAt, data: { targetId, incidentId, detectedAt, projectId: 'p-a', targetName: '真实指标', message: '指标超出' } });
    expect(notice?.href).toBe(href);
    expect(monitorIncidentPath(targetId)).toBe(`/status?target=${encodeURIComponent(targetId)}`);
  });
});
