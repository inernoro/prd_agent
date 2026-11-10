import type { UptimeIncidentView, UptimeSample } from './monitorCenter';

export type MonitorMeasurement = NonNullable<UptimeSample['measurement']>;
const OPERATORS: Record<MonitorMeasurement['op'], string> = { eq: '=', ne: '≠', lt: '<', lte: '≤', gt: '>', gte: '≥' };

export interface MeasurementView {
  name: string;
  actual: string;
  expected: string;
  gap: string;
  shortGap: string;
  numeric?: { actual: number; expected: number; actualPercent: number; expectedPercent: number };
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim() || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatMeasurementValue(value: string | number | boolean | null, unit = ''): string {
  if (value === null) return '—';
  // Match the supplied artwork's percentage precision without clipping genuine
  // readings outside 0–100. Lexical health conditions keep their original text.
  if (unit === '%' && typeof value === 'number' && Number.isFinite(value)) {
    const digits = value >= 99 && value < 100 ? 2 : value === 100 ? 0 : 1;
    return `${new Intl.NumberFormat('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)}%`;
  }
  const body = typeof value === 'number'
    ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(value)
    : String(value);
  return unit === '%' ? `${body}%` : `${body}${unit ? ` ${unit}` : ''}`;
}

export function measurementView(sample?: UptimeSample | null): MeasurementView | null {
  const measurement = sample?.measurement;
  if (!measurement || sample?.noData) return null;
  const { actual, expected, unit, op } = measurement;
  const format = (value: typeof actual): string => formatMeasurementValue(unit === '%' && op !== 'eq' && op !== 'ne' ? numeric(value) ?? value : value, unit);
  const view: MeasurementView = {
    name: measurement.name,
    actual: format(actual),
    expected: `${OPERATORS[op]} ${format(expected)}`,
    gap: actual === null ? '本次未取得有效指标读数' : '按配置条件判定',
    shortGap: '',
  };
  // Equality on health strings is lexical ("001" differs from "1"). Do not
  // turn those checks into a numeric gauge or rewrite their configured value.
  if (op === 'eq' || op === 'ne') return view;
  const a = numeric(actual), e = numeric(expected);
  if (a === null || e === null) return view;
  const percentageFloor = unit === '%' && (op === 'gt' || op === 'gte') && a >= 0 && a <= 100 && e >= 0 && e <= 100;
  // Lower-bound percentages use the reference's local scale near 100%, so a
  // small shortfall remains visible. Other contracts retain their real scale.
  const minimum = Math.min(a, e);
  const low = percentageFloor && minimum < 100 ? Math.max(0, minimum - (100 - minimum) * 1.2) : Math.min(0, a, e);
  const high = percentageFloor ? 100 : Math.max(1, a, e) * 1.25;
  const span = high - low;
  view.numeric = { actual: a, expected: e, actualPercent: Math.max(percentageFloor ? 2 : 0, (a - low) / span * 100), expectedPercent: (e - low) / span * 100 };
  const delta = a - e;
  const higherFails = op === 'lt' || op === 'lte';
  const lowerFails = op === 'gt' || op === 'gte';
  if (delta === 0) {
    view.gap = op === 'lt' || op === 'gt' ? '实际值与预期边界相等，未满足当前条件' : '实际值与预期边界相等';
    return view;
  }
  if (unit === '%') {
    view.gap = `${delta > 0 ? '高于' : '低于'}预期${formatMeasurementValue(Math.abs(delta))} 个百分点`;
    if ((higherFails && delta > 0) || (lowerFails && delta < 0)) view.shortGap = `${delta > 0 ? '+' : '−'}${formatMeasurementValue(Math.abs(delta))} 点`;
    return view;
  }
  const difference = formatMeasurementValue(Math.abs(delta), unit);
  view.gap = `${delta > 0 ? '高于' : '低于'}预期${difference}`;
  if (higherFails && delta > 0 && e > 0 && a / e >= 1.5) {
    view.shortGap = `${(a / e).toFixed(1)}×`;
    view.gap = `实际为预期上限的 ${(a / e).toFixed(1)} 倍（高 ${difference}）`;
  } else if ((higherFails && delta > 0) || (lowerFails && delta < 0)) {
    view.shortGap = `${delta > 0 ? '+' : '−'}${difference}`;
  }
  return view;
}

export interface MeasurementChart {
  paths: string[];
  failingPaths: string[];
  points: Array<{ x: number; y: number; failed: boolean }>;
  thresholdY: number;
  from: number;
  to: number;
  samples: number;
}

export interface MeasurementChartWindow { from: number; to: number }

/** 仅绘制同一指标；显式时间窗口保留未覆盖区域，缺失读数或合同变化处断开。 */
export function buildMeasurementChart(samples: readonly Pick<UptimeSample, 't' | 'measurement' | 'noData'>[], measurement: MonitorMeasurement, window?: MeasurementChartWindow, width = 480, height = 100): MeasurementChart | null {
  if (measurement.op === 'eq' || measurement.op === 'ne') return null;
  const threshold = numeric(measurement.expected);
  if (threshold === null) return null;
  if (window && (!Number.isFinite(window.from) || !Number.isFinite(window.to) || window.to <= window.from)) return null;
  const ordered = samples.filter((sample) => Number.isFinite(sample.t) && (!window || sample.t >= window.from && sample.t <= window.to)).sort((a, b) => a.t - b.t);
  const rows = ordered.map((sample) => {
    const value = sample.measurement;
    const same = value && value.name === measurement.name && value.field === measurement.field
      && value.op === measurement.op && value.expected === measurement.expected && value.unit === measurement.unit;
    const actual = !sample.noData && same ? numeric(value.actual) : null;
    const failed = actual !== null && (measurement.op === 'lt' ? actual >= threshold : measurement.op === 'lte' ? actual > threshold : measurement.op === 'gt' ? actual <= threshold : actual < threshold);
    return { at: sample.t, value: actual, failed };
  });
  const valid = rows.filter((row): row is typeof row & { value: number } => row.value !== null);
  if (!valid.length) return null;
  const from = window?.from ?? rows[0].at, to = window?.to ?? rows[rows.length - 1].at;
  const low = Math.min(0, threshold, ...valid.map((row) => row.value));
  const high = Math.max(1, threshold, ...valid.map((row) => row.value)) * 1.1;
  const y = (value: number) => height - 8 - (value - low) / (high - low) * (height - 16);
  const paths: string[] = [], failingPaths: string[] = [];
  const plotted: MeasurementChart['points'] = [];
  let previous: { x: number; y: number; value: number; failed: boolean } | undefined;
  for (const row of rows) {
    if (row.value === null) { previous = undefined; continue; }
    const x = to === from ? width / 2 : (row.at - from) / (to - from) * width;
    const pointY = y(row.value);
    const point = `${x.toFixed(2)} ${pointY.toFixed(2)}`;
    plotted.push({ x, y: pointY, failed: row.failed });
    if (previous) paths[paths.length - 1] += ` L${point}`;
    else paths.push(`M${point}`);
    if (previous && (previous.failed || row.failed)) {
      if (previous.failed && row.failed) failingPaths.push(`M${previous.x.toFixed(2)} ${previous.y.toFixed(2)} L${point}`);
      else {
        const fraction = (threshold - previous.value) / (row.value - previous.value);
        const cross = `${(previous.x + (x - previous.x) * fraction).toFixed(2)} ${y(threshold).toFixed(2)}`;
        failingPaths.push(previous.failed ? `M${previous.x.toFixed(2)} ${previous.y.toFixed(2)} L${cross}` : `M${cross} L${point}`);
      }
    }
    previous = { x, y: pointY, value: row.value, failed: row.failed };
  }
  return { paths, failingPaths, points: plotted, thresholdY: y(threshold), from, to, samples: valid.length };
}

export interface IncidentNotificationSnapshot {
  sample?: UptimeSample;
  at?: number;
  kind: 'alert' | 'recovery' | 'unavailable';
}

/** URLs identify snapshots; they cannot provide or overwrite their content. */
export function incidentNotificationSnapshot(incident: UptimeIncidentView | undefined, targetId: string, detectedAt?: string): IncidentNotificationSnapshot {
  if (!incident || incident.targetId !== targetId) return { kind: 'unavailable' };
  if (!detectedAt) return incident.startedSample
    ? { sample: incident.startedSample, at: incident.startedSample.t, kind: 'alert' }
    : { kind: 'unavailable' };
  const at = Date.parse(detectedAt);
  if (!Number.isFinite(at)) return { kind: 'unavailable' };
  if (incident.endedSample?.t === at) return { sample: incident.endedSample, at, kind: incident.endedSample.up && !incident.endedSample.noData ? 'recovery' : 'alert' };
  const notification = incident.notificationSamples?.find((sample) => sample.t === at);
  if (notification) return { sample: notification, at, kind: notification.up && !notification.noData ? 'recovery' : 'alert' };
  if (incident.startedSample?.t === at) return { sample: incident.startedSample, at, kind: 'alert' };
  return { kind: 'unavailable' };
}
