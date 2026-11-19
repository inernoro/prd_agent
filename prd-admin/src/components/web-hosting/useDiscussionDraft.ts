import { useState } from 'react';

type Draft = { text: string; clientId?: string; error?: string };
const empty: Draft = { text: '' };

function readDraft(key?: string): Draft {
  if (!key) return empty;
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (saved && typeof saved === 'object' && 'text' in saved && typeof saved.text === 'string') {
      const clientId = 'clientId' in saved && typeof saved.clientId === 'string' ? saved.clientId : undefined;
      return { text: saved.text.slice(0, 2000), clientId };
    }
  } catch { /* Storage restrictions do not disable the local composer. */ }
  return empty;
}

export function useDiscussionDraft(scope: string, storageKey?: string) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const draft = drafts[scope] ?? readDraft(storageKey);

  function update(next: Draft) {
    setDrafts(previous => ({ ...previous, [scope]: next }));
    if (!storageKey) return;
    try {
      if (next.text) sessionStorage.setItem(storageKey, JSON.stringify({ text: next.text, clientId: next.clientId }));
      else sessionStorage.removeItem(storageKey);
    } catch { /* In-memory drafts remain available. */ }
  }

  return { draft, update };
}
