// ═══════════════════════════════════════════════════════════════
// cURL 命令解析 / 导出
//
// 支持：
//   - Chrome "Copy as cURL (bash)" 格式
//   - Chrome "Copy as cURL (cmd)"  格式 (^" 转义)
//   - PowerShell 格式 (` 续行)
//   - Firefox / Safari / Postman 格式
//   - 导出：从配置字段生成 curl 命令
// ═══════════════════════════════════════════════════════════════

export interface ParsedCurl {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

// ═══════════════════════════════════════════════════════════════
// 解析
// ═══════════════════════════════════════════════════════════════

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

/** 带一个值参数的 flag（flag + value）— 解析时跳过其值 */
const ONE_ARG_FLAGS = new Set([
  '-o', '--output', '-m', '--max-time', '--connect-timeout',
  '-c', '--cookie-jar',
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
 * 解析 curl 命令字符串为结构化请求参数。
 *
 * 全量保留所有 header（包括浏览器自动添加的），-b cookie 转为 Cookie header。
 */
export function parseCurl(raw: string): ParsedCurl | null {
  if (!raw || !raw.trim()) return null;

  // 1. 预处理：检测 Windows CMD 格式并标准化
  let cmd = preprocessRaw(raw);

  // 2. 去掉开头的 curl (兼容 curl.exe)
  const curlMatch = cmd.match(/^curl(?:\.exe)?\s+/i);
  if (!curlMatch) return null;
  cmd = cmd.slice(curlMatch[0].length).trim();

  const result: ParsedCurl = {
    url: '',
    method: 'GET',
    headers: {},
    body: '',
  };

  // 3. 分词
  const tokens = tokenize(cmd);

  // 4. 收集 URL 候选
  const urlCandidates: string[] = [];

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];

    if (token === '-X' || token === '--request') {
      // 请求方法
      i++;
      if (i < tokens.length) result.method = tokens[i].toUpperCase();
    } else if (token === '-H' || token === '--header') {
      // 请求头
      i++;
      if (i < tokens.length) {
        const colonIdx = tokens[i].indexOf(':');
        if (colonIdx > 0) {
          const key = tokens[i].slice(0, colonIdx).trim();
          const val = tokens[i].slice(colonIdx + 1).trim();
          result.headers[key] = val;
        }
      }
    } else if (
      token === '-d' || token === '--data' || token === '--data-raw' ||
      token === '--data-binary' || token === '--data-urlencode' || token === '--json'
    ) {
      // 请求体
      i++;
      if (i < tokens.length) {
        result.body = tokens[i];
        if (result.method === 'GET') result.method = 'POST';
      }
    } else if (token === '-b' || token === '--cookie') {
      // Cookie → 作为 Cookie header 保留
      i++;
      if (i < tokens.length) {
        result.headers['Cookie'] = tokens[i];
      }
    } else if (token === '-u' || token === '--user') {
      // Basic Auth
      i++;
      if (i < tokens.length) {
        const encoded = btoa(tokens[i]);
        result.headers['Authorization'] = `Basic ${encoded}`;
      }
    } else if (token === '--url') {
      // 显式 URL
      i++;
      if (i < tokens.length) result.url = tokens[i];
    } else if (token === '-F' || token === '--form') {
      i++;
      if (result.method === 'GET') result.method = 'POST';
    } else if (NO_ARG_FLAGS.has(token)) {
      // 纯开关，不跳值
    } else if (ONE_ARG_FLAGS.has(token)) {
      i++; // 跳过值
    } else if (token.startsWith('-')) {
      // 未知 flag：启发式判断下一个 token 是否为其值
      if (i + 1 < tokens.length) {
        const next = tokens[i + 1];
        if (!next.startsWith('-') && !looksLikeUrl(next)) {
          i++;
        }
      }
    } else {
      // 裸值 → URL 候选
      urlCandidates.push(token);
    }

    i++;
  }

  // 5. 从候选中选 URL：优先选 http(s):// 开头的
  if (!result.url) {
    result.url = urlCandidates.find(c => looksLikeUrl(c))
      || urlCandidates[0]
      || '';
  }

  if (!result.url) return null;
  return result;
}

// ═══════════════════════════════════════════════════════════════
// 导出
// ═══════════════════════════════════════════════════════════════

/**
 * 从配置字段生成 curl 命令字符串（可直接在终端执行）。
 */
export function toCurl(opts: {
  url: string;
  method?: string;
  headers?: Record<string, string> | string;
  body?: string;
}): string {
  const lines: string[] = [];
  const method = (opts.method || 'GET').toUpperCase();

  // URL
  lines.push(`curl ${shellQuote(opts.url)}`);

  // Method（如果不是默认的 GET 或隐式 POST）
  if (method !== 'GET' && !(method === 'POST' && opts.body)) {
    lines.push(`-X ${method}`);
  }

  // Headers
  let headerObj: Record<string, string> = {};
  if (typeof opts.headers === 'string' && opts.headers.trim()) {
    try {
      headerObj = JSON.parse(opts.headers);
    } catch { /* ignore */ }
  } else if (typeof opts.headers === 'object' && opts.headers) {
    headerObj = opts.headers;
  }

  for (const [k, v] of Object.entries(headerObj)) {
    lines.push(`-H ${shellQuote(`${k}: ${v}`)}`);
  }

  // Body
  if (opts.body) {
    lines.push(`--data-raw ${shellQuote(opts.body)}`);
  }

  return lines.join(' \\\n  ');
}

/** Shell-safe 单引号包裹 */
function shellQuote(s: string): string {
  // 如果不含单引号，直接用单引号包裹
  if (!s.includes("'")) return `'${s}'`;
  // 否则用双引号，转义其中的特殊字符
  return `"${s.replace(/[\\"$`]/g, '\\$&')}"`;
}

// ═══════════════════════════════════════════════════════════════
// 工具函数（供 UI 层调用）
// ═══════════════════════════════════════════════════════════════

/**
 * 将 headers Record 序列化为 JSON 字符串。
 * 全量保留所有 header，不做过滤。
 */
export function headersToJson(headers: Record<string, string>): string {
  return Object.keys(headers).length > 0
    ? JSON.stringify(headers, null, 2)
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

// ═══════════════════════════════════════════════════════════════
// 内部：预处理
// ═══════════════════════════════════════════════════════════════

/**
 * 检测并规范化原始输入：
 * - Windows CMD: ^" → ", ^% → %, ^\ → \, ^^ → ^, ^ 续行
 * - PowerShell: ` 续行
 * - bash: \ 续行
 */
function preprocessRaw(raw: string): string {
  let s = raw.trim();

  // 检测 Windows CMD 格式：含 ^" 或行尾 ^
  if (/\^"/.test(s) || /\^\s*$/m.test(s)) {
    // Windows CMD: 先处理续行 (行尾 ^)
    s = s.replace(/\^\s*\r?\n/g, ' ');
    // 转义字符还原：^X → X（CMD 的 ^ 可以转义任意字符）
    s = s.replace(/\^(.)/g, '$1');
  } else {
    // bash / PowerShell（兼容 \ 后有尾随空格的情况）
    s = s.replace(/\\[ \t]*\r?\n/g, ' ');   // bash 续行
    s = s.replace(/`[ \t]*\r?\n/g, ' ');    // PowerShell 续行
  }

  // 统一换行和空白
  s = s.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

// ═══════════════════════════════════════════════════════════════
// 内部：分词器
// ═══════════════════════════════════════════════════════════════

function looksLikeUrl(s: string): boolean {
  return /^https?:\/\//i.test(s) || /^[a-z0-9][-a-z0-9]*(\.[a-z0-9][-a-z0-9]*)+/i.test(s);
}

/** 将命令字符串分词，正确处理引号 */
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
      i++;
      let value = '';
      while (i < cmd.length && cmd[i] !== quote) {
        if (cmd[i] === '\\' && quote === '"' && i + 1 < cmd.length) {
          // 双引号内转义
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
      // $'...' ANSI-C 引号 (Chrome bash 格式)
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
      // 普通 token（无引号）
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
