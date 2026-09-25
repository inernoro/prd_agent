import { describe, expect, it } from 'vitest';
import type { DesignTimingGroup, DesignTimingStats } from '@/services/real/webPages';
import {
  formatEtaDuration,
  generationEtaSentence,
  generationEtaShort,
  pickGenerationTiming,
  remainingEstimateText,
} from './siteGenerateProgress';

const group = (overrides: Partial<DesignTimingGroup> & { runtime: string }): DesignTimingGroup => ({
  artifactType: 'web-page',
  succeededCount: 0,
  failedCount: 0,
  cancelledCount: 0,
  generation: { sampleCount: 0, p50Seconds: null, p95Seconds: null, estimateReady: false },
  materialToShareLink: { sampleCount: 0, p50Seconds: null, p95Seconds: null, estimateReady: false },
  materialToShareLinkEligibleRuns: 0,
  ...overrides,
});

const stats = (groups: DesignTimingGroup[]): DesignTimingStats => ({
  windowDays: 30,
  since: '2026-08-26T00:00:00Z',
  generatedAt: '2026-09-25T00:00:00Z',
  percentileMethod: 'nearest-rank',
  estimateMinSamples: 5,
  runSampleCap: 2000,
  runSamplesTruncated: false,
  shareSamplesTruncated: false,
  groups,
});

const ready = stats([
  group({
    runtime: 'open-design',
    succeededCount: 12,
    generation: { sampleCount: 12, p50Seconds: 600, p95Seconds: 840, estimateReady: true },
  }),
  group({
    runtime: 'map-gateway',
    succeededCount: 3,
    generation: { sampleCount: 3, p50Seconds: 50, p95Seconds: 70, estimateReady: false },
  }),
  group({
    runtime: 'open-design',
    artifactType: 'html-ppt',
    generation: { sampleCount: 9, p50Seconds: 100, p95Seconds: 200, estimateReady: true },
  }),
]);

describe('网页生成预估：真实 P50/P95 优先，样本不足老实说是经验值', () => {
  it('只在后端判定样本够时才取真实数据，且按执行器 + 产物类型匹配', () => {
    expect(pickGenerationTiming(ready, 'open-design')).toEqual({ sampleCount: 12, p50Seconds: 600, p95Seconds: 840 });
    // 3 个样本不够：不拿来冒充规律
    expect(pickGenerationTiming(ready, 'map-gateway')).toBeNull();
    expect(pickGenerationTiming(ready, 'open-design', 'html-ppt')).toEqual({ sampleCount: 9, p50Seconds: 100, p95Seconds: 200 });
    expect(pickGenerationTiming(null, 'open-design')).toBeNull();
    expect(pickGenerationTiming(ready, null)).toBeNull();
    expect(pickGenerationTiming(ready, 'unknown')).toBeNull();
  });

  it('发送前那句话：真实数据写明「最近 N 次中位数」，经验值写明「数据还在积累」', () => {
    const timing = pickGenerationTiming(ready, 'open-design');
    expect(generationEtaSentence('open-design', timing)).toBe('预计约 10 分钟（最近 12 次中位数，慢的时候约 14 分钟）');
    expect(generationEtaShort('open-design', timing)).toBe('约 10 分钟');
    expect(generationEtaSentence('map-gateway', null)).toBe('按经验值约 1–2 分钟，真实耗时数据还在积累');
    expect(generationEtaShort('map-gateway', null)).toBe('约 1–2 分钟');
    // 既没有数据也没有经验值：不编
    expect(generationEtaSentence('unknown', null)).toBe('');
    expect(generationEtaShort('unknown', null)).toBe('');
  });

  it('生成中剩余时间随用时推进：中位数之前、中位数与慢档之间、超过慢档', () => {
    const timing = pickGenerationTiming(ready, 'open-design');
    expect(remainingEstimateText('open-design', 4 * 60, timing))
      .toBe('预计还需约 6 分钟（最近 12 次中位数约 10 分钟，慢的时候约 14 分钟）');
    expect(remainingEstimateText('open-design', 12 * 60, timing))
      .toBe('已超过最近 12 次的中位数（约 10 分钟），慢的时候约 14 分钟，最多还需约 2 分钟');
    expect(remainingEstimateText('open-design', 15 * 60, timing))
      .toBe('已超过最近 12 次里慢的那档（约 14 分钟），任务仍在继续');
    // 没有真实数据时仍走经验值，并且说清楚是经验值
    expect(remainingEstimateText('open-design', 5 * 60, null)).toContain('按经验值估算（耗时数据还在积累）');
  });

  it('不足一分钟按秒说，不写「0 分钟」', () => {
    expect(formatEtaDuration(0)).toBe('1 秒');
    expect(formatEtaDuration(45)).toBe('45 秒');
    expect(formatEtaDuration(89)).toBe('1 分钟');
    expect(formatEtaDuration(600)).toBe('10 分钟');
  });
});
