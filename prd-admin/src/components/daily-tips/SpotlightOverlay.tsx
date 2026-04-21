import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SPOTLIGHT_TARGET_KEY } from './TipsRotator';

/**
 * JetBrains-style 功能高亮：从 sessionStorage 读取 selector，
 * 在目标元素外围画一个 pulse 光圈 + 半透明遮罩引导用户注意。
 *
 * 触发：挂载时读取 sessionStorage[SPOTLIGHT_TARGET_KEY];
 * 退出：点击遮罩 / 按 ESC / 5 秒自动消失；
 * 设计：fixed 定位，createPortal 到 body 避免父 transform 干扰。
 */
export function SpotlightOverlay() {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [selector, setSelector] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = sessionStorage.getItem(SPOTLIGHT_TARGET_KEY);
    } catch {
      /* 忽略 */
    }
    if (!stored) return;

    // 消费一次就清理，避免下次访问同路由还弹光圈
    try {
      sessionStorage.removeItem(SPOTLIGHT_TARGET_KEY);
    } catch {
      /* 忽略 */
    }

    // 等待 DOM 就绪：AgentLauncherPage 有 Reveal 动效 + 异步资产加载，保守等 400ms 再找
    const findAndAttach = () => {
      try {
        const el = document.querySelector(stored!);
        if (!el) return false;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const box = el.getBoundingClientRect();
        setRect(box);
        setSelector(stored);
        return true;
      } catch {
        return false;
      }
    };

    // 多次轮询直到元素出现或超时
    let attempts = 0;
    const maxAttempts = 20; // 20 * 150ms = 3s 上限
    const pollId = window.setInterval(() => {
      attempts += 1;
      if (findAndAttach() || attempts >= maxAttempts) {
        window.clearInterval(pollId);
      }
    }, 150);

    return () => {
      window.clearInterval(pollId);
    };
  }, []);

  useEffect(() => {
    if (!rect) return;

    // 5 秒自动淡出
    timerRef.current = window.setTimeout(() => setRect(null), 5000);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRect(null);
    };
    const onResize = () => {
      if (!selector) return;
      try {
        const el = document.querySelector(selector);
        if (el) setRect(el.getBoundingClientRect());
      } catch {
        /* noop */
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);

    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
    };
  }, [rect, selector]);

  if (!rect) return null;

  const PAD = 8;
  const ringStyle: React.CSSProperties = {
    position: 'fixed',
    left: rect.left - PAD,
    top: rect.top - PAD,
    width: rect.width + PAD * 2,
    height: rect.height + PAD * 2,
    borderRadius: 12,
    pointerEvents: 'none',
    boxShadow:
      '0 0 0 2px rgba(129, 140, 248, 0.9), 0 0 0 9999px rgba(0, 0, 0, 0.55), 0 0 30px 6px rgba(129, 140, 248, 0.55)',
    animation: 'spotlightPulse 1.6s ease-out infinite',
    zIndex: 9998,
  };

  const overlay = (
    <>
      <div
        aria-label="关闭高亮引导"
        onClick={() => setRect(null)}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9997,
          cursor: 'pointer',
          background: 'transparent',
        }}
      />
      <div style={ringStyle} />
      <style>{`
        @keyframes spotlightPulse {
          0%   { box-shadow: 0 0 0 2px rgba(129,140,248,0.9), 0 0 0 9999px rgba(0,0,0,0.55), 0 0 20px 4px rgba(129,140,248,0.5); }
          50%  { box-shadow: 0 0 0 3px rgba(167,139,250,1),  0 0 0 9999px rgba(0,0,0,0.55), 0 0 40px 10px rgba(167,139,250,0.75); }
          100% { box-shadow: 0 0 0 2px rgba(129,140,248,0.9), 0 0 0 9999px rgba(0,0,0,0.55), 0 0 20px 4px rgba(129,140,248,0.5); }
        }
      `}</style>
    </>
  );

  return createPortal(overlay, document.body);
}
