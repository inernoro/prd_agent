export function getDefectDeepLinkId(searchParams: URLSearchParams): string | null {
  return searchParams.get('defectId') || searchParams.get('id');
}

export function clearDefectDeepLinkParams(searchParams: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(searchParams);
  next.delete('defectId');
  next.delete('id');
  return next;
}

/**
 * ?action=submit —— 直接拉起提交缺陷面板的深链。
 * 手机截图经 PWA share_target 分享后由 sw.js 重定向到
 * /defect-agent?action=submit&shared=1 落到这里。
 */
export function hasDefectSubmitAction(searchParams: URLSearchParams): boolean {
  return searchParams.get('action') === 'submit';
}

export function clearDefectSubmitActionParams(searchParams: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(searchParams);
  next.delete('action');
  next.delete('shared');
  return next;
}
