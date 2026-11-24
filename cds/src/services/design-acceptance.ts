export type DesignCellStatus = 'passed' | 'failed' | 'missing' | 'unverified';
export type DesignVerdict = 'passed' | 'conditional' | 'needs_evidence' | 'failed';

export interface DesignAcceptanceRow {
  id: string;
  priority: 'high' | 'normal';
  cells: Array<{ applicable: boolean; status: DesignCellStatus; debtId?: string }>;
}

/** The caller resolves every debt reference against the current project's formal ledger. */
export function evaluateDesignAcceptance(rows: DesignAcceptanceRow[]): DesignVerdict {
  let observed = false;
  let needsEvidence = false;
  let hasDebt = false;
  for (const row of rows) {
    for (const cell of row.cells) {
      if (!cell.applicable) continue;
      observed = true;
      if (cell.status === 'passed') continue;
      const covered = Boolean(cell.debtId?.trim());
      if (cell.status === 'failed' && (row.priority === 'high' || !covered)) return 'failed';
      if (covered) hasDebt = true;
      else needsEvidence = true;
    }
  }
  if (!observed || needsEvidence) return 'needs_evidence';
  return hasDebt ? 'conditional' : 'passed';
}
