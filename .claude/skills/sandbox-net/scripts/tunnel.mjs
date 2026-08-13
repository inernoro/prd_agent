#!/usr/bin/env node
/**
 * TCP 隧道：localhost:<listen> --> agent proxy CONNECT --> <target host>:<port>
 *
 * 只搬字节，不解 TLS —— 上层（浏览器或 relay.mjs）仍然对目标域名做完整证书校验。
 * 存在的理由：这个沙箱里 Chromium 自己走 agent proxy 会被 reset，但 Node 可以。
 *
 * 用法：
 *   node tunnel.mjs --target cds.miduo.org:443 [--listen 7799] [--proxy 127.0.0.1:36831]
 *   不传 --proxy 时读 HTTPS_PROXY 环境变量。
 */
import net from 'node:net';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const target = arg('target', '');
if (!target.includes(':')) {
  console.error('用法: node tunnel.mjs --target <host>:<port> [--listen 7799] [--proxy host:port]');
  process.exit(2);
}

const proxyRaw = arg('proxy', (process.env.HTTPS_PROXY || process.env.https_proxy || '').replace(/^https?:\/\//, ''));
if (!proxyRaw.includes(':')) {
  console.error('找不到 agent proxy：既没传 --proxy，HTTPS_PROXY 也没设。');
  process.exit(2);
}
const [proxyHost, proxyPort] = proxyRaw.split(':');
const listen = Number(arg('listen', '7799'));
const quiet = process.argv.includes('--quiet');

let seq = 0;
const server = net.createServer((client) => {
  const id = ++seq;
  const up = net.connect(Number(proxyPort), proxyHost, () => {
    up.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Connection: keep-alive\r\n\r\n`);
  });

  let established = false;
  let head = Buffer.alloc(0);

  up.on('data', (chunk) => {
    if (established) return;
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf('\r\n\r\n');
    if (end < 0) return;                      // 响应头还没收全，继续攒
    const statusLine = head.slice(0, head.indexOf('\r\n')).toString();
    if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
      // 403/407 是组织出口策略拒绝，不要重试、不要绕路——照实报出来。
      console.error(`conn#${id} CONNECT 被拒: ${statusLine}`);
      client.destroy();
      up.destroy();
      return;
    }
    established = true;
    if (!quiet) console.log(`conn#${id} 已建立 -> ${target}`);
    const rest = head.slice(end + 4);         // 隧道建立后紧跟着的字节别丢
    if (rest.length) client.write(rest);
    up.pipe(client);
    client.pipe(up);
  });

  up.on('error', (e) => { if (!quiet) console.error(`conn#${id} 上游错误: ${e.message}`); client.destroy(); });
  client.on('error', () => up.destroy());
});

server.on('error', (e) => { console.error(`监听 ${listen} 失败: ${e.message}`); process.exit(1); });
server.listen(listen, '127.0.0.1', () => {
  console.log(`tunnel 127.0.0.1:${listen} -> ${proxyHost}:${proxyPort} -> ${target}`);
});
