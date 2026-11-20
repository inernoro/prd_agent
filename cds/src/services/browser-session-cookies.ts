export const GH_SESSION_COOKIE = 'cds_gh_session';
export const LEGACY_SESSION_COOKIE = 'cds_token';
export const SSO_SESSION_COOKIE = 'cds_sso_session';

export function sessionCookieName(name: string, secure: boolean): string {
  return secure ? `__Host-${name}` : name;
}

export const CDS_BROWSER_COOKIE_NAMES = [GH_SESSION_COOKIE, LEGACY_SESSION_COOKIE, SSO_SESSION_COOKIE]
  .flatMap(name => [name, sessionCookieName(name, true)]);

export function readBrowserCookie(header: string | undefined, name: string): string | undefined {
  const entries = header?.split(';').map(item => item.trim()).filter(item => item.startsWith(`${name}=`)) ?? [];
  if (entries.length !== 1) return undefined;
  try { return decodeURIComponent(entries[0].slice(name.length + 1)); } catch { return undefined; }
}
