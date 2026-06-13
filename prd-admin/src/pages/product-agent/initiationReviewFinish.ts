import { getSubmission, type ReviewSubmission } from '@/services/real/reviewAgent';

export type SubmissionWaitResult =
  | { ok: true; submission: ReviewSubmission }
  | { ok: false; message: string };

/** SSE 结束后轮询提交状态（网关偶发 400 时重试，避免误判失败） */
export async function waitForSubmissionDone(
  submissionId: string,
  options?: { maxAttempts?: number; intervalMs?: number },
): Promise<SubmissionWaitResult> {
  const maxAttempts = options?.maxAttempts ?? 6;
  const intervalMs = options?.intervalMs ?? 1500;
  let lastMessage = '获取评审结果失败';

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const res = await getSubmission(submissionId);
    if (res.success) {
      const { submission } = res.data;
      if (submission.status === 'Done') return { ok: true, submission };
      if (submission.status === 'Error') {
        return { ok: false, message: submission.errorMessage ?? '评审失败' };
      }
      lastMessage = submission.errorMessage ?? `评审进行中（${submission.status}）`;
    } else {
      lastMessage = res.error?.message ?? lastMessage;
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  return { ok: false, message: lastMessage };
}

export function hasRecoverableSseOutcome(outcome: {
  hasResult: boolean;
  dimensionCount: number;
  streamDone: boolean;
}): boolean {
  return outcome.hasResult || outcome.dimensionCount > 0 || outcome.streamDone;
}
