/** 只影响流式展示；最终引用完全以服务端校验后返回的 done.text 为准。 */
export function askStreamingText(text: string): string {
  const visible = text.replace(/\[引用:[^\]\r\n]*\]/g, '');
  const start = visible.lastIndexOf('[');
  if (start < 0) return visible;
  const suffix = visible.slice(start);
  // SSE 可能在引用协议标记中的任意字符处分包，暂存半截标记直到后续内容到达。
  if ('[引用:'.startsWith(suffix) || (suffix.startsWith('[引用:') && !/[\]\r\n]/.test(suffix))) {
    return visible.slice(0, start);
  }
  return visible;
}
