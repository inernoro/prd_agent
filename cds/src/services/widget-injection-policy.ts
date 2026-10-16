import type { IncomingHttpHeaders } from 'node:http';

/** Widget 是可选装饰：应用声明 CSP 时不尝试解释、放宽或追加例外。 */
export function hasWidgetCspHeader(headers: IncomingHttpHeaders): boolean {
  return Object.entries(headers).some(([name, value]) =>
    ['content-security-policy', 'content-security-policy-report-only'].includes(name.toLowerCase())
    && (Array.isArray(value) ? value : [value]).some(item => typeof item === 'string' && item.trim() !== ''),
  );
}

/** 解压 HTML 后检查 meta；宁可保守跳过装饰，也不向应用注入被策略拒绝的脚本。 */
export function hasWidgetCspMeta(html: string): boolean {
  for (const [tag] of html.matchAll(/<meta\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
    if (/\bhttp-equiv\s*=\s*(?:"\s*content-security-policy\s*"|'\s*content-security-policy\s*'|content-security-policy(?=[\s/>]))/i.test(tag)) return true;
  }
  return false;
}
