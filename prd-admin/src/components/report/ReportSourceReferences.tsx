import { reportSourceHref } from './reportEvidenceLinks';

interface SourceItem {
  sourceRef?: string;
}

/** Existing opaque references remain readable; only explicit web URLs and same-origin paths become links. */
export function ReportSourceReferences({ items }: { items: readonly SourceItem[] }) {
  const references = items.flatMap((item, index) => item.sourceRef?.trim() ? [{ index, reference: item.sourceRef.trim() }] : []);
  if (references.length === 0) return null;

  return (
    <details className="mt-3 rounded-lg px-3 py-2" style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>
      <summary className="cursor-pointer text-[12px] font-medium">核查来源（{references.length}）</summary>
      <p className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>保留原始来源引用；正文手工改写后请再次核对。</p>
      <ul className="mt-2 space-y-2 text-[12px]">
        {references.map(({ index, reference }) => {
          const url = reportSourceHref(reference);
          return (
            <li key={index} className="flex items-start gap-2" style={{ overflowWrap: 'anywhere' }}>
              <span className="shrink-0" style={{ color: 'var(--text-muted)' }}>条目 {index + 1}</span>
              {url ? (
                <a href={url} target="_blank" rel="noopener noreferrer" className="min-w-0 underline" style={{ color: 'var(--accent-claude)' }}>{reference}</a>
              ) : <span className="min-w-0 font-mono">{reference}</span>}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
