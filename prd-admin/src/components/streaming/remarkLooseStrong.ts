interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/** 模型常输出「**中文标签：**正文」或在闭合星号内留空格。
 * CommonMark 会把这类边界判为普通文本；仅修复尚未解析的、完整成对的粗体。
 * 只处理原始文本节点，代码、转义文本、HTML 与已有格式节点保持原语义。
 */
export function remarkLooseStrong() {
  return (tree: MarkdownNode, file: { value: unknown }) => {
    const source = String(file.value);
    const visit = (parent: MarkdownNode) => {
      if (!parent.children) return;
      parent.children = parent.children.flatMap((node) => {
        if (node.type !== 'text' || !node.value || node.position?.start.offset === undefined || node.position.end.offset === undefined) {
          visit(node);
          return [node];
        }
        // 解码后的实体/反斜杠转义不能被重新解释成格式标记。
        if (source.slice(node.position.start.offset, node.position.end.offset) !== node.value) return [node];
        const parts: MarkdownNode[] = [];
        const pattern = /(?<!\*)\*\*([^*\r\n]+?)\*\*(?!\*)/g;
        let offset = 0;
        for (const match of node.value.matchAll(pattern)) {
          const core = match[1].trim();
          if (!core) continue;
          if (match.index > offset) parts.push({ type: 'text', value: node.value.slice(offset, match.index) });
          const leading = match[1].match(/^\s*/)?.[0] ?? '';
          const trailing = match[1].match(/\s*$/)?.[0] ?? '';
          if (leading) parts.push({ type: 'text', value: leading });
          parts.push({ type: 'strong', children: [{ type: 'text', value: core }] });
          if (trailing) parts.push({ type: 'text', value: trailing });
          offset = match.index + match[0].length;
        }
        if (!parts.length) return [node];
        if (offset < node.value.length) parts.push({ type: 'text', value: node.value.slice(offset) });
        return parts;
      });
    };
    visit(tree);
  };
}
