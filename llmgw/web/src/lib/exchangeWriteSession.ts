import type { ExchangeItem } from './types';

export type ExchangeWriteSession = Readonly<{
  token: number;
  scope: string;
  phase: 'submitting' | 'unknown';
  label: string;
  secret: boolean;
  targetId?: string;
  targetName?: string;
  matches?: (items: ExchangeItem[]) => boolean;
}>;
// One unresolved task in memory. Never put a key, password, body or credential in this record.
let current: ExchangeWriteSession | null = null;
let sequence = 0;
let activeScope: string | null = null;
const listeners = new Set<() => void>();
const warnBeforeReload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
function publish() {
  if (typeof window !== 'undefined') {
    window.removeEventListener('beforeunload', warnBeforeReload);
    if (current) window.addEventListener('beforeunload', warnBeforeReload);
  }
  listeners.forEach(listener => listener());
}
export function readExchangeWriteSession(scope: string) { return current?.scope === scope ? current : null; }
export function subscribeExchangeWriteSession(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function bindExchangeWriteScope(scope: string | null) {
  if (activeScope === scope) return;
  current = null; activeScope = scope; ++sequence; publish();
}
export function beginExchangeWriteSession(scope: string, task: Omit<ExchangeWriteSession, 'scope' | 'token' | 'phase'>) {
  // Route remounts must not turn an unresolved operation into a fresh writable form.
  if (scope !== activeScope || current) return null;
  const token = ++sequence; current = { ...task, scope, token, phase: 'submitting' }; publish(); return token;
}
export function markExchangeWriteUncertain(scope: string, token: number | null) {
  if (!current || current.scope !== scope || current.token !== token) return;
  current = { ...current, phase: 'unknown' }; publish();
}
export function finishExchangeWriteSession(scope: string, token: number | null) {
  if (!current || current.scope !== scope || current.token !== token) return;
  current = null; publish();
}
export function clearExchangeWriteSession() { activeScope = null; current = null; ++sequence; publish(); }
