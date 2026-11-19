/** Session-only writing aid, scoped to the authenticated tenant and account. Never stores a key or model verdict. */
const prefix = 'llmgw.quickstart.intent.v1:';
export type QuickstartDraft = { intent: string; updatedAt: number };
export function quickstartDraftScope(tenant?: string, username?: string) {
  return tenant && username ? prefix + JSON.stringify([tenant, username]) : null;
}
export function readQuickstartDraft(scope: string | null): QuickstartDraft | null {
  if (!scope) return null;
  try {
    const draft = JSON.parse(sessionStorage.getItem(scope) || 'null');
    if (typeof draft?.intent !== 'string' || draft.intent.trim().length < 4 || draft.intent.length > 500 || !Number.isFinite(draft.updatedAt) || Date.now() - draft.updatedAt > 86400000 || draft.updatedAt > Date.now()) return null;
    return { intent: draft.intent, updatedAt: draft.updatedAt };
  } catch { return null; }
}
export function saveQuickstartDraft(scope: string | null, intent: string) {
  if (!scope || intent.trim().length < 4 || intent.length > 500) return;
  try { sessionStorage.setItem(scope, JSON.stringify({ intent: intent.trim(), updatedAt: Date.now() })); } catch { /* Storage restrictions must not interrupt access. */ }
}
export function clearQuickstartDraft(scope: string | null) {
  if (scope) try { sessionStorage.removeItem(scope); } catch { /* Session storage can be disabled. */ }
}
