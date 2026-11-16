import { expect, it } from 'vitest';
import type {
  ExecutiveAgentStat,
  ExecutiveModelStat,
} from '@/services/contracts/executive';
import { agentPlot, priceCoverage, percent } from './executiveOperationsModel';

it('模型响应缺失不绘成零，短窗口小样本仍能比较', () => {
  const agent = (
    key: string,
    calls: number,
    ms: number,
  ): ExecutiveAgentStat => ({
    appKey: key,
    name: key,
    llmCalls: calls,
    calls,
    apiCalls: 0,
    tokens: 100,
    users: 1,
    avgDurationMs: ms,
  });
  const source = [
    agent('zero-response', 4, 0),
    agent('api-only', 0, 20),
    agent('short', 1, 300),
  ];
  const plot = agentPlot(source);
  expect(plot.omitted).toBe(2);
  expect(plot.points.map((p) => p.agent.appKey)).toEqual(['short']);
  expect(plot.points[0].x).toBeGreaterThan(0);
  expect(plot.points[0].x).toBeLessThan(100);
  expect(plot.points[0].y).toBeGreaterThan(10);
  expect(source[0].appKey).toBe('zero-response');
});
it('费用只汇总已配置价格，零价可估算，覆盖率以调用次数为权重', () => {
  const base = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    avgDurationMs: 0,
    imageCount: 0,
    tokenCost: 0,
    callCost: 0,
  };
  const data: ExecutiveModelStat[] = [
    {
      ...base,
      model: 'unknown',
      calls: 100,
      hasPricing: false,
      totalCost: 999,
    },
    { ...base, model: 'zero', calls: 10, hasPricing: true, totalCost: 0 },
    { ...base, model: 'priced', calls: 10, hasPricing: true, totalCost: 1.25 },
  ];
  const result = priceCoverage(data);
  expect(result.cost).toBe(1.25);
  expect(result.coverage).toBeCloseTo(20 / 120);
  expect(result.missingCalls).toBe(100);
  expect(priceCoverage([data[0]]).cost).toBeUndefined();
  expect(priceCoverage([]).coverage).toBeUndefined();
});
it('真实零和很小的非零占比分开，零分母不显示伪造百分比', () => {
  expect(percent(0, 100)).toBe('0.0%');
  expect(percent(1, 10000)).toBe('<0.1%');
  expect(percent(0, 0)).toBe('—');
});
