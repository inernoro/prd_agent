/**
 * 词云空态该说哪一句。
 *
 * 这条测试同时钉住一个**诚实性**约束：稿面写「超过 50 句时会自动出现主题与关键词」，
 * 而实现的门槛根本不是句数（是同一个词出现两次以上）。照抄稿面就是承诺一条
 * 不存在的规则——所以文案只许说「太短、还没机会重复」，不许说「满 50 句就会有」。
 */
import { describe, it, expect } from 'vitest';
import { describeWordCloudEmptyState } from '@/components/doc-browser/transcriptSegments';

describe('describeWordCloudEmptyState', () => {
  it('原文很短时，说的是「太短」而不是「分词器不认识」', () => {
    const text = describeWordCloudEmptyState(18);
    expect(text).toContain('只有 18 句');
    expect(text).toContain('两次以上');
    expect(text).not.toContain('分词器');
  });

  it('够长却仍为空时，说的是「词没被认出来」并给补词典的出路', () => {
    const text = describeWordCloudEmptyState(132);
    expect(text).toContain('词典');
    expect(text).not.toContain('太短');
  });

  it('不许承诺「满 N 句就会有词云」——实现的门槛不是句数', () => {
    for (const n of [0, 1, 18, 49, 50, 132]) {
      const text = describeWordCloudEmptyState(n);
      expect(text, `句数 ${n} 的文案`).not.toMatch(/超过\s*\d+\s*句.*会(自动)?出现/);
    }
  });

  it('一句都没有时不编一个句数出来', () => {
    expect(describeWordCloudEmptyState(0)).not.toContain('只有 0 句');
  });
});
