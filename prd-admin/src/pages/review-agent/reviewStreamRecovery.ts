import type { ReviewSubmission } from '@/services';

type ReviewStatus = ReviewSubmission['status'];

export function normalizeReviewStreamError(rawMessage: string): string {
  const message = rawMessage.trim();

  if (message) {
    try {
      const payload = JSON.parse(message) as {
        error?: { message?: unknown };
        message?: unknown;
      };
      const apiMessage = payload.error?.message ?? payload.message;
      if (typeof apiMessage === 'string' && apiMessage.trim()) {
        return apiMessage.trim();
      }
    } catch {
      // 非 JSON 错误继续按普通文本归一化。
    }
  }

  if (/RATE_LIMITED|请求失败\s*\(429\)|HTTP\s*429/i.test(message)) {
    return '请求频率过高，请稍后再试';
  }

  if (!message || /Failed to fetch|NetworkError|连接失败|SSE 读取失败/i.test(message)) {
    return '评审连接暂时失败，请检查网络后重试';
  }

  return message;
}

export function shouldAutoStartReviewStream(
  status: ReviewStatus,
  submissionId: string,
  lastStartedSubmissionId: string | null,
): boolean {
  return status === 'Queued' && submissionId !== lastStartedSubmissionId;
}

export function shouldPollReviewStatus(status: ReviewStatus, streaming: boolean): boolean {
  return status === 'Running' && !streaming;
}
