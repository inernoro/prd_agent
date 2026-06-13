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
