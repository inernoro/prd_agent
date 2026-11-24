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

const citationBlocks = new Set(['p', 'li', 'td', 'th']);
const nestedBlocks = new Set(['p', 'ol', 'ul', 'blockquote', 'pre', 'table', 'div']);

function groupBlockCitations(node: CitationNode) {
  const children = node.children;
  if (!children) return;
  const references: CitationNode[] = [];
  const collect = (items: CitationNode[]): CitationNode[] => items.filter((item) => {
    if (citationReferences(item).length) {
      references.push(...(item.children ?? []));
      return false;
    }
    if (item.children && !nestedBlocks.has(item.tagName ?? '') && item.tagName !== 'a') {
      item.children = collect(item.children);
    }
    return true;
  });

  const remainder = collect(children);
  if (!references.length) return;
  // 紧凑列表的正文是 li 的直接子节点；把引用放在下级列表之前，避免归错段落。
  const nestedList = remainder.findIndex((item) => item.tagName === 'ul' || item.tagName === 'ol');
  remainder.splice(nestedList === -1 ? remainder.length : nestedList, 0, {
    type: 'element', tagName: 'sup', properties: {}, children: references,
  });
  node.children = remainder;
}

/** 对完成答案按段归并引用，原文索引和每处返回链接都保留。 */
export function rehypeAskCitations({ notes }: { notes: Map<string, string> }) {
  return (tree: CitationNode) => {
    notes.clear();
    const visit = (node: CitationNode) => {
      if (node.tagName === 'section' && node.properties?.dataFootnotes !== undefined) {
        const list = node.children?.find((child) => child.tagName === 'ol');
        for (const item of list?.children ?? []) {
          if (item.tagName === 'li' && typeof item.properties?.id === 'string') notes.set(item.properties.id, excerptText(item).trim());
        }
        return;
      }
      if (citationBlocks.has(node.tagName ?? '')) groupBlockCitations(node);
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
