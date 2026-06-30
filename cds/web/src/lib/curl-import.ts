export type ImportedCurlRequest = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers: Record<string, string>;
  body: string;
};

const SUPPORTED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const DATA_FLAGS = new Set(['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode']);
const HEADER_FLAGS = new Set(['-H', '--header']);
const METHOD_FLAGS = new Set(['-X', '--request']);

export function parseCurlCommand(input: string): ImportedCurlRequest {
  const tokens = tokenizeCurl(input);
  if (tokens.length === 0) throw new Error('请粘贴 curl 命令');
  if (tokens[0] !== 'curl') throw new Error('命令必须以 curl 开头');

  let method = '';
  let url = '';
  const headers: Record<string, string> = {};
  const bodyParts: string[] = [];

  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    const next = tokens[i + 1];

    if (METHOD_FLAGS.has(token)) {
      if (!next) throw new Error(`${token} 后面缺少请求方法`);
      method = next.toUpperCase();
      i += 1;
      continue;
    }

    if (HEADER_FLAGS.has(token)) {
      if (!next) throw new Error(`${token} 后面缺少 Header`);
      const parsed = parseHeader(next);
      if (parsed) headers[parsed.key] = parsed.value;
      i += 1;
      continue;
    }

    if (DATA_FLAGS.has(token)) {
      if (next === undefined) throw new Error(`${token} 后面缺少请求体`);
      bodyParts.push(next);
      i += 1;
      continue;
    }

    if (token === '--url') {
      if (!next) throw new Error('--url 后面缺少 URL');
      url = next;
      i += 1;
      continue;
    }

    if (token.startsWith('-')) {
      const inline = parseInlineOption(token);
      if (inline.kind === 'method') method = inline.value.toUpperCase();
      if (inline.kind === 'header') {
        const parsed = parseHeader(inline.value);
        if (parsed) headers[parsed.key] = parsed.value;
      }
      if (inline.kind === 'data') bodyParts.push(inline.value);
      continue;
    }

    if (!url) url = token;
  }

  if (!url) throw new Error('curl 命令里没有 URL');
  const normalizedMethod = method || (bodyParts.length ? 'POST' : 'GET');
  if (!SUPPORTED_METHODS.has(normalizedMethod)) throw new Error(`暂不支持 ${normalizedMethod} 方法`);

  return {
    method: normalizedMethod as ImportedCurlRequest['method'],
    url,
    headers,
    body: bodyParts.join('&'),
  };
}

function parseInlineOption(token: string): { kind: 'method' | 'header' | 'data'; value: string } | { kind: 'other' } {
  const eq = token.indexOf('=');
  if (eq > 0) {
    const name = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (METHOD_FLAGS.has(name)) return { kind: 'method', value };
    if (HEADER_FLAGS.has(name)) return { kind: 'header', value };
    if (DATA_FLAGS.has(name)) return { kind: 'data', value };
  }
  if (token.startsWith('-X') && token.length > 2) return { kind: 'method', value: token.slice(2) };
  if (token.startsWith('-H') && token.length > 2) return { kind: 'header', value: token.slice(2) };
  if (token.startsWith('-d') && token.length > 2) return { kind: 'data', value: token.slice(2) };
  return { kind: 'other' };
}

function parseHeader(value: string): { key: string; value: string } | null {
  const idx = value.indexOf(':');
  if (idx <= 0) return null;
  const key = value.slice(0, idx).trim();
  const headerValue = value.slice(idx + 1).trim();
  return key ? { key, value: headerValue } : null;
}

function tokenizeCurl(input: string): string[] {
  const text = input.replace(/\\\r?\n/g, ' ');
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const ch of text) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (ch === '\\' && quote !== "'") {
      escaping = true;
      continue;
    }

    if ((ch === '"' || ch === "'") && !quote) {
      quote = ch;
      continue;
    }

    if (quote === ch) {
      quote = null;
      continue;
    }

    if (!quote && /\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (quote) throw new Error('curl 命令引号没有闭合');
  if (escaping) current += '\\';
  if (current) tokens.push(current);
  return tokens;
}
