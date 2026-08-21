/**
 * 同意页要不要让管理员额外勾一次「我确认这台机器可信」。
 *
 * 这条判据在服务端也有一份（`DataSyncProviderController.Authorize` 里的
 * `if (!enabled || !originAllowed)`），两边必须说同一句话。曾经界面只看
 * `originAllowed`，于是「来源已在名单里、但对外同步开关被关掉了」那一种情况下
 * 确认框不显示、同意按钮却是可点的——点一次 409 一次，界面上没有任何动作能救回来。
 *
 * 抽成独立函数是为了能直接对四种组合断言（本仓库前端没有 jsdom/RTL，
 * 逻辑留在组件里就没有任何东西钉得住它和服务端的一致性）。
 */
export interface TrustReadiness {
  providerEnabled: boolean;
  originAllowed: boolean;
}

export function shouldRequireTrustConfirm(readiness: TrustReadiness | null | undefined): boolean {
  // readiness 还没拉回来时不催人勾：此时按钮另有 loading 态挡着，
  // 提前显示一个理由未知的确认框只会让人困惑。
  if (!readiness) return false;
  return !readiness.providerEnabled || !readiness.originAllowed;
}
