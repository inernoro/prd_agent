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

  // 一卷若全是 level 3 的硬骨头，等于没人读得动 —— 它会静默退化成「书架上好看」。
  // 这条曾经是红的：卷六「驭 AI」原本只有 2 本可上手的书，其余全是模型原理专著，
  // 而它要治的抱怨是「没怎么看 AI 写的代码」，读者要的是怎么审，不是怎么训模型。
  it('每卷至少三本可上手的书（level ≤ 2），不许整卷都是硬骨头', () => {
    VOLUMES.forEach((v) => {
      const entry = v.books.filter((b) => b.level <= 2);
      expect(entry.length, `卷「${v.name}」只有 ${entry.length} 本可上手的书，门槛太高`).toBeGreaterThanOrEqual(3);
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

  // 这一卷内容写的是处境，不是某个人说过的话。
  // 页面对全员可见，逐字挂上同事的原话等于把人架在那儿——转述成症状既留住
  // 「说的就是我」的共鸣，也不让任何人对号入座。
  //
  // 判据范围是**全部面向读者的文案**，不只是痛点卡：第一版只扫 painQuote 与 quote，
  // 于是书目 why 里的「很多我都审不出来」、考题里的「什么都不跟我说」「扫码流程」
  // 一路漏到线上，是线上验收才抓回来的。判据窄过它该管的范围，就是没有判据。
  it('全部读者可见文案都不留原话、人名与可定位的业务细节', () => {
    const RETIRED = [
      '王忠',                    // 同事姓名，一度直接挂在卷七的 painQuote 上
      '不应该是我', '审不出来',  // 评审那段对话
      '什么都不跟我说',          // 规范/构建/发布那段
      '扫码', 'AI 都在乱写', '项目改的我都不想看了', '心累', '急赶急',
      '他说', '我说', '昨天',    // 转述痕迹：出现即说明在照抄对话
    ];
    const texts: { where: string; text: string }[] = [];
    VOLUMES.forEach((v) => {
      texts.push({ where: `卷「${v.name}」的 painQuote`, text: v.painQuote });
      texts.push({ where: `卷「${v.name}」的 cure`, text: v.cure });
      texts.push({ where: `卷「${v.name}」的 subtitle`, text: v.subtitle });
      v.books.forEach((b) => {
        texts.push({ where: `《${b.title}》的 why`, text: b.why });
        texts.push({ where: `《${b.title}》的 takeaway`, text: b.takeaway });
      });
    });
    PAIN_REMEDIES.forEach((r) => {
      texts.push({ where: `痛点卡「${r.quote}」`, text: r.quote });
      texts.push({ where: `痛点卡「${r.quote}」的 diagnosis`, text: r.diagnosis });
    });
    QUESTIONS.forEach((q) => {
      texts.push({ where: `题 ${q.id} 的题干`, text: q.stem });
      texts.push({ where: `题 ${q.id} 的解析`, text: q.explain });
      q.options.forEach((o, i) => texts.push({ where: `题 ${q.id} 选项 ${i}`, text: o }));
    });
    texts.forEach(({ where, text }) => {
      // 字段名写错时 text 会是 undefined，扫描静默通过——守卫自己就成了摆设。
      // 第一版正是这样：PainRemedy 上并没有 cure 字段。
      expect(typeof text, `${where} 取到的不是字符串，守卫扫了个空`).toBe('string');
      RETIRED.forEach((w) => {
        expect(text, `${where} 里出现「${w}」——那是同事的原话/姓名或能对号入座的业务细节`)
          .not.toContain(w);
      });
    });
  });

  it('痛点描述不重复', () => {
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
