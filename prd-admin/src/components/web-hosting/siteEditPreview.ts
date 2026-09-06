import type { DesignRuntimeCapability, HostedSiteRevision } from '@/services/real/webPages';

export function elapsedSecondsSince(startedAt: number | string | null | undefined, now = Date.now()) {
  const startedAtMs = typeof startedAt === 'number' ? startedAt : Date.parse(startedAt ?? '');
  if (!Number.isFinite(startedAtMs)) return 0;
  return Math.max(0, Math.floor((now - startedAtMs) / 1000));
}

export function chooseDesignRuntime(
  capabilities: DesignRuntimeCapability[],
  defaultRuntime: string,
) {
  return capabilities.find((item) => item.id === defaultRuntime && item.enabled)?.id
    ?? capabilities.find((item) => item.enabled)?.id
    ?? '';
}

export function displayedDesignRuntime(
  capabilities: DesignRuntimeCapability[],
  selectedRuntime: string,
  activeRunRuntime?: string | null,
) {
  const runtimeId = activeRunRuntime || selectedRuntime;
  return capabilities.find((item) => item.id === runtimeId)
    ?? capabilities.find((item) => item.id === selectedRuntime && item.enabled)
    ?? capabilities.find((item) => item.enabled);
}

export function activeSiteEditRunStorageKey(siteId: string) {
  return `web-hosting-edit-active-run-v1:${siteId}`;
}

export function revisionLabel(item: Pick<HostedSiteRevision, 'isCurrent' | 'status' | 'source'>) {
  if (item.isCurrent) return '当前线上版本';
  if (item.status === 'draft') return '未发布草稿';
  if (item.status === 'publishing') return '发布未完成，可重试';
  if (item.source === 'rollback') return '回退发布版本';
  if (item.source === 'baseline') return '历史线上版本';
  return '已发布版本';
}

export function canPublishRevision(item: Pick<HostedSiteRevision, 'isCurrent' | 'status'>) {
  return !item.isCurrent && (item.status === 'draft' || item.status === 'publishing');
}

export const AI_STREAM_PREVIEW_SANDBOX = '';

export const AI_STREAM_PREVIEW_CSP = [
  "default-src 'none';",
  "base-uri 'none';",
  "connect-src 'none';",
  "form-action 'none';",
  "img-src data:;",
  "font-src data:;",
  "media-src data:;",
  "style-src 'unsafe-inline';",
  "script-src 'none';",
  "object-src 'none';",
  "frame-src 'none';",
  "child-src 'none';",
  "worker-src 'none';",
  "manifest-src 'none';",
].join(' ');

const BLOCKED_AI_PREVIEW_ELEMENTS =
  'script,meta,base,form,iframe,object,embed,link,noscript';
const NAVIGATION_ATTRIBUTES = new Set(['href', 'xlink:href', 'action', 'formaction', 'ping']);
const RESOURCE_ATTRIBUTES = new Set(['src', 'srcset', 'poster', 'background', 'manifest']);

/**
 * CSS 仍可用于还原模型的版式，但不能通过 import 或 url() 请求站外资源。
 * data URL 和当前文档 fragment 不产生网络请求，可以继续用于内嵌图片和 SVG 定义。
 */
export function sanitizeAiPreviewCss(css: string) {
  return css
    .replace(/@import\s+(?:url\([^)]*\)|["'][^"']*["'])[^;]*(?:;|$)/giu, '')
    .replace(/url\(\s*(["']?)(.*?)\1\s*\)/giu, (_match, _quote: string, rawUrl: string) => {
      const url = rawUrl.trim().toLowerCase();
      return url.startsWith('data:') || url.startsWith('#') ? `url("${rawUrl.trim()}")` : 'url("")';
    });
}

/** 模型只输出到完整 </html> 后才允许替换加载骨架。 */
export function extractCompleteAiPreviewHtml(raw: string) {
  const opening = /(?:<!doctype\s+html[^>]*>\s*)?<html(?:\s|>)/iu.exec(raw);
  if (!opening || opening.index === undefined) return '';

  const closeStart = raw.toLowerCase().lastIndexOf('</html>');
  if (closeStart < opening.index) return '';
  return raw.slice(opening.index, closeStart + '</html>'.length).trim();
}

export function isAllowedAiPreviewResource(value: string) {
  return value.trim().toLowerCase().startsWith('data:');
}

function escapeHtmlAttribute(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

function systemCspMeta() {
  return `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(AI_STREAM_PREVIEW_CSP)}">`;
}

function findOpeningTagEnd(html: string, start: number) {
  let quote = '';
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '>') return index;
  }
  return -1;
}

/** CSP 在 DOMParser 接触模型节点前就生效，避免解析阶段产生资源请求窗口。 */
export function buildStrictAiPreviewParserInput(completeHtml: string) {
  const rootStart = completeHtml.search(/<html(?:\s|>)/iu);
  const rootEnd = rootStart >= 0 ? findOpeningTagEnd(completeHtml, rootStart) : -1;
  const closeStart = completeHtml.toLowerCase().lastIndexOf('</html>');
  if (rootEnd < 0 || closeStart <= rootEnd) return '';

  const modelContents = completeHtml.slice(rootEnd + 1, closeStart);
  return `<!doctype html><html><head>${systemCspMeta()}${modelContents}</html>`;
}

export function buildStrictAiPreviewDocument(safeHeadHtml: string, safeBodyHtml: string) {
  return `<!doctype html><html><head>${systemCspMeta()}${safeHeadHtml}</head><body>${safeBodyHtml}</body></html>`;
}

/**
 * AI 流式原文尚未经过服务端产物硬化，因此使用浏览器 HTML parser 后重建文档：
 * 系统 CSP 永远先于模型节点，危险节点、事件、导航和站外资源在进入 iframe 前移除。
 * iframe sandbox 是第二道独立边界，即使 parser 清理遗漏也不能执行脚本或发起表单。
 */
export function previewableAiStreamHtml(raw: string) {
  const completeHtml = extractCompleteAiPreviewHtml(raw);
  if (!completeHtml || typeof DOMParser === 'undefined') return '';

  const parserInput = buildStrictAiPreviewParserInput(completeHtml);
  if (!parserInput) return '';
  const parsed = new DOMParser().parseFromString(parserInput, 'text/html');
  parsed.querySelectorAll(BLOCKED_AI_PREVIEW_ELEMENTS).forEach((element) => element.remove());

  parsed.querySelectorAll('*').forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || NAVIGATION_ATTRIBUTES.has(name)) {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (RESOURCE_ATTRIBUTES.has(name)) {
        if (name === 'srcset' || !isAllowedAiPreviewResource(attribute.value)) {
          element.removeAttribute(attribute.name);
        }
        continue;
      }

      if (name === 'style') {
        const safeCss = sanitizeAiPreviewCss(attribute.value);
        if (safeCss.trim()) element.setAttribute(attribute.name, safeCss);
        else element.removeAttribute(attribute.name);
      }
    }
  });

  parsed.querySelectorAll('style').forEach((style) => {
    style.textContent = sanitizeAiPreviewCss(style.textContent ?? '');
  });

  return buildStrictAiPreviewDocument(parsed.head.innerHTML, parsed.body.innerHTML);
}
