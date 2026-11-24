import { isIP } from 'node:net';

/** Canonical CIDRs, with union coverage checked as well as each individual prefix. */
export function normalizeRestrictedIpv4Allowlist(rules: string[]): string[] {
  if (rules.length > 20) throw new Error('IP allowlist 最多允许 20 项');
  const ranges = rules.map(rule => {
    const [ip, rawBits, ...rest] = typeof rule === 'string' ? rule.split('/') : [];
    const bits = Number(rawBits);
    if (isIP(ip || '') !== 4 || rest.length || !/^\d+$/.test(rawBits || '') || !Number.isInteger(bits) || bits < 1 || bits > 32) {
      throw new Error('白名单须为 IPv4/CIDR，禁止向所有 IP 放行');
    }
    const address = ip.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);
    const size = 2 ** (32 - bits), start = Math.floor(address / size) * size;
    const network = [3, 2, 1, 0].map(power => Math.floor(start / 256 ** power) % 256).join('.');
    return { start, end: start + size - 1, cidr: `${network}/${bits}` };
  });
  let coveredThrough = -1;
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    if (range.start > coveredThrough + 1) break;
    coveredThrough = Math.max(coveredThrough, range.end);
  }
  if (coveredThrough === 2 ** 32 - 1) throw new Error('白名单组合覆盖全部 IPv4，禁止向所有 IP 放行');
  return [...new Set(ranges.map(range => range.cidr))];
}
