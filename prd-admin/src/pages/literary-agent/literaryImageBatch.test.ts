import { describe, expect, it, vi } from 'vitest';
import { runLiteraryImageBatch } from './literaryImageBatch';

describe('文学批量配图发送保护', () => {
  it('连续失败两张后不提交余下十张，也不自动重试失败项', async () => {
    const send = vi.fn(async () => 'failed' as const);
    const result = await runLiteraryImageBatch(Array.from({ length: 12 }, (_, i) => i), send, new AbortController().signal);
    expect(send.mock.calls).toHaveLength(2);
    expect(result).toMatchObject({ failed: 2, remaining: 10, paused: true });
  });

  it('等待前一张的结果后才发送下一张，成功会重置连续失败计数', async () => {
    let finish!: (value: 'completed') => void;
    const first = new Promise<'completed'>(resolve => { finish = resolve; });
    const send = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('completed').mockResolvedValueOnce('failed');
    const batch = runLiteraryImageBatch([0, 1, 2, 3], send, new AbortController().signal);
    expect(send).toHaveBeenCalledTimes(1);
    finish('completed');
    expect(await batch).toMatchObject({ completed: 2, failed: 2, remaining: 0, paused: false });
    expect(send.mock.calls.map(x => x[0])).toEqual([0, 1, 2, 3]);
  });

  it('结果未确认就停止后续提交，不把它当作可重新生成的失败', async () => {
    const send = vi.fn(async () => 'pending' as const);
    expect(await runLiteraryImageBatch([0, 1, 2], send, new AbortController().signal))
      .toMatchObject({ attempted: 1, failed: 0, remaining: 2, paused: true });
    expect(send).toHaveBeenCalledOnce();
  });

  it('用户离开或取消后不再提交后续配图', async () => {
    const controller = new AbortController();
    const send = vi.fn(async () => { controller.abort(); return 'completed' as const; });
    expect(await runLiteraryImageBatch([0, 1], send, controller.signal)).toMatchObject({ attempted: 1, remaining: 1 });
    expect(send).toHaveBeenCalledOnce();
  });
});
