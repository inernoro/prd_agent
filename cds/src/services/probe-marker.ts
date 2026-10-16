/**
 * probe-marker — 存活监控探测请求的可信标记。
 *
 * 监控中心的探测（分支「用户视角」经预览域名、自定义监控打到预览地址）必须
 * **不**刷新分支 LRU、不记访问事件，否则每分钟一次的探测让分支永不降温
 * （uptime-monitor.ts 顶部纪律 1）。但「不算访问」这件事不能凭一个公开的
 * 请求头（`x-cds-poll`）判定：那个头任何客户端都能带，真实流量若带上它，
 * 一条正在被用的分支会被当成闲置停掉，访问遥测也跟着消失（Codex PR #1514 P2）。
 *
 * 所以代理侧只认这里签发的**进程级随机令牌**：探测器与代理跑在同一个 CDS 主
 * 进程里，默认令牌只在内存；独立 Forwarder 模式显式加载本机私有共享令牌，
 * 避免 master 重启后把旧监控误当用户。令牌不进日志或路由表。外部请求即使
 * 带上 `x-cds-poll: true` 也照常算访问；`x-cds-poll` 只继续做 http-log 的
 * 「polling」分类与活动面板降噪，不再决定 LRU。
 *
 * 令牌**只**随经预览域名的用户视角探测发出（那条请求由 CDS 自己的代理收下并在
 * 转发前抹掉）。直连分支容器的进程视角探测与打任意外部地址的自定义探测都不带：
 * 对端能看到请求头，拿到令牌就能回放到预览域名上豁免 LRU（Codex PR #1514 第二轮 P2）。
 */

import { randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

export const PROBE_MARKER_HEADER = 'x-cds-probe-token';

/** 进程级令牌：只在内存里，重启即换。 */
let probeMarkerToken = randomBytes(24).toString('hex');

/** 探测请求要带的头：可信令牌 + 公开的 polling 分类头（后者只影响日志分类）。 */
export function probeRequestHeaders(): Record<string, string> {
  return { 'x-cds-poll': 'true', [PROBE_MARKER_HEADER]: probeMarkerToken };
}

/** 代理侧判定：只有拿着本进程令牌的请求才是可信探测，才豁免 LRU 与访问记录。 */
export function isTrustedProbeRequest(headers: Record<string, unknown> | undefined): boolean {
  const raw = headers?.[PROBE_MARKER_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.length > 0 && value === probeMarkerToken;
}

/** 转发给上游前抹掉令牌，分支容器里的代码拿不到它。 */
export function stripProbeMarker(headers: Record<string, unknown> | undefined): void {
  if (headers && PROBE_MARKER_HEADER in headers) delete headers[PROBE_MARKER_HEADER];
}

/** 两进程共用稳定的本机探测身份；不放入公开路由表，不接受宽权限或符号链接。 */
export async function configureSharedProbeMarker(file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    const handle = await fs.open(file, 'wx', 0o600);
    try { await handle.writeFile(randomBytes(24).toString('hex')); }
    finally { await handle.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  for (let attempt = 0; attempt < 10; attempt++) {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 128) throw new Error('共享探测身份文件不可用，请检查本机文件权限');
      const token = (await handle.readFile('utf8')).trim();
      if (/^[a-f0-9]{48}$/.test(token)) { probeMarkerToken = token; return; }
      if (stat.size !== 0) throw new Error('共享探测身份文件无效，请检查受控发布配置');
    } finally { await handle.close(); }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('共享探测身份尚未初始化完成，请稍后重试');
}
