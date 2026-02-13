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

// ── 已知 flag 分类 ──

/** 不带值的 flag（纯开关） */
const NO_ARG_FLAGS = new Set([
  '--compressed', '--insecure', '-k', '-s', '--silent', '-S', '--show-error',
  '-L', '--location', '-v', '--verbose', '-i', '--include', '-O', '--remote-name',
  '-f', '--fail', '-g', '--globoff', '-n', '--netrc', '-N', '--no-buffer',
  '-q', '--disable', '--raw', '--tr-encoding', '-4', '--ipv4', '-6', '--ipv6',
  '--ssl', '--ssl-reqd', '--tcp-nodelay', '--tcp-fastopen', '--path-as-is',
  '--http1.0', '--http1.1', '--http2', '--http2-prior-knowledge', '--http3',
  '--no-keepalive', '--no-sessionid', '--no-alpn', '--no-npn',
  '--junk-session-cookies', '--create-dirs',
]);

/** 带一个值参数的 flag（flag + value） */
const ONE_ARG_FLAGS = new Set([
  '-o', '--output', '-m', '--max-time', '--connect-timeout',
  '-b', '--cookie', '-c', '--cookie-jar',
  '-e', '--referer', '-A', '--user-agent',
  '-x', '--proxy', '--proxy-user', '--noproxy',
  '-w', '--write-out', '-T', '--upload-file',
  '--cert', '--cert-type', '--key', '--key-type', '--cacert', '--capath',
  '--resolve', '--retry', '--retry-delay', '--retry-max-time',
  '--max-redirs', '--limit-rate', '--interface', '--local-port',
  '-E', '-t', '--telnet-option', '--dns-servers', '--dns-interface',
  '--trace', '--trace-ascii', '--stderr', '--keepalive-time',
  '--expect100-timeout', '--happy-eyeballs-timeout-ms',
  '--socks4', '--socks4a', '--socks5', '--socks5-hostname',
  '-r', '--range', '-Y', '--speed-limit', '-y', '--speed-time',
  '-z', '--time-cond', '--ciphers', '--tls-max', '--tls13-ciphers',
  '--unix-socket', '--abstract-unix-socket', '-K', '--config',
]);

/**
 * 解析 curl 命令字符串为结构化请求参数
 *
 * 支持格式：
 * - 单行 / 多行 (\ 续行、^ 续行 Windows)
 * - 单引号 / 双引号 / $'...' ANSI-C 引号
 * - Chrome / Firefox / Safari / Postman 复制的格式
 * - 未知 flag 自动跳过
 */
export function parseCurl(raw: string): ParsedCurl | null {
  if (!raw || !raw.trim()) return null;

  // 规范化：去掉续行符，合并为一行
  let cmd = raw
    .replace(/\\\r?\n/g, ' ')   // Unix 续行 (\)
    .replace(/\^\r?\n/g, ' ')   // Windows 续行 (^)
    .replace(/`\r?\n/g, ' ')    // PowerShell 续行 (`)
    .replace(/\r?\n/g, ' ')     // 剩余换行
    .replace(/\s+/g, ' ')       // 多余空格
    .trim();

  // 去掉开头的 curl (忽略大小写，兼容 Windows 的 curl.exe)
  const curlMatch = cmd.match(/^curl(?:\.exe)?\s+/i);
  if (!curlMatch) return null;
  cmd = cmd.slice(curlMatch[0].length).trim();

  const result: ParsedCurl = {
    url: '',
    method: 'GET',
    headers: {},
    body: '',
  };

  // 分词：处理引号内的内容
  const tokens = tokenize(cmd);

  // 收集所有可能的 URL 候选（非 flag 的裸值）
  const urlCandidates: string[] = [];

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
    } else if (token === '-d' || token === '--data' || token === '--data-raw' || token === '--data-binary' || token === '--data-urlencode' || token === '--json') {
      i++;
      if (i < tokens.length) {
        result.body = tokens[i];
        if (result.method === 'GET') result.method = 'POST';
      }
    } else if (token === '-u' || token === '--user') {
      i++;
      if (i < tokens.length) {
        const encoded = btoa(tokens[i]);
        result.headers['Authorization'] = `Basic ${encoded}`;
      }
    } else if (token === '--url') {
      // 显式 --url flag
      i++;
      if (i < tokens.length) result.url = tokens[i];
    } else if (token === '-F' || token === '--form') {
      i++; // multipart form data — skip value
      if (result.method === 'GET') result.method = 'POST';
    } else if (NO_ARG_FLAGS.has(token)) {
      // 纯开关，不跳值
    } else if (ONE_ARG_FLAGS.has(token)) {
      i++; // 跳过值参数
    } else if (token.startsWith('-')) {
      // 未知 flag：尝试判断下一个 token 是否为其值
      // 如果下一个 token 不像 URL 也不像 flag，就跳过它
      if (i + 1 < tokens.length) {
        const next = tokens[i + 1];
        if (!next.startsWith('-') && !looksLikeUrl(next)) {
          i++; // 跳过值
        }
      }
    } else {
      // 没有 flag 的裸值 → URL 候选
      urlCandidates.push(token);
    }

    i++;
  }

  // 从候选中选择 URL：优先选择看起来像 URL 的
  if (!result.url) {
    result.url = urlCandidates.find(c => looksLikeUrl(c))
      || urlCandidates[0]
      || '';
  }

  if (!result.url) return null;

  return result;
}

/** 判断字符串是否看起来像一个 URL */
function looksLikeUrl(s: string): boolean {
  return /^https?:\/\//i.test(s) || /^[a-z0-9][-a-z0-9]*(\.[a-z0-9][-a-z0-9]*)+/i.test(s);
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
