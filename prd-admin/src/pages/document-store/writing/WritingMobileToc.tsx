import { useId, useLayoutEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';

export function WritingMobileToc({ sections, visited, onGo, disabled = false }: {
  sections: { id: string; title: string }[];
  visited: string[];
  onGo: (id: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string>();
  const id = useId();
  useLayoutEffect(() => {
    if (!pending) return;
    if (!disabled) onGo(pending);
    setPending(undefined);
  }, [pending, disabled, onGo]);
  if (!sections.length) return null;
  const read = new Set(visited.filter(id => sections.some(section => section.id === id)));
  return <nav className="writing-mobile-toc" aria-label="本文目录">
    <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      <span>本文目录 · 已读 {read.size} / {sections.length} 节</span><ChevronDown size={14} />
    </button>
    {open && <div id={id}>{sections.map((section, index) => <button type="button" key={section.id} data-section-link={section.id} disabled={disabled} aria-disabled={disabled} onClick={() => { setOpen(false); setPending(section.id); }}>
      <span className="mono">{String(index + 1).padStart(2, '0')}</span><span>{section.title}{read.has(section.id) && <span className="tag t-o">已读</span>}</span>
    </button>)}</div>}
  </nav>;
}
