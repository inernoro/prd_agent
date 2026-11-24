import { isIP } from 'node:net';

/** Opt-in per instance; HTTP preview domains are never assumed to serve TCP. */
export function resourceTcpAccessConfig(env: NodeJS.ProcessEnv = process.env): { enabled: boolean; host: string; bindIp: string; reason: string } {
  const host = (env.CDS_RESOURCE_TCP_HOST || '').trim();
  const bindIp = (env.CDS_RESOURCE_TCP_BIND_IP || '').trim();
  const optedIn = env.CDS_RESOURCE_TCP_ENABLED === '1';
  const valid = isIP(host) === 4 && isIP(bindIp) === 4 && host !== '0.0.0.0' && bindIp !== '0.0.0.0' && !host.startsWith('127.') && !bindIp.startsWith('127.');
  return { enabled: optedIn && valid, host: valid ? host : '', bindIp: valid ? bindIp : '', reason: optedIn && valid ? '' : '本实例未配置临时 TCP 直连入口，请联系管理员；仍可使用 SSH 隧道。' };
}

/** Runs in the proxy container. Its deadline works even while CDS is stopped. */
export const RESOURCE_TCP_PROXY_SCRIPT = `
const net = require('net');
const deadline = Date.parse(process.env.EXPIRES_AT || '');
if (!Number.isFinite(deadline)) throw new Error('EXPIRES_AT is required');
const block = new net.BlockList();
const allowlist = (process.env.ALLOWLIST || '').split(',').filter(Boolean);
if (!allowlist.length) throw new Error('ALLOWLIST is required');
for (const rule of allowlist) {
  const [ip, prefixRaw] = rule.split('/');
  const prefix = Number(prefixRaw || '32');
  if (!Number.isInteger(prefix) || prefix < 1 || prefix > 32) throw new Error('Invalid allowlist');
  block.addSubnet(ip, prefix, 'ipv4');
}
const sockets = new Set();
const server = net.createServer((client) => {
  const ip = String(client.remoteAddress || '').replace(/^::ffff:/, '');
  if (Date.now() >= deadline || !block.check(ip, 'ipv4')) { client.destroy(); return; }
  sockets.add(client);
  client.on('close', () => sockets.delete(client));
  const upstream = net.connect({ host: process.env.TARGET_HOST, port: Number(process.env.TARGET_PORT) });
  sockets.add(upstream);
  upstream.on('close', () => sockets.delete(upstream));
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
  client.on('close', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
  client.pipe(upstream); upstream.pipe(client);
});
function expire() {
  server.close();
  for (const socket of sockets) socket.destroy();
}
if (Date.now() < deadline) {
  server.listen(Number(process.env.LISTEN_PORT || 15432), '0.0.0.0');
  setTimeout(expire, deadline - Date.now());
}
// A restart after expiry stays closed until the controller removes the container.
setInterval(() => {}, 3600000);
process.on('SIGTERM', () => { expire(); process.exit(0); });
process.on('SIGINT', () => { expire(); process.exit(0); });
`;
