/**
 * 发布弹窗的地址与长文案判定 —— 全部纯函数，配套接线守卫见
 * cds/tests/web/start-release-dialog-frame.test.ts。
 *
 * 背景（2026-07-30 用户五张截图返工）：
 * 1. 「预览地址」此前由前端公式（resolvePreviewUrl）现推。公式恰好和 CDS 真实值
 *    一致时看不出问题，但它本质是「判据分裂」——CDS 后端才是预览地址的 SSOT
 *    （previewUrl / previewUrls 由 /api/branches 下发），一个分支可以有**多个**
 *    公开入口（主应用 + 网关控制台），公式只会算出其中一个。本模块改为
 *    **API 值优先，公式仅作兜底**。
 * 2. 弹窗只展示了来源预览地址，从不展示「发布到哪」。用户配置过生产上线地址
 *    （healthcheckUrl），看到一个 miduo.org 预览域名自然认为“地址不对”。
 *    发布弹窗必须同时说清「来源产物」与「上线地址」两端。
 * 3. 「发布策略完整」这条检查的 message 是整段生成脚本（几百行），直接内联渲染
 *    把弹窗撑到「使劲拉才能看到下一步」。长文案必须折叠成摘要 + 手动展开。
 */

export interface ReleasePreviewBranchLike {
  id: string;
  previewSlug?: string;
  /** CDS 后端算好的主预览地址（SSOT）。 */
  previewUrl?: string;
  /** 同一分支的全部公开入口；可能多于一个（主应用 + 网关控制台等）。 */
  previewUrls?: string[];
}

/**
 * 一个分支的全部公开预览入口，API 值优先。
 * previewUrls 缺席时退回单值 previewUrl；两者都缺时返回空数组，
 * 由调用方决定是否走公式兜底——本函数绝不自己拼域名。
 */
export function branchPreviewUrls(branch: ReleasePreviewBranchLike | undefined): string[] {
  if (!branch) return [];
  const urls = (branch.previewUrls || [])
    .map((url) => url.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (urls.length > 0) return [...new Set(urls)];
  const single = branch.previewUrl?.trim().replace(/\/+$/, '');
  return single ? [single] : [];
}

/**
 * 发布来源地址的取值次序：
 * 1. promote 传入的源 run 产物地址（那次发布验证过的就是它，不重新推导）；
 * 2. CDS API 下发的 previewUrl / previewUrls（SSOT）；
 * 3. 调用方公式推导 / port 模式现取的兜底值。
 * 返回全量列表，首个是主入口（会作为 previewUrl 提交给发布接口）。
 */
export function resolveReleaseSourceUrls(input: {
  intentPreviewUrl?: string;
  branch?: ReleasePreviewBranchLike;
  fallbackUrl?: string;
}): string[] {
  const pinned = input.intentPreviewUrl?.trim();
  if (pinned) return [pinned];
  const fromApi = branchPreviewUrls(input.branch);
  if (fromApi.length > 0) return fromApi;
  const fallback = input.fallbackUrl?.trim();
  return fallback ? [fallback] : [];
}

/**
 * 发布目标的「上线地址」——用户在向导里配置过的那一端。
 * 向导里填的生产域名最终固化成 healthcheckUrl（`https://host/api/version`
 * 这种形状，后端不单存域名），所以这里从 healthcheckUrl 剥出 origin 即站点入口。
 * 拿不到返回空串，调用方显示「未配置」，不编造。
 */
export function releaseTargetPublicUrl(target: {
  ssh?: { healthcheckUrl?: string };
} | undefined): string {
  const healthcheck = target?.ssh?.healthcheckUrl?.trim();
  if (!healthcheck) return '';
  try {
    return new URL(healthcheck).origin;
  } catch {
    return '';
  }
}

export interface CollapsedCheckMessage {
  /** 永远展示的一行摘要。 */
  summary: string;
  /** 超长时的完整内容；短文案没有这个字段（也就不渲染展开按钮）。 */
  detail?: string;
  /** detail 的行数，用于「展开完整内容（N 行）」按钮文案。 */
  lineCount: number;
}

const CHECK_MESSAGE_SUMMARY_MAX = 160;

/**
 * 发布前检查的 message 折叠判定。
 * 多行或超长（>160 字符）都算长文案：摘要取首个非空行截断，完整内容进 detail。
 */
export function collapseCheckMessage(message: string): CollapsedCheckMessage {
  const normalized = message.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const firstLine = lines.find((line) => line.trim()) || '';
  const isLong = lines.length > 1 || firstLine.length > CHECK_MESSAGE_SUMMARY_MAX;
  if (!isLong) return { summary: firstLine, lineCount: 1 };
  const summary = firstLine.length > CHECK_MESSAGE_SUMMARY_MAX
    ? `${firstLine.slice(0, CHECK_MESSAGE_SUMMARY_MAX)}…`
    : firstLine;
  return { summary, detail: normalized, lineCount: lines.length };
}

/**
 * 日志窗格是否应继续吸附到底部。
 * 判据：距底部 ≤ 48px 视为「用户在看最新」，新日志到达时自动跟进；
 * 用户往上翻超过这个距离就暂停跟随，等他自己点「回到最新」。
 */
export function shouldFollowLog(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= 48;
}
