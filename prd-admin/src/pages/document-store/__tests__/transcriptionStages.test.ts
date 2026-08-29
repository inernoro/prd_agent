import { describe, it, expect } from 'vitest';
import {
  describeTranscriptionStages,
  estimateRemainingSeconds,
  formatDurationSec,
} from '../transcriptionStages';

/**
 * 用的是后端 SubtitleGenerationProcessor.UpdateProgressAsync 真实写入的刻度，
 * 不是我自己编的分档——判据要对着真正生效的值测（predicate-and-wiring-discipline 形状 6）。
 */
describe('describeTranscriptionStages', () => {
  it('终局与空 run 不产出阶段条（它们各有归宿，再画进度条就是误报）', () => {
    for (const status of ['done', 'failed', 'cancelled']) {
      expect(describeTranscriptionStages({ status, progress: 50 })).toBeNull();
    }
    expect(describeTranscriptionStages(null)).toBeNull();
    expect(describeTranscriptionStages(undefined)).toBeNull();
  });

  it('音频阶段恒为已完成——音频在 run 开始前就落库了', () => {
    for (const progress of [0, 20, 70, 99]) {
      const stages = describeTranscriptionStages({ status: 'running', progress })!;
      expect(stages[0].key).toBe('audio');
      expect(stages[0].state).toBe('done');
    }
  });

  it('排队中（progress 0）：生成原文在跑，理解还在排队', () => {
    const s = describeTranscriptionStages({ status: 'queued', progress: 0, phase: '排队中' })!;
    expect(s.map(x => x.state)).toEqual(['done', 'active', 'pending']);
    expect(s[1].percent).toBe(0);
    expect(s[2].percent).toBeNull();
  });

  it('阶段内百分比按本阶段区间归一，不是把整体进度照搬', () => {
    // 后端 35 = 「解析音频」，整体 35% 但「生成原文」这一格只走了 35/70 = 50%
    const s = describeTranscriptionStages({ status: 'running', progress: 35, phase: '解析音频' })!;
    expect(s[1].state).toBe('active');
    expect(s[1].percent).toBe(50);
    expect(s[1].detail).toBe('解析音频');
  });

  it('到 70（生成摘要）时原文已完成，进入补齐理解', () => {
    const s = describeTranscriptionStages({ status: 'running', progress: 70, phase: '生成摘要' })!;
    expect(s.map(x => x.state)).toEqual(['done', 'done', 'active']);
    expect(s[2].percent).toBe(0);
    expect(s[2].detail).toBe('生成摘要');
  });

  it('90（写入中）时补齐理解走到三分之二', () => {
    const s = describeTranscriptionStages({ status: 'running', progress: 90, phase: '写入中' })!;
    expect(s[2].state).toBe('active');
    expect(s[2].percent).toBe(67);
  });

  it('phase 文案缺失时给兜底话术，不出现空白格', () => {
    const s = describeTranscriptionStages({ status: 'running', progress: 20 })!;
    expect(s[1].detail).toBe('正在转写');
    expect(s[2].detail).toContain('排队中');
  });

  it('越界 progress 被夹住，不产出负数或超过 100 的格子', () => {
    const low = describeTranscriptionStages({ status: 'running', progress: -50 })!;
    expect(low[1].percent).toBe(0);
    const high = describeTranscriptionStages({ status: 'running', progress: 999 })!;
    expect(high[2].percent).toBe(100);
  });
});

describe('estimateRemainingSeconds', () => {
  const started = '2026-08-25T10:00:00Z';
  const at = (sec: number) => new Date('2026-08-25T10:00:00Z').getTime() + sec * 1000;

  it('按这一次运行自己的速度外推：跑了 30s 到 25%，还需约 90s', () => {
    const r = estimateRemainingSeconds({ progress: 25, startedAt: started }, at(30));
    expect(r).toEqual({ elapsedSec: 30, remainingSec: 90 });
  });

  it('没有开始时间就说不出来，返回 null 让界面如实说「正在积累数据」', () => {
    expect(estimateRemainingSeconds({ progress: 50 }, at(30))).toBeNull();
    expect(estimateRemainingSeconds({ progress: 50, startedAt: '不是时间' }, at(30))).toBeNull();
  });

  it('进度为 0 或刚起步的几秒不给数字——外推出来的值没有意义', () => {
    expect(estimateRemainingSeconds({ progress: 0, startedAt: started }, at(30))?.remainingSec).toBeNull();
    expect(estimateRemainingSeconds({ progress: 40, startedAt: started }, at(2))?.remainingSec).toBeNull();
  });

  it('startedAt 缺失时退到 createdAt', () => {
    expect(estimateRemainingSeconds({ progress: 50, createdAt: started }, at(10))).toEqual({
      elapsedSec: 10, remainingSec: 10,
    });
  });

  it('时钟倒挂（已用为负）不产出负进度', () => {
    expect(estimateRemainingSeconds({ progress: 50, startedAt: started }, at(-60))).toBeNull();
  });
});

describe('formatDurationSec', () => {
  it('不足一分钟给秒，避免出现「0 分钟」这种噪音', () => {
    expect(formatDurationSec(0)).toBe('0 秒');
    expect(formatDurationSec(59)).toBe('59 秒');
  });

  it('整分钟不拖一个 0 秒尾巴', () => {
    expect(formatDurationSec(120)).toBe('2 分钟');
  });

  it('带零头时分秒都给', () => {
    expect(formatDurationSec(95)).toBe('1 分 35 秒');
  });
});
