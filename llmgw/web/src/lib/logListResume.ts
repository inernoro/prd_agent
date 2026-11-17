import type { LlmLogListItem } from './types';
// Only list summaries live briefly in this tab. Payloads and credentials never enter this cache.
type Snapshot = { key: string; rows: LlmLogListItem[]; total: number; page: number; scrollTop: number; at: number };
let snapshot: Snapshot | null = null;
export function clearLogListResume() { snapshot = null; }
export function saveLogListResume(value: Omit<Snapshot, 'at'>) { snapshot = { ...value, at: Date.now() }; }
export function readLogListResume(key: string) {
  if (!snapshot || snapshot.key !== key || Date.now() - snapshot.at > 5 * 60_000) return null;
  return snapshot;
}
