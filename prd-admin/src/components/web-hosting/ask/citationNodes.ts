export interface CitationNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: CitationNode[];
}

export function excerptText(node: CitationNode): string {
  if (node.properties?.dataFootnoteBackref !== undefined) return '';
  if (node.type === 'text') return node.value ?? '';
  if (node.tagName === 'br') return '\n';
  const text = node.children?.map(excerptText).join('') ?? '';
  return text + (['p', 'li', 'blockquote'].includes(node.tagName ?? '') ? '\n' : '');
}

export function compactExcerpt(text: string): string {
  const characters = Array.from(text.replace(/\s+/g, ' ').trim());
  return characters.length > 160 ? `${characters.slice(0, 160).join('')}…` : characters.join('');
}

export function backReferences(node: CitationNode): string[] {
  if (node.properties?.dataFootnoteBackref !== undefined && typeof node.properties.href === 'string') return [node.properties.href];
  return node.children?.flatMap(backReferences) ?? [];
}

export function citationReferences(node: CitationNode) {
  if (node.tagName !== 'sup') return [];
  return (node.children ?? []).filter((child) => child.tagName === 'a' && child.properties?.dataFootnoteRef !== undefined)
    .flatMap((child) => typeof child.properties?.href === 'string' && typeof child.properties.id === 'string'
      ? [{ href: child.properties.href, id: child.properties.id, label: excerptText(child) }] : []);
}

/** 在清洗后的语法树上索引原文，合并相邻引用；不改写回答或引用内容。 */
export function rehypeAskCitations({ notes }: { notes: Map<string, string> }) {
  return (tree: CitationNode) => {
    notes.clear();
    const visit = (node: CitationNode) => {
      if (node.tagName === 'section' && node.properties?.dataFootnotes !== undefined) {
        const list = node.children?.find((child) => child.tagName === 'ol');
        for (const item of list?.children ?? []) {
          if (item.tagName === 'li' && typeof item.properties?.id === 'string') notes.set(item.properties.id, excerptText(item).trim());
        }
      }
      const children = node.children;
      if (!children) return;
      for (let i = 0; i < children.length; i++) {
        const current = children[i];
        if (citationReferences(current).length) {
          let next = i + 1;
          while (next < children.length) {
            const separator = children[next];
            const hasSpace = separator.type === 'text' && /^\s*$/.test(separator.value ?? '');
            const target = children[next + (hasSpace ? 1 : 0)];
            if (!target || !citationReferences(target).length) break;
            current.children!.push(...target.children!);
            children.splice(next, hasSpace ? 2 : 1);
            next = i + 1;
          }
        }
        visit(current);
      }
    };
    visit(tree);
  };
}
