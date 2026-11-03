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
  const urls = Array.from(text.matchAll(/https?:\/\/[^\s<>()【】。，；、]+/gi),
    (match) => match[0].replace(/[.,;]+$/, ''));
  return [...new Set(urls.filter(isTapdUrl))].map((url) => ({ title: '', url }));
}

export function invalidReleaseTapdLinks(noLinks: boolean, links: ReleaseTapdLink[]) {
  return !noLinks && (!links.length || links.some((link) => !isTapdUrl(link.url)));
}
