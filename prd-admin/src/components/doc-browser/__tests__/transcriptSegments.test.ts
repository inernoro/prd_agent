import { describe, expect, it } from 'vitest';
import {
  parseTranscriptSegments,
  hasUsableTimestamps,
  activeSegmentIndex,
} from '../transcriptSegments';

/**
 * 歌词滚轮跟读播放器的数据层单测。
 * 数据源契约：后端 SubtitleFormatter.FormatSegmentsBody 的 **[mm:ss - mm:ss]** 行
 * （小时级为 hh:mm:ss）；chat-audio 转写无时间戳时为纯段落。
 */

const TIMED_NOTE = `# 周会录音 · 转录笔记
> 来源：周会录音.m4a · 生成时间：2026-07-13 10:00

## 摘要

本周主要讨论三件事。

## 转录全文

**[00:00 - 00:05]** 大家好，开始今天的周会。

**[00:05 - 00:12]** 第一件事是发布计划。

**[01:02 - 01:30]** 最后同步一下人员安排。
`;

const PLAIN_NOTE = `# 独白 · 转录笔记

## 摘要

一句话。

## 转录全文

好的，我们开始。

这是没有时间戳的第二段。
`;

describe('parseTranscriptSegments', () => {
  it('解析带时间戳行：秒数与文本正确，摘要区不混入', () => {
    const segs = parseTranscriptSegments(TIMED_NOTE);
    expect(segs).toHaveLength(3);
    expect(segs[0]).toEqual({ start: 0, end: 5, text: '大家好，开始今天的周会。' });
    expect(segs[1].start).toBe(5);
    expect(segs[2]).toEqual({ start: 62, end: 90, text: '最后同步一下人员安排。' });
    expect(segs.some(s => s.text.includes('三件事'))).toBe(false);
  });

  it('hh:mm:ss 小时级时间戳可解析', () => {
    const segs = parseTranscriptSegments('## 转录全文\n\n**[01:00:03 - 01:00:10]** 一小时后的话。');
    expect(segs[0].start).toBe(3603);
    expect(segs[0].end).toBe(3610);
  });

  it('无时间戳纯段落：退化为 start=-1 的静态行，跳过标题/引用/斜体占位', () => {
    const segs = parseTranscriptSegments(PLAIN_NOTE);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual({ start: -1, end: -1, text: '好的，我们开始。' });
  });

  it('空文本返回空数组', () => {
    expect(parseTranscriptSegments('')).toEqual([]);
  });
});

describe('hasUsableTimestamps', () => {
  it('带时间戳且时间在涨 → 可同步', () => {
    expect(hasUsableTimestamps(parseTranscriptSegments(TIMED_NOTE))).toBe(true);
  });
  it('纯段落 → 不可同步', () => {
    expect(hasUsableTimestamps(parseTranscriptSegments(PLAIN_NOTE))).toBe(false);
  });
  it('只有一句 → 不可同步（没有跟随意义）', () => {
    expect(hasUsableTimestamps([{ start: 0, end: 3, text: '一句' }])).toBe(false);
  });
});

describe('activeSegmentIndex', () => {
  const segs = parseTranscriptSegments(TIMED_NOTE);
  it('播放位置落在句内 → 对应句', () => {
    expect(activeSegmentIndex(segs, 0)).toBe(0);
    expect(activeSegmentIndex(segs, 6)).toBe(1);
    expect(activeSegmentIndex(segs, 70)).toBe(2);
  });
  it('句间空隙 → 停留在上一句（不跳空）', () => {
    expect(activeSegmentIndex(segs, 30)).toBe(1);
  });
  it('超过末句 → 末句', () => {
    expect(activeSegmentIndex(segs, 999)).toBe(2);
  });
});
