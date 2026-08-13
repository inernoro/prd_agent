#!/usr/bin/env node
/**
 * HTTP 反代：浏览器(明文 HTTP) --> 本进程 --> TLS(经 tunnel.mjs) --> 目标站点
 *
 * 为什么要这一跳：Chromium 的信任库（~/.pki/nssdb）里往往没有 agent proxy 的 CA，
 * 而沙箱里通常没装 certutil 导不进去。**绝不能因此去关证书校验** —— 改成让
 * Node 来做 TLS：Node 读系统信任库（已含该 CA），校验一次不落；浏览器只跟
 * localhost 说明文 HTTP，压根不涉及证书。
 *
 * 代价：页面 origin 变成 http://127.0.0.1:<listen>。要保留真实 origin/cookie，
 * 用 SKILL.md 的方案 A（host-resolver-rules），代价是得先把 CA 导进 NSS。
 *
 * 用法：
 *   node relay.mjs --host cds.miduo.org [--listen 7801] [--upstream 7799] \
 *                  [--header 'X-AI-Access-Key: $KEY']  # 可重复
 *   --header 支持 $VAR / ${VAR}，值从环境变量取，避免密钥落进命令行历史与日志。
 */
import http from 'node:http';
import https from 'node:https';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function allArgs(name) {
  const out = [];
  process.argv.forEach((a, i) => { if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]); });
  return out;
}

const host = arg('host', '');
if (!host) {
  console.error("用法: node relay.mjs --host <域名> [--listen 7801] [--upstream 7799] [--header 'K: $ENV']");
  process.exit(2);
}
const listen = Number(arg('listen', '7801'));
const upstream = Number(arg('upstream', '7799'));

/** 注入头：值里的 $VAR 从环境变量展开；展开不出来就拒绝启动，别静默发一个空凭据。 */
const injected = {};
for (const raw of allArgs('header')) {
  const at = raw.indexOf(':');
  if (at < 0) { console.error(`--header 格式应为 'Key: value'，收到: ${raw}`); process.exit(2); }
  const key = raw.slice(0, at).trim().toLowerCase();
  const value = raw.slice(at + 1).trim().replace(/\$\{?(\w+)\}?/g, (_m, name) => process.env[name] ?? '');
  if (!value) { console.error(`--header ${key} 展开后为空（环境变量没设？），拒绝启动`); process.exit(2); }
  injected[key] = value;
}

http.createServer((req, res) => {
  const up = https.request({
    host: '127.0.0.1',
    port: upstream,
    servername: host,          // SNI 与证书校验都按真实域名走
    method: req.method,
    path: req.url,
    headers: {
      ...req.headers,
      host,
      ...injected,
      // 别让上游压缩：中间不解码时浏览器会拿到一段解不开的内容
      'accept-encoding': 'identity',
    },
  }, (upRes) => {
    res.writeHead(upRes.statusCode || 502, upRes.headers);
    upRes.pipe(res);           // 原样流式转发，SSE / chunked 都不缓冲
  });
  up.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`relay 上游错误: ${e.message}`);
  });
  req.pipe(up);
}).listen(listen, '127.0.0.1', () => {
  const names = Object.keys(injected);
  console.log(`relay http://127.0.0.1:${listen} -> https://${host} (经 127.0.0.1:${upstream})`);
  if (names.length) console.log(`注入请求头: ${names.join(', ')}（值不打印）`);
});
