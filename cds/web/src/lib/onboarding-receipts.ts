// UI-only receipt dismissal. Server approval and project permissions remain authoritative.
export interface OnboardingReceipt {
  id: string;
  createdProject?: { id: string; name: string };
}

const DISMISSED_KEY = 'cds:onboarding-receipts:dismissed:v1';
export const RECEIPT_DISMISS_EVENT = 'cds:onboarding-receipt-dismissed';

function receiptStorage(): Storage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.sessionStorage; } catch { return undefined; }
}

export function readDismissedReceipts(storage: Pick<Storage, 'getItem'> | undefined = receiptStorage()): string[] {
  try {
    const values: unknown = JSON.parse(storage?.getItem(DISMISSED_KEY) || '[]');
    return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string').slice(-50) : [];
  } catch { return []; }
}

export function writeDismissedReceipt(id: string, storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = receiptStorage()): string[] {
  const next = [...new Set([...readDismissedReceipts(storage), id])].slice(-50);
  try { storage?.setItem(DISMISSED_KEY, JSON.stringify(next)); } catch { /* UI preference remains usable in memory. */ }
  return next;
}

export function receiptProjectId(location: { pathname: string; search: string }): string {
  const query = new URLSearchParams(location.search);
  const project = query.get('project') || query.get('projectId');
  if (project) return project;
  const match = location.pathname.match(/^\/(?:branches|settings|agent-requests)\/([^/]+)(?:\/|$)/);
  if (!match) return '';
  try { return decodeURIComponent(match[1]); } catch { return ''; }
}

export function receiptBelongsOnPage(receipt: OnboardingReceipt, projectId: string, placement: 'inline' | 'floating'): boolean {
  // Active creation stays visible globally. Completed receipts stay in the
  // information center; another project's page must not carry their floating card.
  return placement === 'inline' || !receipt.createdProject || !projectId || receipt.createdProject.id === projectId;
}
