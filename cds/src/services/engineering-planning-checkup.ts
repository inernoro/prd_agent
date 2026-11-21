import { randomUUID } from 'node:crypto';
import type { PlanningCheckupNotice, PlanningDebt } from '../shared/engineering-planning.js';
import { debtAnchorKey, debtTitleBigrams, debtTitlesAreSimilar, debtsSimilarWithoutAnchor, explicitlyDistinct } from './engineering-planning-proposal-matching.js';

export type PlanningNoticeRecord = PlanningCheckupNotice & { recipientId: string };

export function createCheckupNotices(notice: Omit<PlanningCheckupNotice, 'id' | 'readAt'>, recipients: Array<string | undefined>) {
  return [...new Set(recipients)].flatMap(recipientId => recipientId
    ? [{ ...notice, id: `notice-${randomUUID()}`, recipientId }] : []);
}

export const planningDuplicateKey = (left: string, right: string) => JSON.stringify([left, right].sort());
const active = (debt: PlanningDebt) => debt.status !== 'repaid' && debt.status !== 'dropped';

export function duplicatePresentAtBaseline(left: PlanningDebt | undefined, right: PlanningDebt | undefined) {
  return Boolean(left && right && active(left) && active(right) && !explicitlyDistinct(left, right)
    && (debtTitlesAreSimilar(debtTitleBigrams(left.title), debtTitleBigrams(right.title)) || debtsSimilarWithoutAnchor(left, right)));
}

export function* checkupDuplicatePairs(debts: Iterable<PlanningDebt>): Generator<readonly [PlanningDebt, PlanningDebt]> {
  type Candidate = { debt: PlanningDebt; grams: ReadonlySet<string> };
  const byBigram = new Map<string, Candidate[]>();
  const byAnchor = new Map<string, Candidate[]>();
  for (const debt of debts) {
    if (!active(debt)) continue;
    const grams = debtTitleBigrams(debt.title);
    const candidate = { debt, grams };
    const anchor = debtAnchorKey(debt);
    const similar = new Set<Candidate>(anchor ? byAnchor.get(anchor) : undefined);
    for (const gram of grams) {
      const entries = byBigram.get(gram) ?? [];
      for (const previous of entries) similar.add(previous);
      entries.push(candidate);
      byBigram.set(gram, entries);
    }
    for (const previous of similar) {
      if (!explicitlyDistinct(previous.debt, debt)
        && (debtTitlesAreSimilar(previous.grams, grams) || debtsSimilarWithoutAnchor(previous.debt, debt))) yield [previous.debt, debt];
    }
    if (anchor) {
      const entries = byAnchor.get(anchor) ?? [];
      entries.push(candidate);
      byAnchor.set(anchor, entries);
    }
  }
}
