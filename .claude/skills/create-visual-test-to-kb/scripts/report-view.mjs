// 与 CDS CLI 的既有 HTTP/HTTPS、裸主机和本机默认协议合同一致；只比较精确目标 host。
export function isConfiguredCdsTargetHost(targetHost, configuredHost) {
  let host = String(configuredHost || '').trim();
  if (!host) return false;
  if (!host.includes('://')) {
    const local = ['localhost', '127.', '0.0.0.0', '[::1]', '192.168.', '10.', '172.']
      .some(prefix => host.startsWith(prefix));
    host = (local ? 'http://' : 'https://') + host;
  }
  try {
    const parsed = new URL(host);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return false;
    return Boolean(parsed.host) && String(targetHost || '').toLowerCase() === parsed.host.toLowerCase();
  } catch {
    return false;
  }
}
