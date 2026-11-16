import { toUserReadableErrorMessage } from './userReadableError';

const QUOTA_PATTERN = /(?:额度已用尽|额度用尽|insufficient credits|key limit exceeded|quota exceeded)/i;
const UNSUPPORTED_DURATION_PATTERN = /Duration\s+(\d+)s\s+is not supported.*Supported durations:\s*([\d,\s]+)s/i;

export function formatVideoGenerationError(message?: string | null, code?: string | null): string {
  const diagnostic = message?.trim() || '';
  if (!code && QUOTA_PATTERN.test(diagnostic)) {
    return toUserReadableErrorMessage({ code: 'LLM_QUOTA_EXCEEDED' }, {
      fallbackMessage: '视频生成未完成', recoveryMessage: '请联系管理员检查服务额度后重试',
    });
  }

  const duration = diagnostic.match(UNSUPPORTED_DURATION_PATTERN);
  if (duration) {
    return `当前模型不支持 ${duration[1]} 秒视频，仅支持 ${duration[2].trim()} 秒。请改用支持的时长后重试。`;
  }

  return toUserReadableErrorMessage(diagnostic, {
    code: code || 'VIDEOGEN_ERROR',
    fallbackMessage: '视频生成未完成',
    recoveryMessage: '请稍后重试；若持续出现，请联系管理员',
  });
}
