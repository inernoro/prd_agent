// Log copies only. Never use these values for routing, authorization or responses.
const FILES = '/api/hosted-site-preview-files';
const ACCESS = '/api/hosted-site-preview-access';

function previewLogPath(value: string): string | null {
  const absolute = /^((?:https?:)?\/\/[^/?#]+)(.*)$/i.exec(value);
  const rawPath = (absolute ? absolute[2] : value).split(/[?#]/, 1)[0];
  // One standard percent-encoding pass, including ASCII in route segments.
  // Malformed ticket encoding must not make a known prefix escape redaction.
  const decoded = rawPath.replace(/%([a-f0-9]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  const routePath = decoded.replace(/^\/_cds(?=\/api\/)/i, '');
  const normalized = routePath.toLowerCase();
  if (normalized === FILES || normalized.startsWith(`${FILES}/`)) return `${FILES}/[redacted]`;
  if (normalized === ACCESS || normalized.startsWith(`${ACCESS}/`)) return ACCESS;
  return null;
}

export function isHostedSitePreviewRequest(value: string): boolean {
  return previewLogPath(value) !== null;
}

export function redactHostedSitePreviewLog(value: string): string {
  const wholePath = previewLogPath(value);
  if (wholePath !== null) return wholePath;
  return value.replace(/https?:\/\/[^\s"'<>]+|(?:\/|%2f)[^\s"'<>]*/gi, (candidate) => previewLogPath(candidate) ?? candidate);
}

export function omitHostedSitePreviewBody<T extends { bodyPreview?: string; bodyBytes?: number }>(payload: T, sensitive: boolean): T {
  return sensitive ? { ...payload, bodyPreview: undefined } : payload;
}
