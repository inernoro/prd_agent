import { describe, expect, it } from 'vitest';
import { buildMeasurementChart, incidentNotificationSnapshot, measurementView } from '../../web/src/lib/monitorMeasurement';
import type { UptimeIncidentView, UptimeMeasurement, UptimeSample } from '../../web/src/lib/monitorCenter';

const measurement: UptimeMeasurement = { name: '解析耗时', field: 'observedValue', actual: 1240, expected: '300', op: 'lte', unit: 'ms' };
const sample = (t: number, actual: UptimeMeasurement['actual'], extra: Partial<UptimeSample> = {}): UptimeSample => ({ t, up: true, ms: 12, measurement: { ...measurement, actual }, ...extra });
const incident: UptimeIncidentView = {
  id: 'incident-real', targetId: 'monitor@real', targetName: '真实检查', source: 'custom', branchId: '', projectId: 'p',
  startedAt: 1000, endedAt: 5000, durationMs: 4000, cause: '检查未通过', ongoing: false,
  startedSample: sample(1000, 1000, { up: false }), notificationSamples: [sample(2000, 1240, { up: false })], endedSample: sample(5000, 80),
};

describe('监控真实指标与事件快照', () => {
  it('没有结构化读数或本次无观测时不把传输耗时当业务指标', () => {
    expect(measurementView({ t: 1, up: false, ms: 800 })).toBeNull();
    expect(measurementView(sample(1, 100, { noData: true }))).toBeNull();
    expect(measurementView(sample(1, null))?.numeric).toBeUndefined();
    expect(measurementView(sample(1, null))?.actual).toBe('—');
  });

  it('展示同一单位的实际、预期和差距，百分比只用百分点不伪造倍数', () => {
    const view = measurementView(sample(1, 1240));
    expect(view).toMatchObject({ actual: '1,240 ms', expected: '≤ 300 ms', shortGap: '4.1×' });
    expect(view?.gap).toContain('940 ms');
    const percentage = measurementView({ t: 1, up: false, ms: 12, measurement: { ...measurement, actual: 96.8, expected: '99.9', op: 'gte', unit: '%' } });
    expect(percentage).toMatchObject({ expected: '≥ 99.9%', shortGap: '−3.1 点' });
    expect(percentage?.gap).toContain('3.1 个百分点');
  });

  it('零边界和严格不等号不产生 Infinity，也不把等于边界解释成通过', () => {
    const view = measurementView({ t: 1, up: false, ms: 12, measurement: { ...measurement, actual: 0, expected: '0', op: 'lt' } });
    expect(view?.gap).toContain('未满足当前条件');
    expect(Object.values(view?.numeric ?? {}).every(Number.isFinite)).toBe(true);
    expect(view?.shortGap).not.toContain('Infinity');
    const chart = buildMeasurementChart([sample(1, 0, { measurement: { ...measurement, actual: 0, expected: '0', op: 'lt' } })], { ...measurement, actual: 0, expected: '0', op: 'lt' });
    expect(chart?.points).toHaveLength(1);
    expect(chart?.points[0].failed).toBe(true);
  });

  it('词法相等条件保留配置原文，不把001与1转换为相同的数值量表', () => {
    const m: UptimeMeasurement = { name: '标记', field: 'observedValue', actual: '001', expected: '1', op: 'eq' };
    expect(measurementView({ t: 1, up: false, ms: 1, measurement: m })).toMatchObject({ actual: '001', expected: '= 1' });
    expect(measurementView({ t: 1, up: false, ms: 1, measurement: m })?.numeric).toBeUndefined();
    expect(buildMeasurementChart([{ t: 1, measurement: m }], m)).toBeNull();
  });

  it('无读数和更换指标合同的位置断开，曲线失败标记只按指标本身判定', () => {
    const rows = [sample(1, 100), sample(2, 150, { up: false }), sample(3, 999, { noData: true }), sample(4, 500), sample(5, 200, { measurement: { ...measurement, actual: 200, expected: '100' } })];
    const chart = buildMeasurementChart(rows, measurement)!;
    expect(chart.samples).toBe(3);
    expect(chart.paths).toHaveLength(2);
    expect(chart.points.map((point) => point.failed)).toEqual([false, false, true]);
    // The failed singleton after a gap stays a red point; no red line bridges
    // the unobserved interval.
    expect(chart.failingPaths).toHaveLength(0);
    expect(buildMeasurementChart([sample(1, 0, { noData: true })], measurement)).toBeNull();
  });

  it('折线只在真实采样跨过预期边界的部分标红', () => {
    const chart = buildMeasurementChart([sample(1, 100), sample(2, 500), sample(3, 700)], measurement)!;
    expect(chart.failingPaths).toHaveLength(2);
    const crossing = `M120.00 ${chart.thresholdY.toFixed(2)}`;
    expect(chart.failingPaths[0].startsWith(crossing)).toBe(true);
    expect(chart.points.map((point) => point.failed)).toEqual([false, true, true]);
  });

  it('通知只读取目标与时间均匹配的真实快照，URL无法替换读数', () => {
    const at = new Date(2000).toISOString();
    expect(incidentNotificationSnapshot(incident, incident.targetId, at)).toMatchObject({ kind: 'alert', at: 2000, sample: { measurement: { actual: 1240 } } });
    expect(incidentNotificationSnapshot(incident, 'monitor@other', at)).toEqual({ kind: 'unavailable' });
    expect(incidentNotificationSnapshot(incident, incident.targetId, new Date(3000).toISOString())).toEqual({ kind: 'unavailable' });
    expect(incidentNotificationSnapshot(incident, incident.targetId, 'not-a-date')).toEqual({ kind: 'unavailable' });
    expect(incidentNotificationSnapshot(incident, incident.targetId, new Date(5000).toISOString())).toMatchObject({ kind: 'recovery', sample: { up: true, measurement: { actual: 80 } } });
  });

  it('没有持久化快照的旧事件不由开始结束时间补造历史值', () => {
    const old = { ...incident, startedSample: undefined, endedSample: undefined, notificationSamples: undefined };
    expect(incidentNotificationSnapshot(old, old.targetId)).toEqual({ kind: 'unavailable' });
    expect(incidentNotificationSnapshot(old, old.targetId, new Date(5000).toISOString())).toEqual({ kind: 'unavailable' });
  });
});
