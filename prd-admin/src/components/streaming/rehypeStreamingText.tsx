import type { Components, ExtraProps } from 'react-markdown';
import { StreamingText } from './StreamingText';

type Element = NonNullable<ExtraProps['node']>;
type Tree = { children: Element['children'] };

/** Markdown 的文本节点接入现有 StreamingText，复用分词、blur 动效和品牌光标。
 * 在 sanitize 之后运行；只构造受控 span，不开启模型输出的 raw HTML。
 * 调用方须保持 components 的身份稳定，否则每个 chunk 都会重播旧文字动画。
 */
export function rehypeStreamingText({ streaming = false }: { streaming?: boolean } = {}) {
  return (tree: Tree) => {
    if (!streaming) return;
    const walk = (parent: Tree | Element) => {
      parent.children = parent.children.map((child): Element['children'][number] => {
        if (child.type === 'text' && child.value.trim()) {
          return { type: 'element', tagName: 'span', properties: { dataStreamingText: true }, children: [child] };
        }
        if (child.type === 'element' && !['pre', 'code', 'kbd', 'sup'].includes(child.tagName)
          && child.properties.dataFootnotes === undefined) walk(child);
        return child;
      });
    };
    walk(tree);
    const caret: Element = { type: 'element', tagName: 'span', properties: { dataStreamingCursor: true }, children: [] };
    // 沿最后一个块找到正文行尾；停在代码块时放在代码之后，不能回退到前文。
    let target: Tree | Element = tree;
    const containers = ['p', 'li', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'table', 'thead', 'tbody', 'tr'];
    while (true) {
      const last = target.children.filter((child) => child.type !== 'text' || child.value.trim()).at(-1);
      if (last?.type !== 'element' || !containers.includes(last.tagName)) break;
      target = last;
    }
    target.children.push('type' in target && target.type === 'element'
      ? caret
      : { type: 'element', tagName: 'p', properties: {}, children: [caret] });
  };
}

/** 固定组件身份保证已输出词的 DOM 在后续 chunk 中保留，不重播动画。 */
export const StreamingMarkdownSpan: Components['span'] = ({ node, children, ...props }) => {
  if (node?.properties.dataStreamingCursor !== undefined) return <StreamingText text="" streaming />;
  if (node?.properties.dataStreamingText !== undefined) {
    const text = node.children.map((child) => child.type === 'text' ? child.value : '').join('');
    return <StreamingText text={text} streaming cursor={false} animateTailChars={320} />;
  }
  return <span {...props}>{children}</span>;
};
