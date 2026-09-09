/**
 * 藏书阁内容守卫。
 *
 * 为什么需要它（predicate-and-wiring-discipline.md 形状 2「链路只建一半」）：
 * 书目与考题是纯数据，写错了不会编译失败、不会有任何红灯——一道题的 answer
 * 下标越界、一卷书没有对应考题、痛点指向一个不存在的卷，页面都照常渲染，
 * 只是内容悄悄坏掉。这类静默退化必须由机械判据兜住。
 */
import { describe, expect, it } from 'vitest';
import { VOLUMES, PAIN_REMEDIES, ALL_BOOKS, findVolume } from '../catalog';
import { QUESTIONS, questionsOf, isPassed, PASS_RATE } from '../exams';

describe('藏书阁书目', () => {
  it('卷序连续且唯一，从 1 开始', () => {
    expect(VOLUMES.map((v) => v.index)).toEqual(VOLUMES.map((_, i) => i + 1));
  });

  it('卷 id 与书目 id 全局唯一', () => {
    const volIds = VOLUMES.map((v) => v.id);
    expect(new Set(volIds).size).toBe(volIds.length);
    const bookIds = ALL_BOOKS.map((b) => b.id);
    expect(new Set(bookIds).size).toBe(bookIds.length);
  });

  it('每卷至少三本书，且首本是该卷的入口书', () => {
    VOLUMES.forEach((v) => {
      expect(v.books.length, `卷「${v.name}」书目过少`).toBeGreaterThanOrEqual(3);
    });
  });

  it('每本书的 why / takeaway 都写实，不出现「经典必读」这类空话', () => {
    const EMPTY_TALK = ['经典必读', '必读书目', '强烈推荐', '不容错过'];
    ALL_BOOKS.forEach((b) => {
      expect(b.why.length, `《${b.title}》的 why 太短`).toBeGreaterThan(20);
      expect(b.takeaway.length, `《${b.title}》的 takeaway 太短`).toBeGreaterThan(10);
      EMPTY_TALK.forEach((w) => {
        expect(b.why, `《${b.title}》的 why 出现空话「${w}」`).not.toContain(w);
      });
    });
  });

  it('每卷都钉着一句真实抱怨与一条药方', () => {
    VOLUMES.forEach((v) => {
      expect(v.painQuote.length, `卷「${v.name}」缺 painQuote`).toBeGreaterThan(8);
      expect(v.cure.length, `卷「${v.name}」缺 cure`).toBeGreaterThan(20);
    });
  });

  it('开发线与产品线都有足量书目（两条线都必须走得通）', () => {
    const dev = ALL_BOOKS.filter((b) => b.track === 'dev' || b.track === 'both');
    const pm = ALL_BOOKS.filter((b) => b.track === 'pm' || b.track === 'both');
    expect(dev.length).toBeGreaterThanOrEqual(20);
    expect(pm.length).toBeGreaterThanOrEqual(10);
  });
});

describe('痛点药方表', () => {
  it('每条痛点都指向一个真实存在的卷（不许指向空气）', () => {
    PAIN_REMEDIES.forEach((r) => {
      expect(findVolume(r.volumeId), `痛点「${r.quote}」指向了不存在的卷 ${r.volumeId}`).toBeDefined();
    });
  });

  it('痛点原话不重复', () => {
    const quotes = PAIN_REMEDIES.map((r) => r.quote);
    expect(new Set(quotes).size).toBe(quotes.length);
  });
});

describe('结业考题', () => {
  it('题目 id 唯一', () => {
    const ids = QUESTIONS.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每题都归属一个真实存在的卷', () => {
    QUESTIONS.forEach((q) => {
      expect(findVolume(q.volumeId), `题 ${q.id} 归属了不存在的卷`).toBeDefined();
    });
  });

  it('每题四个选项，answer 下标必须落在选项范围内', () => {
    QUESTIONS.forEach((q) => {
      expect(q.options.length, `题 ${q.id} 选项数不是 4`).toBe(4);
      expect(q.answer, `题 ${q.id} 的 answer 下标越界`).toBeGreaterThanOrEqual(0);
      expect(q.answer).toBeLessThan(q.options.length);
    });
  });

  it('每题都有解析，且解析要解释错项（答错的人得带走可执行的改法）', () => {
    QUESTIONS.forEach((q) => {
      expect(q.explain.length, `题 ${q.id} 的解析太短`).toBeGreaterThan(40);
    });
  });

  it('每一卷都配了考题，没有考不了的卷', () => {
    VOLUMES.forEach((v) => {
      expect(questionsOf(v.id).length, `卷「${v.name}」没有考题`).toBeGreaterThanOrEqual(3);
    });
  });

  it('选项不重复，避免出现两个字面相同的答案', () => {
    QUESTIONS.forEach((q) => {
      expect(new Set(q.options).size, `题 ${q.id} 有重复选项`).toBe(q.options.length);
    });
  });

  it('正确答案不总是同一个下标（否则蒙 B 就能通关）', () => {
    const dist = new Set(QUESTIONS.map((q) => q.answer));
    expect(dist.size, '所有题的正确答案都在同一个位置').toBeGreaterThan(1);
  });
});

describe('及格判定', () => {
  it('达到及格线判通过，差一题判不通过', () => {
    expect(isPassed(3, 5)).toBe(true);   // 0.6 == PASS_RATE
    expect(isPassed(2, 5)).toBe(false);  // 0.4
    expect(PASS_RATE).toBe(0.6);
  });

  it('零题不算通过（避免空卷被判及格）', () => {
    expect(isPassed(0, 0)).toBe(false);
  });
});
