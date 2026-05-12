import { describe, expect, it } from 'vitest';
import { mergeStreamAsrErrorResult, type StreamAsrResultState } from './ExchangeTestPanel';

describe('ExchangeTestPanel stream ASR result merging', () => {
  it('保留 result 事件中已经返回的转写内容和诊断信息', () => {
    const previous: StreamAsrResultState = {
      success: true,
      text: '已经转写出的内容',
      segmentCount: 3,
      durationMs: 1200,
      diagnostic: { stage: 'result', requestId: 'req-1' },
    };

    const merged = mergeStreamAsrErrorResult(previous, {
      error: '后续错误',
      diagnostic: { stage: 'error', requestId: 'req-2' },
    });

    expect(merged).toEqual({
      success: false,
      text: '已经转写出的内容',
      segmentCount: 3,
      durationMs: 1200,
      error: '后续错误',
      diagnostic: { stage: 'error', requestId: 'req-2' },
    });
  });

  it('没有既有结果时返回空转写错误态', () => {
    const merged = mergeStreamAsrErrorResult(null, { error: '连接失败' });

    expect(merged).toEqual({
      success: false,
      text: '',
      segmentCount: 0,
      durationMs: 0,
      error: '连接失败',
      diagnostic: undefined,
    });
  });
});
