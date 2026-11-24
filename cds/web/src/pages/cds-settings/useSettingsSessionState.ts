import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { ConsoleAuthContext } from '@/lib/consoleAuthContext';
import { consoleAccountIdentity } from '@/lib/consoleIdentity';

// Secrets and unresolved work stay only in the current authenticated browser session.
// A new authentication payload has a new weak owner, including a same-name different account.
const sessions = new WeakMap<object, Map<string, { value: unknown; expiresAt: number; protectReload: boolean; keepSession: boolean; expireTo?: (value: unknown) => unknown }>>();
const listeners = new WeakMap<object, Map<string, Set<(value: unknown) => void>>>();
const TTL = 30 * 60_000;
const LIMIT = 128;
let activeOwner: object | null = null;
if (typeof window !== 'undefined') window.addEventListener('beforeunload', event => {
  const entries = activeOwner ? sessions.get(activeOwner) : undefined;
  if (!entries || ![...entries.values()].some(entry => entry.protectReload && (entry.keepSession || Boolean(entry.expireTo) || entry.expiresAt > Date.now()))) return;
  event.preventDefault(); event.returnValue = '';
});
export function useSettingsSessionOwner(): object | null {
  const { status } = useContext(ConsoleAuthContext);
  const owner = consoleAccountIdentity(status) ? status?.user || status : null;
  useLayoutEffect(() => { activeOwner = owner; }, [owner]);
  return owner;
}
function read<T>(owner: object | null, key: string, initial: T): T {
  if (!owner) return initial;
  const entries = sessions.get(owner), entry = entries?.get(key);
  if (!entry) return initial;
  if (entry.expiresAt <= Date.now() && !entry.keepSession) {
    if (entry.expireTo) {
      const value = entry.expireTo(entry.value);
      entries?.set(key, { ...entry, value, protectReload: entry.protectReload && Boolean(value), keepSession: true, expiresAt: Infinity });
      return value as T;
    }
    entries?.delete(key); return initial;
  }
  return entry.value as T;
}
function write<T>(owner: object | null, key: string, value: T, protectReload: boolean, options?: { keepSession?: boolean; expireTo?: (value: T) => T }): void {
  if (!owner) return;
  let entries = sessions.get(owner);
  if (!entries) { entries = new Map(); sessions.set(owner, entries); }
  entries.delete(key); entries.set(key, { value, expiresAt: Date.now() + TTL, protectReload, keepSession: options?.keepSession ?? (protectReload && !options?.expireTo), expireTo: options?.expireTo as ((value: unknown) => unknown) | undefined });
  while (entries.size > LIMIT) {
    const candidate = [...entries].find(([, entry]) => !entry.protectReload && !entry.keepSession);
    if (!candidate) break; // Critical metadata is bounded by fixed fields and the template write limit, never silently evicted.
    entries.delete(candidate[0]);
  }
  listeners.get(owner)?.get(key)?.forEach(listener => listener(value));
}

export function countProtectedSettingsEntries(owner: object | null, prefix: string): number {
  return owner ? [...(sessions.get(owner)?.entries() || [])].filter(([key, entry]) => key.startsWith(prefix) && entry.protectReload).length : 0;
}

/** A settings draft/receipt, isolated before render and retained through normal tab/route unmounts. */
export function useSettingsSessionState<T>(key: string, initial: T, protectReload?: (value: T) => boolean, options?: { keepSession?: boolean; expireTo?: (value: T) => T }): [T, Dispatch<SetStateAction<T>>] {
  const owner = useSettingsSessionOwner();
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const initialValue = useRef(initial);
  const protection = useRef(protectReload); protection.current = protectReload;
  const retention = useRef(options); retention.current = options;
  const [scoped, setScoped] = useState(() => ({ owner, key, value: read(owner, key, initialValue.current) }));
  const visible = scoped.owner === owner && scoped.key === key ? scoped : { owner, key, value: read(owner, key, initialValue.current) };
  const latest = useRef(visible); latest.current = visible;
  useEffect(() => {
    if (scoped.owner !== owner || scoped.key !== key) setScoped({ owner, key, value: read(owner, key, initialValue.current) });
  }, [owner, key, scoped.owner, scoped.key]);
  useLayoutEffect(() => {
    if (!owner) return;
    let channels = listeners.get(owner);
    if (!channels) { channels = new Map(); listeners.set(owner, channels); }
    let channel = channels.get(key);
    if (!channel) { channel = new Set(); channels.set(key, channel); }
    const listener = (value: unknown) => {
      if (latest.current.owner !== owner || latest.current.key !== key) return;
      const next = { owner, key, value: value as T };
      latest.current = next; setScoped(next);
    };
    channel.add(listener);
    return () => { channel.delete(listener); if (channel.size === 0) channels.delete(key); };
  }, [owner, key]);
  const setValue: Dispatch<SetStateAction<T>> = useCallback(update => {
    const current = mounted.current && latest.current.owner === owner && latest.current.key === key ? latest.current.value : read(owner, key, initialValue.current);
    const next = typeof update === 'function' ? (update as (value: T) => T)(current) : update;
    const value = { owner, key, value: next };
    latest.current = value; write(owner, key, next, protection.current?.(next) ?? false, retention.current); setScoped(value);
  }, [owner, key]);
  return [visible.value, setValue];
}
