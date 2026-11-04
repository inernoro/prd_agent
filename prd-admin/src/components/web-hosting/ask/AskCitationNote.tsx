import { useState, type ReactNode } from 'react';
import { CornerUpLeft } from 'lucide-react';

import { excerptText, compactExcerpt, backReferences, type CitationNode } from './citationNodes';

/** 摘录只压缩展示，不改写或丢弃保存的原文；完整片段按需查看。 */
export function AskCitationNote({ id, node, children, prefix, onNavigate }: {
  id: string;
  node: CitationNode;
  children: ReactNode;
  prefix: string;
  onNavigate: (href: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const preview = compactExcerpt(excerptText(node));
  const backlinks = backReferences(node).filter((href) => href.startsWith(`#${prefix}fnref-`));
  return <li id={id} tabIndex={-1} className="ask-citation-note">
    <div className="ask-citation-preview" hidden={expanded}>{preview}</div>
    <div id={`${id}-excerpt`} className="ask-citation-full" hidden={!expanded}>{children}</div>
    <div className="ask-citation-actions">
      <button type="button" aria-expanded={expanded} aria-controls={`${id}-excerpt`} onClick={() => setExpanded((value) => !value)}>
        {expanded ? '收起片段' : '展开片段'}
      </button>
      {backlinks.map((href, index) => <a key={href} href={href} aria-label={index ? `返回正文第 ${index + 1} 处引用` : '返回正文'}
        title={index ? `返回正文第 ${index + 1} 处引用` : '返回正文'} onClick={(event) => { event.preventDefault(); onNavigate(href); }}>
        <CornerUpLeft size={12} aria-hidden="true" />{index > 0 && <span>{index + 1}</span>}
      </a>)}
    </div>
  </li>;
}
