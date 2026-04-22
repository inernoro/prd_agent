/**
 * 轻量撒花特效 —— emoji + CSS animation,无需 canvas / 第三方库。
 *
 * 调用 `fireConfetti()` 在屏幕上短暂飘落一阵 emoji,2.5s 后自动清理 DOM。
 * 用于:多步 Tour 完成、缺陷提交成功、首次发布知识库等"完结庆祝"场景。
 *
 * 设计取舍:
 * - SuccessConfettiButton 的 canvas 方案效果好但跟按钮 UI 紧耦合,提取成本高
 * - 这里走 emoji + transform animation,~50 行,够用且尊重 prefers-reduced-motion
 */

const EMOJIS = ['🎉', '✨', '🎊', '💫', '⭐', '🌟', '🎁', '🏆'];
const COUNT = 22;
const DURATION_MS = 2500;
const STYLE_ID = 'confetti-burst-keyframes';

function ensureKeyframes() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes confettiFall {
      0% { transform: translate3d(0, -10vh, 0) rotate(0deg) scale(.5); opacity: 0; }
      10% { opacity: 1; }
      100% { transform: translate3d(var(--cx, 0px), 110vh, 0) rotate(var(--cr, 720deg)) scale(1); opacity: 0; }
    }
  `;
  document.head.appendChild(style);
}

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** 在屏幕上撒一阵 emoji 庆祝。无副作用,可在任意时机调用。 */
export function fireConfetti() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (prefersReducedMotion()) return;

  ensureKeyframes();

  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText =
    'position:fixed;inset:0;pointer-events:none;z-index:99999;overflow:hidden;';

  for (let i = 0; i < COUNT; i++) {
    const span = document.createElement('span');
    const emoji = EMOJIS[i % EMOJIS.length];
    const startLeft = Math.random() * 100; // 0-100 vw
    const drift = (Math.random() * 240 - 120) | 0; // ±120px 横向漂移
    const rotate = ((Math.random() * 720 + 360) | 0) * (Math.random() > 0.5 ? 1 : -1);
    const delay = Math.random() * 400;
    const dur = DURATION_MS - 400 + Math.random() * 600;
    const fontSize = 18 + Math.random() * 18;

    span.textContent = emoji;
    span.style.cssText = `
      position:absolute;
      left:${startLeft}vw;
      top:-10vh;
      font-size:${fontSize}px;
      animation:confettiFall ${dur}ms cubic-bezier(.25,.46,.45,.94) ${delay}ms forwards;
      --cx:${drift}px;
      --cr:${rotate}deg;
      will-change:transform,opacity;
      user-select:none;
    `;
    host.appendChild(span);
  }

  document.body.appendChild(host);
  window.setTimeout(() => {
    host.remove();
  }, DURATION_MS + 800);
}
