/**
 * PWA Service Worker 注册。
 *
 * sw.js 只承担 Web Share Target 收件箱职责（手机截图分享 → 暂存 → 跳转缺陷提交面板），
 * 不做任何静态资源缓存，因此注册对现有页面加载行为零影响。
 */
export function registerPwaServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  // SW 需要安全上下文（https / localhost），非安全上下文注册会被浏览器拒绝，直接跳过
  if (typeof window !== 'undefined' && !window.isSecureContext) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[pwa] service worker 注册失败:', err);
    });
  });
}
