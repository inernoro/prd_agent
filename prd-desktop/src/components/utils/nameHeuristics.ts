export function stripFileExtension(fileName: string): string {
  const s = (fileName || '').trim();
  if (!s) return '';
  return s.replace(/\.[a-z0-9]+$/i, '');
}

export function normalizeCandidateName(raw: string): string {
  const s = (raw || '').trim();
  if (!s) return '';
  // 统一分隔符为单空格，避免“__---”这种看起来像乱码
  return s
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isMeaninglessName(raw: string): boolean {
  const s = normalizeCandidateName(stripFileExtension(raw));
  if (!s) return true;

  // 去掉常见“无意义文件名”后缀/前缀
  const cleaned = s
    .replace(/\b(final|v\d+|version|copy)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return true;

  // 纯数字/纯符号
  if (/^[\d\s]+$/.test(cleaned)) return true;
  if (/^[\W_]+$/.test(cleaned)) return true;

  // 类似哈希/短 ID
  if (/^[a-f0-9]{8,}$/i.test(cleaned)) return true;

  // 太短（1-2个字符通常不可靠）
  if (cleaned.length <= 2) return true;

  // 至少包含中文或字母，才认为“有意义”
  const hasCjk = /[\u4e00-\u9fa5]/.test(cleaned);
  const hasLetter = /[a-z]/i.test(cleaned);
  return !(hasCjk || hasLetter);
}

export function extractSnippetFromContent(content: string, opts?: { maxLines?: number; maxChars?: number }): string {
  const maxLines = opts?.maxLines ?? 20;
  const maxChars = opts?.maxChars ?? 1200;
  const s = (content || '').replace(/\r\n/g, '\n');
  if (!s.trim()) return '';
  const lines = s.split('\n');
  const picked: string[] = [];
  for (const line of lines) {
    if (picked.length >= maxLines) break;
    // 保留空行会影响意图模型判断，略过连续空白
    if (!line.trim() && picked.length === 0) continue;
    picked.push(line);
  }
  return picked.join('\n').slice(0, maxChars);
}

export function extractMarkdownTitle(content: string): string {
  const s = (content || '').replace(/\r\n/g, '\n');
  const m = s.match(/^#\s+(.+)\s*$/m);
  return (m?.[1] || '').trim();
}


