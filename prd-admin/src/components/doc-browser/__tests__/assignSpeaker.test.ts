import { describe, expect, it } from 'vitest';
import { assignTranscriptSegmentSpeaker, parseTranscriptSegments } from '../transcriptSegments';

const BARE = `# 现场速记

## 转录全文

**[00:04 - 00:09]** 先把桌子挪到窗边。
**[00:11 - 00:16]** 麦克风离得太近了。
`;

describe('assignTranscriptSegmentSpeaker', () => {
  it('把名字补进没有说话人标签的那一行', () => {
    const next = assignTranscriptSegmentSpeaker(BARE, 1, '主持人');
    const segments = parseTranscriptSegments(next);
    expect(segments[0].speaker).toBeUndefined();
    expect(segments[1].speaker).toBe('主持人');
    expect(segments[1].text).toBe('麦克风离得太近了。');
  });

  it('传空名字是把标签去掉，正文与时间戳不动', () => {
    const named = assignTranscriptSegmentSpeaker(BARE, 0, '受访者 A');
    const cleared = assignTranscriptSegmentSpeaker(named, 0, '  ');
    expect(parseTranscriptSegments(cleared)[0].speaker).toBeUndefined();
    expect(parseTranscriptSegments(cleared)[0].text).toBe('先把桌子挪到窗边。');
    expect(parseTranscriptSegments(cleared)[0].start).toBe(4);
  });

  it('越界索引原样返回，不误伤别的句子', () => {
    expect(assignTranscriptSegmentSpeaker(BARE, 9, '甲')).toBe(BARE);
    expect(assignTranscriptSegmentSpeaker(BARE, -1, '甲')).toBe(BARE);
  });

  it('全文之外的内容一个字都不碰', () => {
    const withSummary = `# 标题\n\n## 摘要\n\n**[00:00 - 00:01]** 这行在摘要里，不该被改\n\n## 转录全文\n\n**[00:04 - 00:09]** 正文第一句。\n`;
    const next = assignTranscriptSegmentSpeaker(withSummary, 0, '主持人');
    expect(next).toContain('**[00:00 - 00:01]** 这行在摘要里，不该被改');
    expect(next).toContain('**[00:04 - 00:09]** [主持人] 正文第一句。');
  });
});

/*
 * 名字里带 `]` 或换行会把 `**[00:00 - 00:03]** [名字] 正文` 这行标记拆坏：
 * 重新解析时只有第一个 `]` 之前算名字，剩下的挤进正文，严重时整行不再被认成一句
 * （Codex P2）。改名那一路早就规范化了，指派这一路没有——两处现在共用同一个规范化。
 */
describe('指派说话人时的名字规范化', () => {
  const md = '## 转录全文\n\n**[00:00 - 00:03]** 第一句\n**[00:03 - 00:06]** 第二句';

  it('方括号被换掉，标记不会被拆坏', () => {
    const next = assignTranscriptSegmentSpeaker(md, 0, '主持人] 假正文');
    expect(next).toContain('**[00:00 - 00:03]** [主持人 假正文] 第一句');
    const segments = parseTranscriptSegments(next);
    expect(segments[0].speaker).toBe('主持人 假正文');
    expect(segments[0].text).toBe('第一句');
  });

  it('换行被压平，不会把一句拆成两行', () => {
    const next = assignTranscriptSegmentSpeaker(md, 1, '嘉宾\n第二行');
    expect(next.split('\n').filter(line => line.includes('00:03 - 00:06'))).toHaveLength(1);
    expect(parseTranscriptSegments(next)[1].speaker).toBe('嘉宾 第二行');
  });

  it('超长名字截断到 30 字，与改名那一路同一口径', () => {
    const long = '名'.repeat(50);
    const next = assignTranscriptSegmentSpeaker(md, 0, long);
    expect(parseTranscriptSegments(next)[0].speaker).toHaveLength(30);
  });
});

