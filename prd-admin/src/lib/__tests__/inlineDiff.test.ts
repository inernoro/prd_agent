import { describe, expect, it } from 'vitest';
import { computeInlineDiff, lineSimilarity, tokenizeInlineAtoms } from '../lineDiff';

/**
 * 2026-08-25 用户："自己使用代码的方式来 diff，不要让大模型 diff，避免 diff 不够精准。"
 * diff 一直是代码算的（LCS），不精准的是**粒度**——行级 diff 改一个词也把整行标成删+加。
 * 这一层在配对上的那对行里再算一次，只标真正变了的那几个词。
 */
describe('tokenizeInlineAtoms：行内标记不可从中间劈开', () => {
  it('加粗 / 行内代码 / 链接 / 双链各算一个原子', () => {
    expect(tokenizeInlineAtoms('**加粗**')).toEqual(['**加粗**']);
    expect(tokenizeInlineAtoms('`code`')).toEqual(['`code`']);
    expect(tokenizeInlineAtoms('[文字](http://a.b)')).toEqual(['[文字](http://a.b)']);
    expect(tokenizeInlineAtoms('[[双链]]')).toEqual(['[[双链]]']);
    expect(tokenizeInlineAtoms('~~删~~')).toEqual(['~~删~~']);
  });

  it('中文逐字、英文按词、数字带小数点', () => {
    expect(tokenizeInlineAtoms('能力基准')).toEqual(['能', '力', '基', '准']);
    expect(tokenizeInlineAtoms('hello world')).toEqual(['hello', ' ', 'world']);
    expect(tokenizeInlineAtoms('V0.1')).toEqual(['V', '0.1']);
  });

  it('切出来的原子拼回去必须与原文一字不差', () => {
    for (const line of [
      '第一阶段建议至少形成以下成果：',
      '1. **《真实工作能力基准标准》V0.1**，定义 `taskSource` 与 [[分级]]',
      'mix 中英 mixed 123 与 [链接](https://x.y) 结尾',
    ]) {
      expect(tokenizeInlineAtoms(line).join('')).toBe(line);
    }
  });
});

describe('computeInlineDiff：只标真正变了的那几个字', () => {
  it('句中插入几个字，只标那几个字，其余是 eq', () => {
    const segs = computeInlineDiff('第一阶段建议至少形成以下成果：', '第一阶段建议至少形成以下可落地成果：');
    expect(segs.map((s) => s.type)).toEqual(['eq', 'add', 'eq']);
    expect(segs.find((s) => s.type === 'add')!.text).toBe('可落地');
    // 拼回去必须分别等于原文与新文，一个字都不能丢
    expect(segs.filter((s) => s.type !== 'add').map((s) => s.text).join('')).toBe('第一阶段建议至少形成以下成果：');
    expect(segs.filter((s) => s.type !== 'del').map((s) => s.text).join('')).toBe('第一阶段建议至少形成以下可落地成果：');
  });

  it('连续变化的字合并成一段，不碎成一堆小块', () => {
    const segs = computeInlineDiff('统一问题说明', '统一缺陷说明');
    expect(segs.filter((s) => s.type === 'del').length).toBe(1);
    expect(segs.filter((s) => s.type === 'add').length).toBe(1);
  });

  it('加粗整个换掉时不会留下落单的星号', () => {
    const segs = computeInlineDiff('前缀 **旧标题** 后缀', '前缀 **新标题** 后缀');
    for (const s of segs) {
      const stars = (s.text.match(/\*/g) ?? []).length;
      expect(stars % 2, `片段「${s.text}」里星号落单了`).toBe(0);
    }
  });

  it('完全不同的两行退化成整删整加', () => {
    const segs = computeInlineDiff('甲乙丙', 'XYZ');
    expect(segs.map((s) => s.type).sort()).toEqual(['add', 'del']);
  });
});

describe('lineSimilarity：判断两行值不值得做行内 diff', () => {
  it('改几个字的两行相似度高', () => {
    expect(lineSimilarity('第一阶段建议至少形成以下成果：', '第一阶段建议至少形成以下可落地成果：')).toBeGreaterThan(0.7);
  });
  it('毫不相干的两行相似度低', () => {
    expect(lineSimilarity('第一阶段建议', '完全不同的另一句话')).toBeLessThan(0.4);
  });
});
