// Log copies only. Never use these values for routing, authorization or responses.
const FILES = '/api/hosted-site-preview-files';
const ACCESS = '/api/hosted-site-preview-access';
const SHARES = '/api/web-pages/shares';
const SHARE_CREATE = '/api/web-pages/share';

function previewLogPath(value: string): string | null {
  const absolute = /^((?:https?:)?\/\/[^/?#]+)(.*)$/i.exec(value);
  const rawPath = (absolute ? absolute[2] : value).split(/[?#]/, 1)[0];
  // One standard percent-encoding pass, including ASCII in route segments.
  // Malformed ticket encoding must not make a known prefix escape redaction.
  const decoded = rawPath.replace(/%([a-f0-9]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  const routePath = decoded.replace(/^\/_cds(?=\/api\/)/i, '');
  const normalized = routePath.toLowerCase();
  // 受保护的那一段可以排在任意外部前缀之后：API 支持子路径部署（挂在 /platform 之类
  // 前缀下），到代理这里就是 /platform/api/hosted-site-preview-files/bootstrap/<票据>。
  // 只认「从头开始」的话这条路径判不出来，票据会原样留在记录下来的 URL 里——
  // 一次安全加固漏在了它自己要防的那种部署上。这里只影响日志文本，
  // 不参与路由与鉴权（见文件头），所以宁可多脱敏一点，也不能漏。
  const files = segmentPrefix(normalized, FILES);
  if (files !== null) return `${files}${FILES}/[redacted]`;
  const access = segmentPrefix(normalized, ACCESS);
  if (access !== null) return `${access}${ACCESS}`;
  const share = segmentPrefix(normalized, SHARES);
  if (share !== null) return `${share}${SHARES}/[redacted]`;
  const create = normalized.replace(/\/+$/, '');
  if (create.endsWith(SHARE_CREATE)) return create;
  const logs = /^(.*)\/api\/web-pages\/[^/]+\/share-logs\/?$/.exec(normalized);
  if (logs) return `${logs[1]}/api/web-pages/:siteId/share-logs`;
  return null;
}

/**
 * 受保护路由段在这条路径里的起点之前那一段前缀；匹配不上返回 null。
 *
 * 必须卡在段边界上：`/x/api/hosted-site-preview-files` 算，
 * `/notapi/hosted-site-preview-files-backup` 不算。
 */
function segmentPrefix(path: string, route: string): string | null {
  const at = path.indexOf(route);
  if (at < 0) return null;
  const rest = path.slice(at + route.length);
  if (rest.length > 0 && !rest.startsWith('/')) return null;
  return path.slice(0, at);
}

export function isHostedSitePreviewRequest(value: string): boolean {
  return previewLogPath(value) !== null;
}

export function redactHostedSitePreviewLog(value: string): string {
  const redact = (candidate: string): string | null => {
    const preview = previewLogPath(candidate);
    if (preview !== null) return preview;
    if (/\s/.test(candidate) || !candidate.includes('?')) return null;
    const [pathname, search] = candidate.split(/\?(.*)/s, 2);
    const parameters = new URLSearchParams(search.split('#', 1)[0]);
    return parameters.has('state') && (parameters.has('code') || parameters.has('error')) ? pathname : null;
  };
  const wholePath = redact(value);
  if (wholePath !== null) return wholePath;
  return value.replace(/https?:\/\/[^\s"'<>]+|(?:\/|%2f)[^\s"'<>]*/gi, (candidate) => redact(candidate) ?? candidate);
}

export function omitHostedSitePreviewBody<T extends { bodyPreview?: string; bodyBytes?: number }>(payload: T, sensitive: boolean): T {
  return sensitive ? { ...payload, bodyPreview: undefined } : payload;
}
