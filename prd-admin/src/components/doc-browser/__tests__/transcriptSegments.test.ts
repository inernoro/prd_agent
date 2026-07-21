import { describe, expect, it } from 'vitest';
import {
  parseTranscriptSegments,
  hasUsableTimestamps,
  activeSegmentIndex,
  extractTranscriptSummary,
  estimateTranscriptSegments,
  parseSummaryModules,
  activeSummaryModuleIndex,
  replaceTranscriptSegmentText,
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
  it('编辑单句时保留时间戳与摘要', () => {
    expect(replaceTranscriptSegmentText(TIMED_NOTE, 1, '用户修订后的第二句。')).toContain(
      '**[00:05 - 00:12]** 用户修订后的第二句。',
    );
    expect(replaceTranscriptSegmentText(TIMED_NOTE, 1, '用户修订后的第二句。')).toContain('本周主要讨论三件事。');
  });

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

describe('extractTranscriptSummary', () => {
  it('只提取整理结果，不混入标题与转录原文', () => {
    expect(extractTranscriptSummary(TIMED_NOTE)).toBe('本周主要讨论三件事。');
  });

  it('没有摘要小节时返回空字符串', () => {
    expect(extractTranscriptSummary('## 转录全文\n\n只有原文。')).toBe('');
  });
});

describe('estimateTranscriptSegments', () => {
  it('按句子文字量分配完整音频时长，并保持连续', () => {
    const estimated = estimateTranscriptSegments(
      [{ start: -1, end: -1, text: '短句。这里是一句更长的话。最后一句。' }],
      30,
    );
    expect(estimated).toHaveLength(3);
    expect(estimated[0].start).toBe(0);
    expect(estimated[1].start).toBe(estimated[0].end);
    expect(estimated[2].end).toBe(30);
    expect(estimated[1].end - estimated[1].start).toBeGreaterThan(estimated[0].end);
  });

  it('时长未知时不生成伪时间轴', () => {
    expect(estimateTranscriptSegments(parseTranscriptSegments(PLAIN_NOTE), 0)).toEqual([]);
  });
});

describe('parseSummaryModules', () => {
  it('按 Markdown 标题和自然段拆分，不绑定具体整理方式', () => {
    const modules = parseSummaryModules('## 结论\n\n已确认上线。\n\n## 待办\n- [ ] 补测试');
    expect(modules).toEqual([
      { title: '结论', markdown: '已确认上线。' },
      { title: '待办', markdown: '- [ ] 补测试' },
    ]);
  });

  it('没有标题时仍可按自然段形成顺序模块', () => {
    expect(parseSummaryModules('一段概述。\n\n- 要点一\n- 要点二')).toHaveLength(2);
  });
});

describe('activeSummaryModuleIndex', () => {
  it('按播放进度映射到对应模块并钳制边界', () => {
    expect(activeSummaryModuleIndex(4, 0, 100)).toBe(0);
    expect(activeSummaryModuleIndex(4, 51, 100)).toBe(2);
    expect(activeSummaryModuleIndex(4, 100, 100)).toBe(3);
  });
});
