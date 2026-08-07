import { describe, expect, it } from 'vitest';
import { describeRetryWait } from '../TranscribeFlowDrawer';

/**
 * 「转录卡住了，我不知道是好了还是坏了」——这句文案就是对那句抱怨的正面回答。
 * 它删掉不会报错，只会让界面退回一个不说话的转圈，所以必须有断言盯着。
 */
describe('describeRetryWait', () => {
  it('等重试时说清原因、已重试次数、下次时刻、录音是否安全', () => {
    const t = describeRetryWait({ count: 3, nextAt: '2026-08-07T12:11:12.362Z' });
    expect(t).toContain('暂时不可用');
    expect(t).toContain('已自动重试 3 次');
    expect(t).toContain('下一次约在');
    expect(t).toContain('录音已安全保存');
  });

  it('没有在等重试时不说话，不制造噪音', () => {
    expect(describeRetryWait(null)).toBe('');
  });

  it('时间戳坏掉时省略时刻，绝不把 Invalid Date 摆给用户', () => {
    const t = describeRetryWait({ count: 1, nextAt: 'not-a-date' });
    expect(t).not.toContain('Invalid');
    expect(t).not.toContain('NaN');
    expect(t).toContain('已自动重试 1 次');
    expect(t).toContain('录音已安全保存');
  });
});
