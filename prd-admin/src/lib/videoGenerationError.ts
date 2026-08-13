import { toUserReadableErrorMessage } from './userReadableError';

const QUOTA_PATTERN = /(?:额度已用尽|额度用尽|insufficient credits|key limit exceeded|quota exceeded)/i;
const UNSUPPORTED_DURATION_PATTERN = /Duration\s+(\d+)s\s+is not supported.*Supported durations:\s*([\d,\s]+)s/i;

export function formatVideoGenerationError(message?: string | null): string {
  const diagnostic = message?.trim() || '';
  if (QUOTA_PATTERN.test(diagnostic)) {
    return '当前可用额度不足，请联系管理员补充额度或切换可用配置后重试。';
  }

  const duration = diagnostic.match(UNSUPPORTED_DURATION_PATTERN);
  if (duration) {
    return `当前模型不支持 ${duration[1]} 秒视频，仅支持 ${duration[2].trim()} 秒。请改用支持的时长后重试。`;
  }

  return toUserReadableErrorMessage(diagnostic, {
    fallbackMessage: '视频生成未完成',
    recoveryMessage: '请稍后重试；若持续出现，请联系管理员',
  });
}
