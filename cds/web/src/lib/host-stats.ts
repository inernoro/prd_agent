export interface NormalizedHostStats {
  mem: {
    totalMB: number;
    freeMB: number;
    usedPercent: number;
  };
  cpu: {
    cores: number;
    loadAvg1: number;
    loadAvg5: number;
    loadAvg15: number;
    loadPercent: number;
  };
  uptimeSeconds: number;
  timestamp: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function numberField(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function sourceRecord(input: unknown): Record<string, unknown> | null {
  if (!isRecord(input)) return null;
  if (isRecord(input.mem) || isRecord(input.cpu)) return input;
  return isRecord(input.data) ? input.data : null;
}

export function normalizeHostStats(input: unknown): NormalizedHostStats | null {
  const source = sourceRecord(input);
  if (!source || !isRecord(source.mem) || !isRecord(source.cpu)) return null;

  return {
    mem: {
      totalMB: numberField(source.mem.totalMB),
      freeMB: numberField(source.mem.freeMB),
      usedPercent: numberField(source.mem.usedPercent),
    },
    cpu: {
      cores: numberField(source.cpu.cores, 1),
      loadAvg1: numberField(source.cpu.loadAvg1),
      loadAvg5: numberField(source.cpu.loadAvg5),
      loadAvg15: numberField(source.cpu.loadAvg15),
      loadPercent: numberField(source.cpu.loadPercent),
    },
    uptimeSeconds: numberField(source.uptimeSeconds),
    timestamp: typeof source.timestamp === 'string' ? source.timestamp : new Date().toISOString(),
  };
}
