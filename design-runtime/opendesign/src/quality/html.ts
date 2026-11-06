// 搬迁自 cds/src/services/agent-workspace-session-runtime.ts（第 1 阶段：只改归属、不改行为）。
// 第 4 阶段删除 CDS 旧实现之前，两边的判据必须保持逐字一致；改这里要同步改那边，反之亦然。
import { AgentWorkspaceRuntimeError } from '../errors.js';

export const MAX_HTML_NESTING_DEPTH = 2_048;

export function extractVisibleHtmlText(html: string): string {
  return decodeHtmlText(extractVisibleTextFromMarkup(html))
    .replace(/\s+/g, ' ')
    .trim();
}

export function decodeHtmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&(?:nbsp|#160);/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

export function readHtmlAttribute(attributes: string, name: string): string | undefined {
  const value = parseHtmlAttributes(attributes).get(name.toLowerCase());
  return value === undefined ? undefined : decodeHtmlText(value ?? '');
}

export function hasHtmlAttribute(attributes: string, name: string): boolean {
  return parseHtmlAttributes(attributes).has(name.toLowerCase());
}

interface HtmlTagToken {
  name: string;
  attributes: string;
  start: number;
  end: number;
  isClosing: boolean;
  isSelfClosing: boolean;
  isComment?: boolean;
}

export function* iterateHtmlTags(html: string): Generator<HtmlTagToken> {
  let rawTextElement = '';
  for (let index = 0; index < html.length; index += 1) {
    if (html[index] !== '<' || index + 1 >= html.length) continue;
    if (!rawTextElement && html.startsWith('<!--', index)) {
      const commentEnd = html.indexOf('-->', index + 4);
      const end = commentEnd < 0 ? html.length : commentEnd + 3;
      yield {
        name: '!comment',
        attributes: '',
        start: index,
        end,
        isClosing: false,
        isSelfClosing: true,
        isComment: true,
      };
      index = end - 1;
      continue;
    }
    let cursor = index + 1;
    const isClosing = html[cursor] === '/';
    if (isClosing) cursor += 1;
    if (!/[A-Za-z]/.test(html[cursor] ?? '')) continue;
    const nameStart = cursor;
    while (cursor < html.length && /[A-Za-z0-9:-]/.test(html[cursor])) cursor += 1;
    const name = html.slice(nameStart, cursor);
    if (rawTextElement && (!isClosing || name.toLowerCase() !== rawTextElement)) continue;
    const attributesStart = cursor;
    let quote: string | undefined;
    while (cursor < html.length) {
      const current = html[cursor];
      if (quote) {
        if (current === quote) quote = undefined;
      } else if (current === '"' || current === "'") {
        quote = current;
      } else if (current === '>') {
        const attributes = html.slice(attributesStart, cursor);
        const token = {
          name,
          attributes,
          start: index,
          end: cursor + 1,
          isClosing,
          isSelfClosing: attributes.trimEnd().endsWith('/'),
        };
        yield token;
        if (isClosing && name.toLowerCase() === rawTextElement) rawTextElement = '';
        else if (!isClosing && !token.isSelfClosing && /^(?:script|style|textarea|title)$/i.test(name)) {
          rawTextElement = name.toLowerCase();
        }
        index = cursor;
        break;
      }
      cursor += 1;
    }
  }
}

function extractVisibleTextFromMarkup(html: string): string {
  const maxVisibleTextCharacters = 2 * 1024 * 1024;
  const stack: Array<{ name: string; suppressed: boolean }> = [];
  let suppressedDepth = 0;
  let cursor = 0;
  let result = '';
  const appendVisibleText = (value: string): void => {
    if (result.length + value.length > maxVisibleTextCharacters) {
      throw new AgentWorkspaceRuntimeError(
        'design_output_quality_rejected',
        'index.html contains too much visible text to validate safely',
      );
    }
    result += value;
  };
  for (const tag of iterateHtmlTags(html)) {
    if (tag.start > cursor && suppressedDepth === 0) appendVisibleText(html.slice(cursor, tag.start));
    const block = /^(?:address|article|aside|blockquote|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|li|main|nav|ol|p|section|table|tbody|td|tfoot|th|thead|tr|ul)$/i.test(tag.name);
    if (tag.isClosing) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        const frame = stack[index];
        stack.splice(index, 1);
        if (frame.suppressed) suppressedDepth -= 1;
        if (frame.name.toLowerCase() === tag.name.toLowerCase()) break;
      }
      if (block && suppressedDepth === 0) appendVisibleText('。');
    } else {
      if (block && suppressedDepth === 0) appendVisibleText('。');
      const style = readHtmlAttribute(tag.attributes, 'style') ?? '';
      const suppressed = /^(?:head|script|style|template|noscript)$/i.test(tag.name)
        || hasHtmlAttribute(tag.attributes, 'hidden')
        || readHtmlAttribute(tag.attributes, 'aria-hidden')?.trim().toLowerCase() === 'true'
        || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/i.test(style);
      // A visible line break is a text boundary, unlike inline spans within a quantity.
      if (suppressedDepth === 0 && !suppressed && tag.name.toLowerCase() === 'br') appendVisibleText('。');
      if (suppressedDepth === 0 && !suppressed && tag.name.toLowerCase() === 'input') {
        const type = (readHtmlAttribute(tag.attributes, 'type') ?? 'text').trim().toLowerCase();
        if (!['hidden', 'checkbox', 'radio', 'file', 'color', 'range'].includes(type)) {
          const value = readHtmlAttribute(tag.attributes, 'value')?.trim();
          const placeholder = readHtmlAttribute(tag.attributes, 'placeholder')?.trim();
          if (value) appendVisibleText(` ${value} `);
          else if (placeholder) appendVisibleText(` ${placeholder} `);
        }
      }
      const voidElement = /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(tag.name);
      if (!tag.isSelfClosing && !voidElement) {
        if (stack.length >= MAX_HTML_NESTING_DEPTH) {
          throw new AgentWorkspaceRuntimeError(
            'design_output_quality_rejected',
            'index.html exceeds the supported HTML nesting depth',
          );
        }
        stack.push({ name: tag.name, suppressed });
        if (suppressed) suppressedDepth += 1;
      }
    }
    cursor = tag.end;
  }
  if (cursor < html.length && suppressedDepth === 0) appendVisibleText(html.slice(cursor));
  return result;
}

export function parseHtmlAttributes(attributes: string): Map<string, string | undefined> {
  const parsed = new Map<string, string | undefined>();
  let index = 0;
  while (index < attributes.length) {
    while (index < attributes.length && (/\s/.test(attributes[index]) || attributes[index] === '/')) index += 1;
    const nameStart = index;
    while (index < attributes.length && !/[\s=>]/.test(attributes[index])) index += 1;
    if (index === nameStart) {
      index += 1;
      continue;
    }
    const attributeName = attributes.slice(nameStart, index).toLowerCase();
    while (index < attributes.length && /\s/.test(attributes[index])) index += 1;
    let value: string | undefined;
    if (attributes[index] === '=') {
      index += 1;
      while (index < attributes.length && /\s/.test(attributes[index])) index += 1;
      const quote = attributes[index] === '"' || attributes[index] === "'" ? attributes[index] : undefined;
      if (quote) {
        index += 1;
        const valueStart = index;
        while (index < attributes.length && attributes[index] !== quote) index += 1;
        value = attributes.slice(valueStart, index);
        if (index < attributes.length) index += 1;
      } else {
        const valueStart = index;
        while (index < attributes.length && !/[\s>]/.test(attributes[index])) index += 1;
        value = attributes.slice(valueStart, index);
      }
    }
    if (!parsed.has(attributeName)) parsed.set(attributeName, value);
  }
  return parsed;
}
