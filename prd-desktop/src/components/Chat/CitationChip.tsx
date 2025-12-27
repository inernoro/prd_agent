import type { DocCitation } from '../../types';

export type CitationChipProps = {
  citations: DocCitation[];
  matchedIndices: number[];
  onOpen: (citationIdx: number) => void;
};

function oneLine(s: string) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

export default function CitationChip({ citations, matchedIndices, onOpen }: CitationChipProps) {
  const indices = Array.isArray(matchedIndices) ? matchedIndices.filter((n) => Number.isFinite(n)) : [];
  if (!Array.isArray(citations) || citations.length === 0) return null;
  if (indices.length === 0) return null;

  const firstIdx = Math.max(0, Math.min(citations.length - 1, indices[0]));
  const items = indices
    .map((i) => Math.max(0, Math.min(citations.length - 1, i)))
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .slice(0, 3);

  const first = citations[firstIdx];
  const title = oneLine(first?.headingTitle || '') || '来源';
  const more = Math.max(0, indices.length - 1);

  return (
    <span className="relative inline-flex align-middle group ml-2">
      <button
        type="button"
        className="inline-flex items-center gap-1 max-w-[260px] rounded-full px-2 py-0.5 text-[11px] leading-5 border border-border bg-background-light/40 dark:bg-background-dark/30 text-text-secondary hover:text-primary-600 dark:hover:text-primary-300 hover:bg-gray-50 dark:hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-primary-400/40"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onOpen(firstIdx);
        }}
        title={undefined}
      >
        <span className="truncate max-w-[180px]">{title}</span>
        {more > 0 ? <span className="opacity-80">+{more}</span> : null}
      </button>

      <div className="pointer-events-none absolute z-30 left-1/2 -translate-x-1/2 bottom-full mb-2 hidden group-hover:block group-focus-within:block">
        <div className="w-[360px] max-w-[70vw] rounded-lg border border-border bg-surface-light/95 dark:bg-surface-dark/95 shadow-xl px-3 py-2 text-xs text-text-primary">
          <div className="space-y-2">
            {items.map((idx) => {
              const c = citations[idx];
              const ht = oneLine(c?.headingTitle || '');
              const ex = oneLine(c?.excerpt || '');
              return (
                <div key={idx} className="min-w-0">
                  <div className="font-medium truncate">{ht || `引用 ${idx + 1}`}</div>
                  {ex ? <div className="opacity-85 line-clamp-3 whitespace-pre-wrap break-words">{ex}</div> : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </span>
  );
}


