import { describe, expect, it } from 'vitest';
import {
  parseTranscriptSegments,
  hasUsableTimestamps,
  activeSegmentIndex,
  extractTranscriptSummary,
  estimateTranscriptSegments,
  replaceEstimatedTranscriptSentenceText,
  parseSummaryModules,
  activeSummaryModuleIndex,
  replaceTranscriptSegmentText,
  renameTranscriptSpeaker,
  buildTranscriptWordCloud,
  parseRecordingAnswerParts,
  parseSpeakerSourceNote,
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
  it('保留说话人并支持批量改名', () => {
    const note = '## 转录全文\n\n**[00:00 - 00:03]** [说话人1] 第一段。\n\n**[00:03 - 00:06]** [说话人2] 第二段。';
    expect(parseTranscriptSegments(note)[0]).toEqual({ start: 0, end: 3, speaker: '说话人1', text: '第一段。' });
    const renamed = renameTranscriptSpeaker(note, '说话人1', '小公爷');
    expect(renamed).toContain('**[00:00 - 00:03]** [小公爷] 第一段。');
    expect(renamed).toContain('[说话人2] 第二段。');
  });

  it('说话人改名会清理破坏时间轴格式的方括号和换行', () => {
    const note = '## 转录全文\n\n**[00:00 - 00:03]** [说话人1] 第一段。';
    const renamed = renameTranscriptSpeaker(note, '说话人1', ' 小公爷[客户]\n主讲 ');

    expect(renamed).toContain('[小公爷 客户 主讲] 第一段。');
    expect(parseTranscriptSegments(renamed)[0].speaker).toBe('小公爷 客户 主讲');
  });

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

describe('buildTranscriptWordCloud', () => {
  it('汇总整场录音词频并过滤常见停用词', () => {
    const cloud = buildTranscriptWordCloud([
      { start: 0, end: 2, text: '报价合理，交付质量重要' },
      { start: 2, end: 4, text: '报价需要匹配交付质量' },
    ]);
    expect(cloud.some(item => item.word.includes('报价'))).toBe(true);
    expect(cloud.some(item => item.word === '需要')).toBe(false);
  });

  it('只出现一次的词不进词云——词云的意义是「反复提到」', () => {
    const cloud = buildTranscriptWordCloud([
      { start: 0, end: 2, text: '报价报价，顺带提一句排期' },
    ]);
    expect(cloud.some(item => item.word === '报价')).toBe(true);
    // 排期只说了一次，不算这场的关键词
    expect(cloud.some(item => item.word === '排期')).toBe(false);
  });

  it('丢掉「接上前一个窗口尾字」的滑窗碎片', () => {
    const cloud = buildTranscriptWordCloud([
      { start: 0, end: 2, text: '交付质量重要' },
      { start: 2, end: 4, text: '匹配交付质量' },
    ]);
    // 交付、质量是真词
    expect(cloud.some(item => item.word === '交付')).toBe(true);
    expect(cloud.some(item => item.word === '质量')).toBe(true);
    // 付质 是「交付」的尾字接上「质量」的首字滑出来的半截，频次与本体相同，必须丢
    expect(cloud.some(item => item.word === '付质')).toBe(false);
  });

  it('按频次降序，第一个就是全场最常提到的（展示层的权重基准）', () => {
    const cloud = buildTranscriptWordCloud([
      { start: 0, end: 2, text: '排期排期排期，另外说说预算预算' },
    ]);
    expect(cloud[0]).toEqual({ word: '排期', count: 3 });
    expect(cloud.every((item, index) => index === 0 || item.count <= cloud[index - 1].count)).toBe(true);
  });
});

describe('parseRecordingAnswerParts', () => {
  it('把单点和区间引用转换为可跳播秒数', () => {
    expect(parseRecordingAnswerParts('结论一 [00:12-00:18]，补充 [01:02]。')).toEqual([
      { kind: 'text', text: '结论一 ' },
      { kind: 'citation', label: '[00:12-00:18]', start: 12 },
      { kind: 'text', text: '，补充 ' },
      { kind: 'citation', label: '[01:02]', start: 62 },
      { kind: 'text', text: '。' },
    ]);
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

  it('估算跟随拆出的句子仍可逐句校对', () => {
    const note = '## 转录全文\n\n第一句。第二句更长。第三句。';
    expect(replaceEstimatedTranscriptSentenceText(note, 1, '修改后的第二句。'))
      .toContain('第一句。修改后的第二句。第三句。');
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

describe('parseSpeakerSourceNote', () => {
  // 契约来源：后端 SubtitleFormatter.FormatSpeakerSourceNote 写进笔记的
  //   `> 说话人来源：{key} · {说明}` 行。key 决定口吻，说明文案只在后端维护一份。
  const noteWith = (line: string) =>
    `# 录音 · 转录笔记\n> 来源：a.m4a\n\n## 转录全文\n\n${line}\n\n**[00:00 - 00:09]** [说话人1] 甲。\n`;

  it('本地声纹兜底判为估算，说明文案原样取自笔记', () => {
    const parsed = parseSpeakerSourceNote(noteWith(
      '> 说话人来源：local · 声纹估算 · 本地按声纹分出几种声音是真实声学结果，但每句归谁是按语速比例推算的，可能与实际不符'));
    expect(parsed?.key).toBe('local');
    expect(parsed?.estimated).toBe(true);
    expect(parsed?.text).toContain('按语速比例推算');
  });

  it('上游原生识别不标估算', () => {
    const parsed = parseSpeakerSourceNote(noteWith('> 说话人来源：native · 原生识别 · 由语音识别服务直接返回，逐句归属可信'));
    expect(parsed?.key).toBe('native');
    expect(parsed?.estimated).toBe(false);
  });

  it('模型重听属于模型判断，同样标估算', () => {
    expect(parseSpeakerSourceNote(noteWith('> 说话人来源：model · 模型重听 · 音频模型重新听完整段后按声音切分，属模型判断'))?.estimated).toBe(true);
  });

  it('旧笔记没有来源行时返回 null，不猜也不兜底', () => {
    expect(parseSpeakerSourceNote('# 录音\n\n## 转录全文\n\n**[00:00 - 00:09]** [说话人1] 甲。')).toBeNull();
    expect(parseSpeakerSourceNote('')).toBeNull();
  });

  it('来源行不参与逐句解析，不会被当成一句转录', () => {
    const md = noteWith('> 说话人来源：local · 声纹估算 · 每句归谁按语速比例推算');
    expect(parseTranscriptSegments(md)).toEqual([
      { start: 0, end: 9, speaker: '说话人1', text: '甲。' },
    ]);
  });
});
