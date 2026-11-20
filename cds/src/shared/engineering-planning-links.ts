export function planningGitHubPullRequest(raw: unknown) {
  if (typeof raw !== 'string' || raw.length > 2000) return undefined;
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.host !== 'github.com' || url.username || url.password) return undefined;
  const match = url.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)(?:\/(?:files|commits|checks))?\/?$/i);
  if (!match) return undefined;
  const repository = `${match[1]}/${match[2]}`;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number)) return undefined;
  return { repository, number, url: `https://github.com/${repository}/pull/${number}` };
}

export function normalizePlanningPreviewPath(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 2000) return undefined;
  const value = raw.trim();
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\s\u0000-\u001f\u007f]/u.test(value)) return undefined;
  const base = new URL('https://cds.invalid');
  try {
    const url = new URL(value, base);
    if (url.origin === base.origin && !url.pathname.startsWith('//')) return `${url.pathname}${url.search}${url.hash}`;
  } catch { /* No usable destination. */ }
  return undefined;
}

export function planningPreviewTargetUrl(previewUrl: string, targetPath: string): string | undefined {
  const path = normalizePlanningPreviewPath(targetPath);
  if (!path) return undefined;
  try {
    const base = new URL(previewUrl);
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) return undefined;
    return new URL(path, base).href;
  } catch { return undefined; }
}
