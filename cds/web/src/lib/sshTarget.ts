/**
 * SSH 连接串解析 —— 让「加一台服务器」可以从粘贴一行开始。
 *
 * 为什么要有这个：加服务器时用户手上通常已经有一行现成的东西
 * （`ssh root@1.2.3.4 -p 2222`、`root@host.example.com:22`、运维群里发的一串），
 * 逼他把这行拆成主机/端口/用户三个输入框再逐个敲，是纯粹的搬运工作。
 * 粘进去就填好，才叫少绕路。
 *
 * 解析失败不是错误：解析不出来就当「用户想自己填」，返回 null，
 * 表单保持原样，绝不清空他已经敲进去的东西。
 */

export interface SshTarget {
  host: string;
  port: number;
  user?: string;
}

export const DEFAULT_SSH_PORT = 22;

/** IPv6 字面量在 URL 里带方括号（[::1]），存进 RemoteHost 时要脱掉。 */
function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function normalizePort(raw: string | number | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const port = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

/**
 * 解析一行 SSH 连接串。认得下面这些写法：
 *
 *   ssh://root@1.2.3.4:2222
 *   ssh root@1.2.3.4 -p 2222
 *   root@host.example.com:22
 *   root@host.example.com
 *   host.example.com:2222
 *   host.example.com
 *
 * 端口在 `-p` 与 `:port` 同时出现时以 `-p` 为准（那是 ssh 命令的真实语义）。
 */
export function parseSshTarget(input: string): SshTarget | null {
  const raw = input.trim();
  if (!raw) return null;

  // 先摘 `-p <port>` / `-p<port>`：它可能出现在任何位置，摘掉后剩下的部分
  // 才是干净的 [user@]host[:port]。
  let rest = raw;
  let flagPort: number | null = null;
  const portFlag = /(?:^|\s)-p\s*(\d{1,5})(?=\s|$)/.exec(rest);
  if (portFlag) {
    flagPort = normalizePort(portFlag[1]);
    rest = `${rest.slice(0, portFlag.index)} ${rest.slice(portFlag.index + portFlag[0].length)}`.trim();
  }

  // 去掉命令前缀与协议头，剩下 [user@]host[:port]
  rest = rest.replace(/^ssh\s+/i, '').replace(/^ssh:\/\//i, '').trim();
  // 命令行里可能还跟着别的参数（-i key、命令本体），只取第一段。
  rest = rest.split(/\s+/)[0] || '';
  // URL 形态可能带路径/查询，一律截断。
  rest = rest.split(/[/?#]/)[0] || '';
  if (!rest) return null;

  let user: string | undefined;
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    user = rest.slice(0, at).trim() || undefined;
    rest = rest.slice(at + 1);
  }

  let host = rest;
  let inlinePort: number | null = null;
  if (host.startsWith('[')) {
    // IPv6：[::1]:2222
    const close = host.indexOf(']');
    if (close < 0) return null;
    const after = host.slice(close + 1);
    if (after.startsWith(':')) inlinePort = normalizePort(after.slice(1));
    host = stripBrackets(host.slice(0, close + 1));
  } else {
    const colonCount = (host.match(/:/g) || []).length;
    if (colonCount === 1) {
      const [h, p] = host.split(':');
      const parsed = normalizePort(p);
      // `:abc` 不是端口，整串当主机名处理，不要静默丢掉后半段。
      if (parsed !== null) {
        host = h;
        inlinePort = parsed;
      }
    }
    // colonCount > 1 = 裸 IPv6（无方括号），冒号全是地址的一部分，不拆端口。
  }

  host = host.trim();
  if (!host) return null;
  // 主机名允许字母数字、点、连字符、下划线、冒号（IPv6）、百分号（zone id）。
  if (!/^[A-Za-z0-9._:%-]+$/.test(host)) return null;

  return { host, port: flagPort ?? inlinePort ?? DEFAULT_SSH_PORT, user };
}

/**
 * 从主机名推一个默认的服务器显示名。
 *
 * 名字是必填项，但对用户来说毫无信息量——他心里那台机器就叫「那个 IP」。
 * 所以默认拿主机名顶上，他想改再改，不想改也能直接下一步。
 */
export function suggestHostName(host: string): string {
  const trimmed = host.trim();
  if (!trimmed) return '';
  // 域名取最有辨识度的那一段（host.example.com → host），IP 原样保留。
  if (/^[0-9.]+$/.test(trimmed) || trimmed.includes(':')) return trimmed;
  const [first] = trimmed.split('.');
  return first || trimmed;
}
