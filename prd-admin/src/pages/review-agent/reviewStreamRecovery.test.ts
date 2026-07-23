import { describe, expect, it } from 'vitest';
import {
  normalizeReviewStreamError,
  shouldAutoStartReviewStream,
  shouldPollReviewStatus,
  shouldRecoverAfterReviewStreamClosed,
} from './reviewStreamRecovery';

describe('review stream recovery', () => {
  it('从限流 ApiResponse 中提取可理解的中文提示', () => {
    expect(normalizeReviewStreamError(JSON.stringify({
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: '请求频率过高，请稍后再试',
      },
    }))).toBe('请求频率过高，请稍后再试');
  });

  it('网络断流不暴露底层异常', () => {
    expect(normalizeReviewStreamError('Failed to fetch'))
      .toBe('评审连接暂时失败，请检查网络后重试');
    expect(normalizeReviewStreamError('连接失败'))
      .toBe('评审连接暂时失败，请检查网络后重试');
  });

  it('Queued 只自动启动一次，Running 改为轮询权威状态', () => {
    expect(shouldAutoStartReviewStream('Queued', 'submission-1', null)).toBe(true);
    expect(shouldAutoStartReviewStream('Queued', 'submission-1', 'submission-1')).toBe(false);
    expect(shouldAutoStartReviewStream('Running', 'submission-1', null)).toBe(false);
    expect(shouldPollReviewStatus('Running', false)).toBe(true);
    expect(shouldPollReviewStatus('Running', true)).toBe(false);
  });

  it('SSE 未收到终态事件即自然断开时恢复后端状态同步', () => {
    expect(shouldRecoverAfterReviewStreamClosed(true, 'done')).toBe(true);
    expect(shouldRecoverAfterReviewStreamClosed(true, 'error')).toBe(true);
    expect(shouldRecoverAfterReviewStreamClosed(true, 'connecting')).toBe(false);
    expect(shouldRecoverAfterReviewStreamClosed(true, 'streaming')).toBe(false);
    expect(shouldRecoverAfterReviewStreamClosed(false, 'done')).toBe(false);
  });
});
