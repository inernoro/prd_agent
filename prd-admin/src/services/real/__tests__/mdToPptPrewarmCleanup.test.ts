import { describe, expect, it, vi } from 'vitest';

import { handleMdToPptRejectedResponse } from '../mdToPptService';

describe('md-to-ppt rejected convert cleanup', () => {
  it('stops an unused prewarm and surfaces the stable server error', async () => {
    const cancel = vi.fn(async () => undefined);
    const onError = vi.fn();
    const response = {
      status: 409,
      json: async () => ({
        error: '知识来源与已确认大纲不一致，请刷新来源并重新生成大纲',
        code: 'outline_knowledge_mismatch',
      }),
    } as Response;

    await handleMdToPptRejectedResponse(response, onError, cancel);

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('知识来源与已确认大纲不一致，请刷新来源并重新生成大纲');
  });

  it('does not expose a non-JSON proxy response body', async () => {
    const cancel = vi.fn(async () => undefined);
    const onError = vi.fn();
    const response = {
      status: 502,
      json: async () => { throw new SyntaxError('not json'); },
    } as unknown as Response;

    await handleMdToPptRejectedResponse(response, onError, cancel);

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('请求未被接受（502）');
  });
});
