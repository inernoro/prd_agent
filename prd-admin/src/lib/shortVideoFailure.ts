import { toUserReadableErrorMessage } from './userReadableError';

export function shortVideoFailureMessage(value: unknown, errorCode?: string): string {
  const legacyMessage = typeof value === 'string' ? value : '';
  const derivedCode = errorCode
    || (/服务重启|Worker\s*关闭/i.test(legacyMessage) ? 'SHORT_VIDEO_INTERRUPTED' : undefined)
    || (/处理超时|等待超时/i.test(legacyMessage) ? 'SHORT_VIDEO_TIMEOUT' : undefined);

  return toUserReadableErrorMessage(derivedCode ? { code: derivedCode, message: legacyMessage } : value, {
    fallbackMessage: '短视频解析未完成',
    recoveryMessage: '请检查链接后重新解析。',
  });
}
