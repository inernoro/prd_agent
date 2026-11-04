import { useState, type ReactNode } from 'react';
import { CornerUpLeft } from 'lucide-react';

interface CitationNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: CitationNode[];
}

function excerptText(node: CitationNode): string {
  if (node.properties?.dataFootnoteBackref !== undefined) return '';
  if (node.type === 'text') return node.value ?? '';
  if (node.tagName === 'br') return '\n';
  const text = node.children?.map(excerptText).join('') ?? '';
  return text + (['p', 'li', 'blockquote'].includes(node.tagName ?? '') ? '\n' : '');
}

function backReferences(node: CitationNode): string[] {
  if (node.properties?.dataFootnoteBackref !== undefined && typeof node.properties.href === 'string') return [node.properties.href];
  return node.children?.flatMap(backReferences) ?? [];
}

/** 摘录只压缩展示，不改写或丢弃保存的原文；完整片段按需查看。 */
export function AskCitationNote({ id, node, children, prefix, onNavigate }: {
  id: string;
  node: CitationNode;
  children: ReactNode;
  prefix: string;
  onNavigate: (href: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const excerpt = excerptText(node).replace(/\s+/g, ' ').trim();
  const characters = Array.from(excerpt);
  const preview = characters.length > 160 ? `${characters.slice(0, 160).join('')}…` : excerpt;
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
