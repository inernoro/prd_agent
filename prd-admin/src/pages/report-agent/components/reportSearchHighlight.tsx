import type { ReactNode } from 'react';

function escapeKeyword(keyword: string): string {
  return keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function containsKeyword(text: string | null | undefined, keyword: string): boolean {
  if (!text || !keyword.trim()) return false;
  return text.toLowerCase().includes(keyword.trim().toLowerCase());
}

export function renderHighlightedText(text: string | null | undefined, keyword: string): ReactNode {
  if (!text) return '';
  const normalizedKeyword = keyword.trim();
  if (!normalizedKeyword) return text;

  const parts = text.split(new RegExp(`(${escapeKeyword(normalizedKeyword)})`, 'ig'));
  return (
    <>
      {parts.map((part, index) => {
        const matched = part.toLowerCase() === normalizedKeyword.toLowerCase();
        return matched ? (
          <span
            key={`${part}-${index}`}
            style={{
              background: 'rgba(99, 102, 241, 0.18)',
              color: 'var(--text-primary)',
              borderRadius: 4,
              padding: '0 2px',
            }}
          >
            {part}
          </span>
        ) : (
          <span key={`${part}-${index}`}>{part}</span>
        );
      })}
    </>
  );
}

export function buildKeywordSnippet(
  text: string | null | undefined,
  keyword: string,
  contextLength = 22,
): string | null {
  if (!text) return null;
  const normalizedKeyword = keyword.trim().toLowerCase();
  if (!normalizedKeyword) return null;

  const compact = text.replace(/\s+/g, ' ').trim();
  const hitIndex = compact.toLowerCase().indexOf(normalizedKeyword);
  if (hitIndex < 0) return null;

  const start = Math.max(0, hitIndex - contextLength);
  const end = Math.min(compact.length, hitIndex + normalizedKeyword.length + contextLength);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < compact.length ? '...' : '';
  return `${prefix}${compact.slice(start, end)}${suffix}`;
}
