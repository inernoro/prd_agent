/**
 * 「这个站点支不支持提问」的前端判据。
 *
 * 后端的唯一判定源是 AskAccessPolicy.UnsupportedReason —— 形态不支持时压过一切开关，
 * 包括「默认全开」。前端本不该维护业务映射表（frontend-architecture），但上传完成
 * 那段提示要在**没有后端往返**的情况下说清「这个站现在能不能问」，只能在本地判一次。
 *
 * 代价用守卫抵掉：askAvailability.test.ts 会去读后端那个文件，断言两边的不支持形态
 * 集合一模一样。后端哪天多加一种（比如纯音频），这里不跟着改就红——不会重演
 * 「后端改了口径、前端文案还在照旧承诺」那种事。
 */
export const ASK_UNSUPPORTED_ASSET_TYPES = ['video'] as const;

export function isAskSupported(site: { wrappedAssetType?: string | null }): boolean {
  const t = site.wrappedAssetType?.toLowerCase();
  if (!t) return true;
  return !ASK_UNSUPPORTED_ASSET_TYPES.includes(t as (typeof ASK_UNSUPPORTED_ASSET_TYPES)[number]);
}
