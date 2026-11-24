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

/*
 * 引用落在两句交界处时该算后面那一句。提示词要求模型用既有时间戳引用，所以
 * 「引用起点 == 某句起点」是常态；判据两端都闭时会稳定选中前一句，卡片显示与跳播
 * 都落在被引用那句的上一句（Codex P2）。
 */
describe('引用落在两句交界处', () => {
  const ADJACENT = [
    { start: 0, end: 5, text: '上一句。', speaker: '主持人' },
    { start: 5, end: 10, text: '被引用的这一句。', speaker: '受访者 A' },
  ];

  it('00:05 认后面那一句，不认上一句的结尾', () => {
    const { citations } = resolveAnswerCitations('结论。[00:05]', ADJACENT);
    expect(citations).toHaveLength(1);
    expect(citations[0].start).toBe(5);
    expect(citations[0].text).toBe('被引用的这一句。');
  });

  it('落在句子中间照常认这一句', () => {
    const { citations } = resolveAnswerCitations('结论。[00:07]', ADJACENT);
    expect(citations[0].start).toBe(5);
  });

  it('落在最后一句结尾仍然认得出来，不退化成「时间轴里没有这个位置」', () => {
    const { citations } = resolveAnswerCitations('结论。[00:10]', ADJACENT);
    expect(citations).toHaveLength(1);
    expect(citations[0].start).toBe(5);
  });
});

