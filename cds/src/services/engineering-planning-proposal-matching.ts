import type { PlanningDebt, PlanningDuplicateCandidate, PlanningProposal } from '../shared/engineering-planning.js';

const titleSimilarityThreshold = 0.8;
const sameAnchorSimilarityThreshold = 0.62;

export function proposalTitleKey(title: string): string {
  return title.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
}

export function debtTitleBigrams(title: string): Set<string> {
  const characters = Array.from(proposalTitleKey(title).replace(/[\p{P}\s]+/gu, ''));
  return new Set(characters.slice(1).map((character, index) => characters[index] + character));
}

export function titleSimilarity(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (!left.size || !right.size) return 0;
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  for (const bigram of smaller) if (larger.has(bigram)) shared++;
  return shared / (left.size + right.size - shared);
}

export function debtTitlesAreSimilar(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return titleSimilarity(left, right) >= titleSimilarityThreshold;
}

export function debtAnchorKey(debt: PlanningDebt): string | undefined {
  return debt.anchor && JSON.stringify([debt.anchor.type, debt.anchor.ref]);
}

export function debtsSimilarWithoutAnchor(left: PlanningDebt, right: PlanningDebt): boolean {
  const anchor = left.anchor;
  if (!anchor || anchor.type !== right.anchor?.type || anchor.ref !== right.anchor.ref) return false;
  const ref = proposalTitleKey(anchor.ref);
  const remaining = (debt: PlanningDebt) => debtTitleBigrams(proposalTitleKey(debt.title).split(ref).join(''));
  return titleSimilarity(remaining(left), remaining(right)) >= sameAnchorSimilarityThreshold;
}

export function explicitlyDistinct(left: PlanningDebt, right: PlanningDebt): boolean {
  return Boolean(left.notDuplicateWith?.includes(right.id) || right.notDuplicateWith?.includes(left.id));
}

export function findSimilarDebts(debts: Iterable<PlanningDebt>, title: string, options: {
  threshold?: number; base?: PlanningDebt; includeRepaid?: boolean;
} = {}): PlanningDuplicateCandidate[] {
  const key = proposalTitleKey(title);
  const grams = debtTitleBigrams(title);
  const rows: PlanningDuplicateCandidate[] = [];
  for (const debt of debts) {
    if (debt.status === 'dropped' || (!options.includeRepaid && debt.status === 'repaid')
      || (options.base && (options.base.id === debt.id || explicitlyDistinct(options.base, debt)))) continue;
    const similarity = key === proposalTitleKey(debt.title) ? 1 : titleSimilarity(grams, debtTitleBigrams(debt.title));
    if (similarity >= (options.threshold ?? titleSimilarityThreshold)
      || (options.threshold === undefined && options.base && debtsSimilarWithoutAnchor(options.base, debt))) {
      const { id, title, status, summary, owner, version } = debt;
      rows.push({ id, title, status, summary, owner, version, similarity });
    }
  }
  return rows.sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id));
}

export function duplicateDebtMatcher(debts: Iterable<PlanningDebt>) {
  type IndexedDebt = { debt: PlanningDebt; bigrams: Set<string> };
  const byBigram = new Map<string, IndexedDebt[]>();
  for (const debt of debts) {
    if (debt.status === 'repaid' || debt.status === 'dropped') continue;
    const entry = { debt, bigrams: debtTitleBigrams(debt.title) };
    for (const bigram of entry.bigrams) {
      const matching = byBigram.get(bigram);
      if (matching) matching.push(entry);
      else byBigram.set(bigram, [entry]);
    }
  }
  return (title: string): PlanningProposal['suggest'] => {
    const bigrams = debtTitleBigrams(title);
    const candidates = new Set<IndexedDebt>();
    for (const bigram of bigrams) {
      for (const entry of byBigram.get(bigram) ?? []) candidates.add(entry);
    }
    let best: PlanningDebt | undefined;
    let score = titleSimilarityThreshold;
    for (const { debt, bigrams: candidate } of candidates) {
      const similarity = titleSimilarity(bigrams, candidate);
      if (similarity < score) continue;
      if (similarity === score && best && (best.createdAt.localeCompare(debt.createdAt) || best.id.localeCompare(debt.id)) < 0) continue;
      best = debt;
      score = similarity;
    }
    return best && { dupOf: best.id, dupTitle: best.title };
  };
}

export function projectProposalSuggestion(proposal: PlanningProposal, match: ReturnType<typeof duplicateDebtMatcher>): PlanningProposal {
  if (proposal.status !== 'pending' || proposal.kind !== 'debt') return proposal;
  const suggest = match(proposal.draft.title);
  const { suggest: _, ...row } = proposal;
  return suggest ? { ...row, suggest } : row;
}
