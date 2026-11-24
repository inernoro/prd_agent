/**
 * 琥珀提示条「上一问没答上来」的存活规则。
 *
 * 为什么单独测它：这条规则出过一个只有真实页面能照出来的 bug——
 * 后一问答得上来时顺手把提示清掉，于是它只存在于两次提问之间的空档，
 * **屏幕上永远等不到**。代码在、界面上没有，单测也不会红
 * （predicate-and-wiring-discipline 形状 2）。稿面 B4 画的正是
 * 「琥珀条 + 一条答得上来的问答」同屏，所以「陪满下一轮」是契约，不是手感。
 */
import { describe, it, expect } from 'vitest';
import {
  advanceUnansweredNotice,
  NO_UNANSWERED_NOTICE,
} from '@/components/doc-browser/transcriptSegments';

const ANSWERED = '解析等待 40 秒且没有进度反馈，被判断为卡死。[09:58]';
const HONEST_NO = '无法从录音确认：这段访谈里没有提到价格。';

describe('advanceUnansweredNotice', () => {
  it('答不上来就记下这一问', () => {
    const next = advanceUnansweredNotice(NO_UNANSWERED_NOTICE, { question: '价格怎么谈的？', answer: HONEST_NO });
    expect(next.question).toBe('价格怎么谈的？');
    expect(next.shown).toBe(false);
  });

  it('下一问答得上来时提示条**还在**——稿面画的就是这一屏', () => {
    const first = advanceUnansweredNotice(NO_UNANSWERED_NOTICE, { question: '价格怎么谈的？', answer: HONEST_NO });
    const second = advanceUnansweredNotice(first, { question: '为什么放弃导入？', answer: ANSWERED });
    expect(second.question).toBe('价格怎么谈的？');
    expect(second.shown).toBe(true);
  });

  it('陪满一轮之后才退场，不会一直挂着', () => {
    const first = advanceUnansweredNotice(NO_UNANSWERED_NOTICE, { question: '价格怎么谈的？', answer: HONEST_NO });
    const second = advanceUnansweredNotice(first, { question: '为什么放弃导入？', answer: ANSWERED });
    const third = advanceUnansweredNotice(second, { question: '还有谁提到重开？', answer: ANSWERED });
    expect(third).toEqual(NO_UNANSWERED_NOTICE);
  });

  it('又一次答不上来就换成最近这一条，寿命重新开始算', () => {
    const first = advanceUnansweredNotice(NO_UNANSWERED_NOTICE, { question: '价格怎么谈的？', answer: HONEST_NO });
    const second = advanceUnansweredNotice(first, { question: '预算多少？', answer: HONEST_NO });
    expect(second).toEqual({ question: '预算多少？', shown: false });
  });

  it('一直答得上来时不会凭空长出提示条', () => {
    expect(advanceUnansweredNotice(NO_UNANSWERED_NOTICE, { question: '为什么放弃导入？', answer: ANSWERED }))
      .toEqual(NO_UNANSWERED_NOTICE);
  });
});
