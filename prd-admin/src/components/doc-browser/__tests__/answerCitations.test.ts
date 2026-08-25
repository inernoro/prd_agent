import { describe, it, expect } from 'vitest';
import { resolveAnswerCitations, isUnansweredByTranscript } from '../transcriptSegments';

const SEGMENTS = [
  { start: 0, end: 5, text: '先说结论，导入是这一版最大的漏斗。', speaker: '主持人' },
  { start: 598, end: 610, text: '等待解析那 40 秒，我以为它卡死了。', speaker: '受访者 A' },
  { start: 612, end: 620, text: '我通常会直接退出去重开一次。', speaker: '受访者 A' },
];

describe('把回答拆成结论 + 引用卡', () => {
  it('引用被提出来做成卡片，带上原文句子与说话人', () => {
    const { conclusion, citations } = resolveAnswerCitations(
      '解析等待 40 秒且无进度反馈，被判断为卡死。[09:58]',
      SEGMENTS,
    );
    expect(conclusion).toBe('解析等待 40 秒且无进度反馈，被判断为卡死。');
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({
      start: 598,
      text: '等待解析那 40 秒，我以为它卡死了。',
      speaker: '受访者 A',
    });
  });

  it('同一句被引用两次只出一张卡——两张一模一样的卡是噪音', () => {
    const { citations } = resolveAnswerCitations('甲 [09:58] 乙 [10:00]', SEGMENTS);
    expect(citations).toHaveLength(1);
  });

  it('时间轴里没有的引用不做成卡，原样留在正文里', () => {
    // 模型报了 20:00，原文最长只到 10:20——那是幻觉，不能给它一张像模像样的卡
    const { conclusion, citations } = resolveAnswerCitations('结论如此。[20:00]', SEGMENTS);
    expect(citations).toHaveLength(0);
    expect(conclusion).toContain('[20:00]');
  });

  it('多条引用按出现顺序各出一张卡', () => {
    const { citations } = resolveAnswerCitations('甲 [00:01] 乙 [10:12]', SEGMENTS);
    expect(citations.map(c => c.start)).toEqual([0, 612]);
  });

  it('没有引用时结论就是全文，引用为空数组', () => {
    const { conclusion, citations } = resolveAnswerCitations('这段录音没提到价格。', SEGMENTS);
    expect(conclusion).toBe('这段录音没提到价格。');
    expect(citations).toEqual([]);
  });
});

describe('如实说明「原文里没有」', () => {
  it('认得出提示词要求模型说的那几种说法', () => {
    expect(isUnansweredByTranscript('无法从录音确认客户对价格的态度。')).toBe(true);
    expect(isUnansweredByTranscript('原文无相关内容。')).toBe(true);
    expect(isUnansweredByTranscript('录音中没有提到价格。')).toBe(true);
  });

  it('中间夹了空格换行也认——模型的排版不该影响判定', () => {
    expect(isUnansweredByTranscript('无法\n从录音\n确认。')).toBe(true);
  });

  it('正常回答不会被误判成「没答上来」', () => {
    expect(isUnansweredByTranscript('解析等待 40 秒且无进度反馈，被判断为卡死。')).toBe(false);
  });
});
