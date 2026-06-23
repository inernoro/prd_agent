const evidenceLineLabels = new Set([
  '提交',
  'Commit',
  'commit',
  'PR',
  'Pull Request',
  '验收地址',
  '验收报告',
  '发布状态',
  '知识库',
  '预览地址',
  '发布版本',
  '修复说明',
  '证据链',
]);

export function linkifyBareUrls(line: string) {
  return line.replace(/(^|[\s（(])((?:https?:\/\/)[^\s)）]+)/g, (match, prefix: string, url: string, offset: number) => {
    const beforeUrl = line.slice(0, offset + prefix.length);
    if (beforeUrl.endsWith('](')) return match;

    const trailing = url.match(/[.,，。；;:：!?！？]+$/)?.[0] ?? '';
    const cleanUrl = trailing ? url.slice(0, -trailing.length) : url;
    if (!cleanUrl) return match;
    return `${prefix}[${cleanUrl}](${cleanUrl})${trailing}`;
  });
}

export function enhanceDefectMarkdown(content: string) {
  return content
    .split('\n')
    .map((line) => {
      const match = line.match(/^(\s*(?:[-*]\s+|\d+\.\s+)?)([^：:\n]{1,24})(\s*[：:])\s*(.*)$/);
      if (!match) return linkifyBareUrls(line);

      const [, indent, rawLabel, colon, rest] = match;
      const label = rawLabel.trim();
      if (!evidenceLineLabels.has(label)) return linkifyBareUrls(line);

      return `${indent}**${label}${colon.trim()}** ${linkifyBareUrls(rest)}`;
    })
    .join('\n');
}
