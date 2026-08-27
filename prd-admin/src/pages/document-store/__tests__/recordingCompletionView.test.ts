import { describe, expect, it } from 'vitest';
import {
  describeCompletionSummary,
  describeMicHealth,
  describeOrganizeProgress,
  isAiUnavailableFailure,
} from '../recordingCompletionView';

describe('describeCompletionSummary', () => {
  it('句数 + 说话人 + 产出三段', () => {
    expect(describeCompletionSummary({ sentences: 132, speakers: 3, hasSummary: true, hasTodos: true }))
      .toEqual({ title: '全部完成', detail: '132 句 · 3 位说话人 · 纪要与待办已就绪' });
  });

  it('没区分出说话人时不提这一段（那是另一张卡的事）', () => {
    expect(describeCompletionSummary({ sentences: 18, speakers: 0, hasSummary: false, hasTodos: false }))
      .toEqual({ title: '原文已完成', detail: '18 句' });
  });

  it('只有纪要或只有待办时如实说哪一样', () => {
    expect(describeCompletionSummary({ sentences: 9, speakers: 2, hasSummary: true, hasTodos: false })?.detail)
      .toBe('9 句 · 2 位说话人 · 纪要已就绪');
    expect(describeCompletionSummary({ sentences: 9, speakers: 2, hasSummary: false, hasTodos: true })?.detail)
      .toBe('9 句 · 2 位说话人 · 待办已就绪');
  });

  it('一句都没有就不出这张卡', () => {
    expect(describeCompletionSummary({ sentences: 0, speakers: 0, hasSummary: true, hasTodos: true })).toBeNull();
  });
});

describe('describeOrganizeProgress', () => {
  it('点名到具体那一种产物，并给出「不用在这等」的出口', () => {
    expect(describeOrganizeProgress({ styleLabel: '会议纪要', remainingSec: 20 }))
      .toEqual({ title: '正在生成会议纪要', detail: '约 20s · 可以先去播放和阅读' });
  });

  it('给不出 ETA 就不编一个', () => {
    expect(describeOrganizeProgress({ styleLabel: '会议纪要', remainingSec: null }).detail)
      .toBe('可以先去播放和阅读');
  });

  it('连整理方式都不知道时退到通用说法', () => {
    expect(describeOrganizeProgress({}).title).toBe('正在整理这段录音');
  });
});

describe('isAiUnavailableFailure', () => {
  it('只认后端明确给的那几个码', () => {
    expect(isAiUnavailableFailure('LLM_UNAVAILABLE')).toBe(true);
    expect(isAiUnavailableFailure('gateway_unavailable')).toBe(true);
    expect(isAiUnavailableFailure('ERR_CODEC')).toBe(false);
    expect(isAiUnavailableFailure(null)).toBe(false);
  });
});

describe('describeMicHealth', () => {
  it('三档音量各有各的话，不一律说「正常」', () => {
    expect(describeMicHealth(0.5, 10)).toBe('麦克风正常 · 音量适中');
    expect(describeMicHealth(0.05, 10)).toBe('麦克风正常 · 音量偏低');
    expect(describeMicHealth(0.99, 10)).toBe('麦克风正常 · 音量偏高，可能削波');
    expect(describeMicHealth(0.001, 10)).toBe('几乎没有收到声音 · 检查麦克风是否静音');
  });

  it('刚开录还没听够两秒就不下结论', () => {
    expect(describeMicHealth(0, 1)).toBe('正在检测麦克风');
  });
});
