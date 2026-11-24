import { describe, expect, it } from 'vitest';
import { shortVideoFailureMessage } from './shortVideoFailure';

describe('shortVideoFailureMessage', () => {
  it.each([
    ['SHORT_VIDEO_INTERRUPTED', '短视频解析因服务重启而中断，请重新解析。'],
    ['SHORT_VIDEO_TIMEOUT', '短视频解析等待超时，请重新解析。'],
  ])('按服务端稳定分类 %s 给出对应恢复动作', (errorCode, expected) => {
    expect(shortVideoFailureMessage('内部诊断不得展示', errorCode)).toBe(expected);
  });

  it.each([
    ['服务重启，短视频解析任务被中断', '短视频解析因服务重启而中断，请重新解析。'],
    ['Worker 关闭，短视频解析任务被中断', '短视频解析因服务重启而中断，请重新解析。'],
    ['处理超时或中断，请重试', '短视频解析等待超时，请重新解析。'],
  ])('兼容缺少错误分类的历史记录：%s', (legacyMessage, expected) => {
    expect(shortVideoFailureMessage(legacyMessage)).toBe(expected);
  });

  it('未知失败不展示原始诊断并保留链接恢复动作', () => {
    const message = shortVideoFailureMessage('HTTP 500 provider traceId=secret');

    expect(message).toBe('短视频解析未完成，请检查链接后重新解析。');
    expect(message).not.toMatch(/HTTP|provider|traceId/i);
  });
});
