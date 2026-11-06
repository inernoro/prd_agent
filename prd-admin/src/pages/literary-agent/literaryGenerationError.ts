import { toUserReadableErrorMessage } from '@/lib/userReadableError';

/** 标记流、图片失败和刷新回读共用用户提示，原始诊断保留在受控日志和任务。 */
export function literaryGenerationError(error: unknown): string {
  return toUserReadableErrorMessage(error, {
    fallbackMessage: '本次配图未能完成。',
    recoveryMessage: '请稍后重试；若持续失败，请联系管理员检查创作服务。',
  });
}
