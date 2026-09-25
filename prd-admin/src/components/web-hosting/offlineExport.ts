/**
 * 「下载离线 HTML」的结论与失败文案。
 *
 * 服务端把网页的样式、脚本、图片、字体都内嵌进一个 HTML 文件。它有两种结论要讲给用户：
 * - 成功，但有几处引用没能装进去（站点里本来就没有 / 读取失败 / 指向站点目录之外）——
 *   结论放在响应头 `X-Offline-Export-Missing-*`，这里解析成一句人话；
 * - 失败——后端给的是**结构化错误码**，这里按码出文案（能用状态就用状态，不去匹配句子里的字）。
 */
import { ApiDownloadError } from '@/services/real/apiClient';

export const OFFLINE_EXPORT_MISSING_COUNT_HEADER = 'X-Offline-Export-Missing-Count';
export const OFFLINE_EXPORT_MISSING_HEADER = 'X-Offline-Export-Missing';

export type OfflineMissingReason = 'not-in-site' | 'outside-site-root' | 'read-failed';

export interface OfflineMissingItem {
  reason: OfflineMissingReason;
  reference: string;
}

export interface OfflineExportSummary {
  /** 没装进去的引用总数（头里的明细最多 20 条，总数以这个为准） */
  missingCount: number;
  missing: OfflineMissingItem[];
}

const KNOWN_REASONS = new Set<OfflineMissingReason>(['not-in-site', 'outside-site-root', 'read-failed']);

/** 解析 `原因:百分号编码路径,原因:路径…`。认不出的原因与解不开的编码逐条丢弃，不让一条坏数据拖垮整句结论。 */
export function parseMissingHeader(header: string | null | undefined): OfflineMissingItem[] {
  if (!header) return [];
  const items: OfflineMissingItem[] = [];
  for (const part of header.split(',')) {
    const colon = part.indexOf(':');
    if (colon <= 0) continue;
    const reason = part.slice(0, colon).trim() as OfflineMissingReason;
    if (!KNOWN_REASONS.has(reason)) continue;
    try {
      const reference = decodeURIComponent(part.slice(colon + 1).trim());
      if (reference) items.push({ reason, reference });
    } catch {
      // 编码坏了就跳过这一条
    }
  }
  return items;
}

export function readOfflineExportSummary(headers?: Headers | null): OfflineExportSummary {
  const missing = parseMissingHeader(headers?.get(OFFLINE_EXPORT_MISSING_HEADER));
  const declared = Number.parseInt(headers?.get(OFFLINE_EXPORT_MISSING_COUNT_HEADER) ?? '', 10);
  return {
    missingCount: Number.isFinite(declared) && declared >= missing.length ? declared : missing.length,
    missing,
  };
}

const REASON_LABEL: Record<OfflineMissingReason, string> = {
  'not-in-site': '站点里找不到',
  'outside-site-root': '指向网页目录之外',
  'read-failed': '暂时读取失败',
};

/** 下载成功后给用户的那句话：全装进去了就说能断网打开；有缺口就说清缺了几处、为什么、会怎样。 */
export function describeOfflineExportResult(summary: OfflineExportSummary): { text: string; tone: 'info' | 'warning' } {
  if (summary.missingCount === 0) {
    return { text: '已下载离线版网页：样式、脚本和图片都装在这一个文件里，断网也能打开。', tone: 'info' };
  }
  const byReason = new Map<OfflineMissingReason, number>();
  for (const item of summary.missing) byReason.set(item.reason, (byReason.get(item.reason) ?? 0) + 1);
  const breakdown = [...byReason.entries()].map(([reason, n]) => `${REASON_LABEL[reason]} ${n} 处`).join('、');
  const sample = summary.missing.slice(0, 3).map((m) => m.reference).join('、');
  const hasReadFailure = byReason.has('read-failed');
  return {
    text: `已下载离线版网页，但有 ${summary.missingCount} 处资源没能装进去`
      + (breakdown ? `（${breakdown}）` : '')
      + '，离线打开时这些位置会缺图或缺样式'
      + (sample ? `，例如 ${sample}` : '')
      + (hasReadFailure ? '。读取失败的那几处过一会儿重新下载通常能补上。' : '。'),
    tone: 'warning',
  };
}

/**
 * 失败文案表：一个错误码一行。第一句说发生了什么（外因），再说要不要紧、下一步做什么。
 * 表里没有的码退回下载器已经净化过的原文。
 */
const FAILURE_BY_CODE: Record<string, string> = {
  OFFLINE_EXPORT_TOO_LARGE:
    '这个网页把图片、字体和脚本都装进一个文件后会超过 20MB，所以这次没有生成下载。线上网页不受影响；请先压缩或删掉大图片、视频后再试，或用「新窗口打开」在浏览器里另存。',
  OFFLINE_EXPORT_WRAPPED_ASSET:
    '这是 PDF / 视频包装出来的网页，正文是那份原始文件而不是网页，打不成离线版。线上网页不受影响；请直接打开源文件另存。',
  OFFLINE_EXPORT_ENTRY_NOT_HTML:
    '这个网页的入口文件不是 HTML，没有可以打包的网页。线上网页不受影响；请用「新窗口打开」在浏览器里另存。',
  OFFLINE_EXPORT_ENTRY_MISSING:
    '这个网页的入口文件已经不在了（多半被重新上传或删除过），无法打包。请重新上传网页后再试。',
  OFFLINE_EXPORT_CSP_META:
    '这个网页在页面里声明了自己的内容安全策略，它会拦下离线打包时内嵌进来的样式、脚本和图片，下载的文件打开后显示不正常，所以这次没有生成下载。线上网页不受影响；请改用在线分享链接查看，或去掉页面里的这条安全策略后重新发布再下载。',
  OFFLINE_EXPORT_ENTRY_UNREADABLE:
    '暂时从存储里读不到这个网页的入口文件，所以这次没有生成下载。网页本身没有被改动；过一会儿再试，一直不行请联系管理员检查存储。',
  SHARE_PASSWORD_REQUIRED:
    '这条分享设置了访问密码，下载前要先在页面上输入正确的密码。输入后再点一次下载即可。',
  SHARE_EXPIRED: '这条分享链接已经过期，所以不能再下载。请让分享者续期或重新分享。',
  SHARE_REVOKED: '这条分享链接已经被撤销，所以不能再下载。请让分享者重新分享。',
  VISIBILITY_DENIED: '这条分享只对特定的人开放，你当前的账号不在范围内，所以不能下载。请让分享者调整可见范围。',
  NOT_FOUND: '这个网页已经不存在，或你没有编辑它的权限，所以不能下载。请返回列表刷新后再试。',
  RATE_LIMITED: '刚才尝试得太频繁，服务端暂时拦下了这次下载。请稍等一分钟再试。',
};

export function describeOfflineExportFailure(error: unknown): { text: string; detail?: string } {
  const code = error instanceof ApiDownloadError ? error.code.trim().toUpperCase() : '';
  const known = FAILURE_BY_CODE[code];
  if (known) return { text: known };
  const raw = error instanceof Error ? error.message.trim() : '';
  return {
    text: '离线版网页没有下载成功，稍后再试一次；一直不行请联系管理员。',
    detail: raw || undefined,
  };
}

/**
 * 打包中的按钮文字：头 2 秒只说在打包；之后带上已等待的秒数让画面持续在动；
 * 过了 15 秒补一句为什么慢，免得用户以为卡死了。
 */
export function offlineExportProgressLabel(elapsedSeconds: number): string {
  if (elapsedSeconds < 2) return '正在打包…';
  if (elapsedSeconds < 15) return `正在打包 · ${elapsedSeconds} 秒`;
  return `图片较多，仍在打包 · ${elapsedSeconds} 秒`;
}
