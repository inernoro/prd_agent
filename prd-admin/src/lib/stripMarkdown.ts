/**
 * 把 LLM 输出的 Markdown 标记清理为正常纯文本（不显示井号、星号、竖线表格等记号）。
 * 用于产品管理智能体 AI助手 / 关系分析等「直接渲染为正常文本」的场景。
 */
export function stripMarkdown(s: string): string {
  return s
    // 代码块围栏 ```lang
    .replace(/```[a-zA-Z0-9]*\n?/g, '')
    // 行内代码 `x`
    .replace(/`([^`]+)`/g, '$1')
    // 标题 ###
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    // 引用 >
    .replace(/^\s{0,3}>\s?/gm, '')
    // 粗体 / 斜体
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    // 表格分隔行 |---|:--:|
    .replace(/^\s*\|?[\s:|-]+\|\s*[\s:|-]*$/gm, '')
    // 表格数据行 | a | b | → a    b
    .replace(/^\s*\|(.+)\|\s*$/gm, (_m, inner: string) =>
      inner.split('|').map((c) => c.trim()).filter(Boolean).join('    '),
    )
    // 列表标记 - / * → ·
    .replace(/^\s{0,3}[-*]\s+/gm, '· ')
    // 链接 [text](url) → text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // 压缩 3+ 空行
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}
