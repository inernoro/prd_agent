export type ReleaseTapdLink = { title: string; url: string };

export function isTapdUrl(value: string) {
  try {
    if (!/^https?:\/\//i.test(value.trim()) || /\s/.test(value.trim())) return false;
    const url = new URL(value.trim());
    return !url.username && !url.password && (url.hostname === 'tapd.cn' || url.hostname.endsWith('.tapd.cn'));
  } catch {
    return false;
  }
}

export function parseReleaseTapdLinks(text: string): ReleaseTapdLink[] {
  return extractReleaseTapdLinks(text).links;
}

export function extractReleaseTapdLinks(text: string) {
  const urls = new Set<string>();
  const remainingText = text.replace(/https?:\/\/[^\s<>()[\]{}"'“”‘’（）【】《》。，；、！？：]+/gi, (match) => {
    const url = match.replace(/[.,;!]+$/, '');
    if (!isTapdUrl(url)) return match;
    urls.add(url);
    return match.slice(url.length);
  });
  return { text: remainingText, links: [...urls].map((url) => ({ title: '', url })) };
}

export function appendReleaseTapdLinks(current: ReleaseTapdLink[], recognized: ReleaseTapdLink[]) {
  const rows = current.filter((link) => link.url.trim());
  const existing = new Set(rows.map((link) => link.url.trim()));
  return [...rows, ...recognized.filter((link) => !existing.has(link.url))];
}

export function invalidReleaseTapdLinks(noLinks: boolean, links: ReleaseTapdLink[]) {
  return !noLinks && (!links.length || links.some((link) => !isTapdUrl(link.url)));
}
