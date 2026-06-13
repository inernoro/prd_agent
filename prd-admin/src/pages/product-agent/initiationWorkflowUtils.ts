import type { InitiationMeetingDraftRound, ProductInitiation } from './types';

const DRAFT_LABELS = ['第一稿', '第二稿', '第三稿'] as const;

export function meetingDraftLabel(round: number): string {
  return DRAFT_LABELS[round - 1] ?? `第 ${round} 稿`;
}

/** 合并 meetingDraftRounds 与 legacy 三稿时间列 */
export function normalizeMeetingRounds(initiation: ProductInitiation): InitiationMeetingDraftRound[] {
  const count = Math.min(3, Math.max(1, initiation.meetingDraftCount ?? 1));
  const existing = initiation.meetingDraftRounds ?? [];
  return Array.from({ length: count }, (_, i) => {
    const round = i + 1;
    const hit = existing.find((r) => r.round === round);
    const legacyAt =
      round === 1 ? initiation.firstDraftMeetingAt
        : round === 2 ? initiation.secondDraftMeetingAt
          : initiation.thirdDraftMeetingAt;
    return {
      round,
      heldAt: hit?.heldAt ?? legacyAt ?? null,
      passed: hit?.passed ?? null,
      notes: hit?.notes ?? null,
    };
  });
}

export function toDatetimeLocalValue(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromDatetimeLocalValue(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

/** 展示立项记录的 Agent 评审得分 */
export function formatInitiationReviewScore(initiation: ProductInitiation): string {
  if (initiation.reviewScore != null) return `${initiation.reviewScore}/100`;
  const attempts = initiation.reviewAttempts ?? [];
  if (attempts.length === 0) return '-';
  const latest = [...attempts].sort((a, b) => b.attemptNo - a.attemptNo)[0];
  if (latest.reviewScore != null) return `${latest.reviewScore}/100`;
  return '-';
}

/** 需开线下评审会且仍有稿次未回填结论 */
export function isMeetingResultPending(initiation: ProductInitiation): boolean {
  if (!initiation.reviewMeetingRequired) return false;
  const rounds = normalizeMeetingRounds(initiation);
  return rounds.some((r) => r.passed == null);
}
