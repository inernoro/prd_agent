import type {
  ExecutiveAgentStat,
  ExecutiveModelStat,
} from '@/services/contracts/executive';

export const duration = (value: number) =>
  value > 0 ? `${(value / 1000).toFixed(2)} 秒` : '未记录';
export const dateTime = (value?: string | null) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString('zh-CN')
    : '未记录';
export const money = (value: number) =>
  `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
export const sumOf = <T>(items: T[] | undefined, read: (item: T) => number) =>
  items?.reduce((sum, item) => sum + read(item), 0);
export const ratio = (part: number, whole: number) =>
  whole > 0 ? part / whole : undefined;
export const percent = (part: number, whole: number) =>
  whole > 0
    ? part > 0 && part / whole < 0.001
      ? '<0.1%'
      : `${((part / whole) * 100).toFixed(1)}%`
    : '—';

export function agentPlot(agents: ExecutiveAgentStat[]) {
  const recorded = agents.filter(
    (agent) => agent.llmCalls > 0 && agent.avgDurationMs > 0,
  );
  const niceMax = (value: number) => {
    if (value <= 0) return 1;
    const scale = 10 ** Math.floor(Math.log10(value));
    return (
      ([1, 2, 4, 5, 8, 10].find((step) => step >= value / scale) ?? 10) * scale
    );
  };
  const maxX = niceMax(
    Math.max(0, ...recorded.map((a) => a.avgDurationMs / 1000)) * 1.1,
  );
  const maxY = niceMax(Math.max(0, ...recorded.map((a) => a.llmCalls)) * 1.1);
  const maxTokens = Math.max(1, ...recorded.map((a) => a.tokens));
  return {
    maxX,
    maxY,
    omitted: agents.length - recorded.length,
    points: recorded.map((agent) => ({
      agent,
      x: (agent.avgDurationMs / 1000 / maxX) * 100,
      y: (agent.llmCalls / maxY) * 100,
      size: Math.max(12, 44 * Math.sqrt(agent.tokens / maxTokens)),
    })),
  };
}

export function priceCoverage(models: ExecutiveModelStat[]) {
  const priced = models.filter((model) => model.hasPricing);
  const missing = models.filter((model) => !model.hasPricing);
  const calls = sumOf(models, (m) => m.calls)!;
  const pricedCalls = sumOf(priced, (m) => m.calls)!;
  return {
    priced,
    missing,
    calls,
    pricedCalls,
    missingCalls: calls - pricedCalls,
    cost: priced.length ? sumOf(priced, (m) => m.totalCost) : undefined,
    coverage: ratio(pricedCalls, calls),
    tokens: sumOf(models, (m) => m.totalTokens)!,
  };
}

export const taskStatus = (value: string) =>
  ({
    pending: '待处理',
    processing: '处理中',
    failed: '失败',
    completed: '已完成',
    cancelled: '已取消',
  })[value.toLowerCase()] ?? value;
export function taskLane(
  value: string,
): 'pending' | 'processing' | 'failed' | 'ended' | 'other' {
  switch (value.toLowerCase()) {
    case 'pending':
      return 'pending';
    case 'processing':
      return 'processing';
    case 'failed':
      return 'failed';
    case 'completed':
    case 'cancelled':
      return 'ended';
    default:
      return 'other';
  }
}
