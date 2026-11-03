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
  const links: ReleaseTapdLink[] = [];
  let previousEnd = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>()【】。，；、]+/gi)) {
    const preceding = text.slice(previousEnd, match.index).split(/\r?\n/).map((line) => line.trim())
      .filter((line) => line && !line.startsWith('@') && !/^(?:需求来源|TAPD\s*链接)\s*[:：]$/i.test(line));
    previousEnd = match.index + match[0].length;
    const url = match[0].replace(/[.,;]+$/, '');
    if (!isTapdUrl(url)) continue;
    const title = (preceding[preceding.length - 1] ?? '').replace(/^[-*•]\s+/, '')
      .replace(/^\[(.*)\]\($/, '$1').replace(/^【(.*)】$/, '$1');
    links.push({ title: /^[)）]+$/.test(title) ? '' : title, url });
  }
  return [...new Map(links.map((link) => [link.url, link])).values()];
}
