import { toast } from './toast';

/**
 * 健壮的剪贴板复制工具（SSOT）。
 *
 * 为什么需要它：直接调用 `navigator.clipboard.writeText` 在以下场景会抛错或静默失败，
 * 而过去各页面既不接错误也不判返回值，导致按钮显示「已复制」但剪贴板其实是空的（假成功）：
 * - 非安全上下文（http:// 或部分内嵌 WebView）下 `navigator.clipboard` 为 undefined
 * - iOS Safari / 企业微信 / 钉钉等内嵌浏览器对 Clipboard API 的权限限制
 * - 用户拒绝剪贴板权限
 *
 * 本函数：优先用现代异步 API（仅安全上下文），失败回落到 `execCommand` 兜底，
 * 始终返回真实的成功布尔值，绝不假成功。
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;

  // 1. 现代异步 API —— 仅在安全上下文可用，且需 try/catch 兜住权限拒绝
  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === 'function' &&
      typeof window !== 'undefined' &&
      window.isSecureContext
    ) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落到 execCommand 兜底
  }

  // 2. execCommand 兜底 —— 兼容非安全上下文 / 老内嵌浏览器
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    // iOS 需要显式 setSelectionRange 才能选中
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * 复制 + 统一反馈。成功弹成功 toast；失败弹错误 toast 提示用户长按手动复制——绝不假成功。
 *
 * 用 toast 而非 systemDialog，是因为 ToastContainer 挂在 App 根（公开页也可用），
 * 而 SystemDialogHost 只在 AppShell 内（公开安装页拿不到）。
 *
 * @returns 是否真的复制成功
 */
export async function copyWithFeedback(
  text: string,
  opts?: { successMessage?: string; label?: string },
): Promise<boolean> {
  const ok = await copyToClipboard(text);
  if (ok) {
    toast.success(opts?.successMessage ?? '已复制到剪贴板');
  } else {
    toast.error(
      opts?.label ? `${opts.label}复制失败` : '复制失败',
      '当前环境不支持自动复制，请长按文本手动选中复制',
    );
  }
  return ok;
}
