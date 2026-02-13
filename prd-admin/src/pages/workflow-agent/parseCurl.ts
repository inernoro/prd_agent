// ═══════════════════════════════════════════════════════════════
// cURL 命令反解析器
//
// 支持从浏览器 DevTools 复制的 curl 命令，解析为结构化字段：
//   URL / Method / Headers / Body
// ═══════════════════════════════════════════════════════════════

export interface ParsedCurl {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * 解析 curl 命令字符串为结构化请求参数
 *
 * 支持格式：
 * - 单行 / 多行 (\ 续行)
 * - 单引号 / 双引号
 * - Chrome / Firefox / Safari 复制的格式
 * - --compressed / --insecure 等无关 flag 自动忽略
 */
export function parseCurl(raw: string): ParsedCurl | null {
  if (!raw || !raw.trim()) return null;

  // 规范化：去掉续行符，合并为一行
  let cmd = raw
    .replace(/\\\r?\n/g, ' ')   // 续行
    .replace(/\r?\n/g, ' ')     // 换行
    .replace(/\s+/g, ' ')       // 多余空格
    .trim();

  // 去掉开头的 curl
  if (cmd.startsWith('curl ')) {
    cmd = cmd.slice(5).trim();
  } else if (cmd.startsWith('curl\t')) {
    cmd = cmd.slice(5).trim();
  } else {
    return null; // 不是 curl 命令
  }

  const result: ParsedCurl = {
    url: '',
    method: 'GET',
    headers: {},
    body: '',
  };

  // 分词：处理引号内的内容
  const tokens = tokenize(cmd);

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];

    if (token === '-X' || token === '--request') {
      i++;
      if (i < tokens.length) result.method = tokens[i].toUpperCase();
    } else if (token === '-H' || token === '--header') {
      i++;
      if (i < tokens.length) {
        const header = tokens[i];
        const colonIdx = header.indexOf(':');
        if (colonIdx > 0) {
          const key = header.slice(0, colonIdx).trim();
          const val = header.slice(colonIdx + 1).trim();
          result.headers[key] = val;
        }
      }
    } else if (token === '-d' || token === '--data' || token === '--data-raw' || token === '--data-binary' || token === '--data-urlencode') {
      i++;
      if (i < tokens.length) {
        result.body = tokens[i];
        // 有 body 且未显式指定 method → POST
        if (result.method === 'GET') result.method = 'POST';
      }
    } else if (token === '-u' || token === '--user') {
      i++;
      if (i < tokens.length) {
        // Basic auth: user:password → Base64
        const encoded = btoa(tokens[i]);
        result.headers['Authorization'] = `Basic ${encoded}`;
      }
    } else if (
      token === '--compressed' || token === '--insecure' || token === '-k' ||
      token === '-s' || token === '--silent' || token === '-S' || token === '--show-error' ||
      token === '-L' || token === '--location' || token === '-v' || token === '--verbose' ||
      token === '-i' || token === '--include' || token === '-o' || token === '-O'
    ) {
      // 忽略这些无关 flag
      // -o / -O 后面跟一个值参数，跳过
      if (token === '-o') i++;
    } else if (token === '--connect-timeout' || token === '--max-time' || token === '-m') {
      i++; // 跳过值
    } else if (token.startsWith('-')) {
      // 未知 flag，忽略
    } else {
      // 没有 flag 的裸值 → URL
      if (!result.url) {
        result.url = token;
      }
    }

    i++;
  }

  if (!result.url) return null;

  return result;
}

/** 将 curl 命令分词，正确处理引号 */
function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  let i = 0;

  while (i < cmd.length) {
    // 跳过空白
    while (i < cmd.length && (cmd[i] === ' ' || cmd[i] === '\t')) i++;
    if (i >= cmd.length) break;

    const ch = cmd[i];

    if (ch === "'" || ch === '"') {
      // 引号字符串
      const quote = ch;
      i++; // 跳过开头引号
      let value = '';
      while (i < cmd.length && cmd[i] !== quote) {
        if (cmd[i] === '\\' && quote === '"' && i + 1 < cmd.length) {
          // 双引号内的转义
          i++;
          value += cmd[i];
        } else {
          value += cmd[i];
        }
        i++;
      }
      if (i < cmd.length) i++; // 跳过结尾引号
      tokens.push(value);
    } else if (ch === '$' && i + 1 < cmd.length && cmd[i + 1] === "'") {
      // $'...' ANSI-C 引号 (Chrome 复制格式)
      i += 2;
      let value = '';
      while (i < cmd.length && cmd[i] !== "'") {
        if (cmd[i] === '\\' && i + 1 < cmd.length) {
          i++;
          if (cmd[i] === 'n') value += '\n';
          else if (cmd[i] === 't') value += '\t';
          else if (cmd[i] === 'r') value += '\r';
          else if (cmd[i] === '\\') value += '\\';
          else if (cmd[i] === "'") value += "'";
          else value += '\\' + cmd[i];
        } else {
          value += cmd[i];
        }
        i++;
      }
      if (i < cmd.length) i++;
      tokens.push(value);
    } else {
      // 普通 token
      let value = '';
      while (i < cmd.length && cmd[i] !== ' ' && cmd[i] !== '\t') {
        value += cmd[i];
        i++;
      }
      tokens.push(value);
    }
  }

  return tokens;
}

/** 将 ParsedCurl 格式化为可读的 Headers JSON 字符串 */
export function headersToJson(headers: Record<string, string>): string {
  // 过滤掉浏览器自动添加的不重要 header
  const skip = new Set([
    'accept-encoding', 'accept-language', 'sec-ch-ua', 'sec-ch-ua-mobile',
    'sec-ch-ua-platform', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
    'sec-fetch-user', 'upgrade-insecure-requests', 'connection', 'host',
    'user-agent', 'dnt', 'cache-control', 'pragma',
  ]);

  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!skip.has(k.toLowerCase())) {
      filtered[k] = v;
    }
  }

  return Object.keys(filtered).length > 0
    ? JSON.stringify(filtered, null, 2)
    : '';
}

/** 尝试美化 JSON body */
export function prettyBody(body: string): string {
  if (!body) return '';
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
