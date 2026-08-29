import { describe, expect, it } from 'vitest';
import { describeAudioStageElapsed, describeTranscriptYield } from '../transcriptionStages';

describe('describeAudioStageElapsed', () => {
  it('给出「耗时 1.2s」这一档', () => {
    expect(describeAudioStageElapsed({
      createdAt: '2026-08-26T10:00:00.000Z',
      startedAt: '2026-08-26T10:00:01.200Z',
    })).toBe('耗时 1.2s');
  });

  it('超过十秒改说人话，不给一串小数', () => {
    expect(describeAudioStageElapsed({
      createdAt: '2026-08-26T10:00:00.000Z',
      startedAt: '2026-08-26T10:01:05.000Z',
    })).toBe('耗时 1 分 5 秒');
  });

  it('缺任一端就不说——不编一个 1.2s 出来', () => {
    expect(describeAudioStageElapsed({ createdAt: '2026-08-26T10:00:00.000Z' })).toBeNull();
    expect(describeAudioStageElapsed(null)).toBeNull();
  });

  it('时钟异常（负数或荒唐大）一律不说', () => {
    expect(describeAudioStageElapsed({
      createdAt: '2026-08-26T10:00:05.000Z',
      startedAt: '2026-08-26T10:00:00.000Z',
    })).toBeNull();
  });
});

describe('describeTranscriptYield', () => {
  it('分母按这一次运行自己的速度外推', () => {
    expect(describeTranscriptYield(84, 64)).toBe('已生成 84 / 约 131 句，其余会陆续出现');
  });

  it('进度太小时只说已生成多少，不给假总数', () => {
    expect(describeTranscriptYield(1, 1)).toBe('已生成 1 句');
    expect(describeTranscriptYield(3, null)).toBe('已生成 3 句');
  });

  it('一句都还没有就什么都不说', () => {
    expect(describeTranscriptYield(0, 50)).toBeNull();
  });

  it('外推出的总数不小于已生成数', () => {
    expect(describeTranscriptYield(10, 100)).toBe('已生成 10 句');
  });
});
