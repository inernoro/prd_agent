/**
 * 心型点赞按钮特效 - 基于 thirdparty/ref/心型动画.html
 * 点击时有心跳缩放、粒子爆发、波纹扩散三重动效
 */

import { useCallback, useState } from 'react';

const PARTICLE_COLORS = ['#7642F0', '#AFD27F', '#DE8F4F', '#D0516B', '#5686F2', '#D53EF3'];

interface HeartLikeButtonProps {
  liked?: boolean;
  /** 按钮整体尺寸（em 基准），默认 48px */
  size?: number;
  /** 心型颜色，默认 #EA442B */
  heartColor?: string;
  /** 粒子数量，默认 6 */
  particleCount?: number;
  onClick?: () => void;
  className?: string;
  disabled?: boolean;
}

export function HeartLikeButton({
  liked = false,
  size = 48,
  heartColor = '#EA442B',
  particleCount = 6,
  onClick,
  className = '',
  disabled = false,
}: HeartLikeButtonProps) {
  // 用 React state 管理动画，避免 classList 与 React className 冲突
  const [animKey, setAnimKey] = useState(0);

  const handleClick = useCallback(() => {
    if (disabled) return;
    // 递增 key 触发 wrapper 重新挂载，从而重启所有 CSS 动画
    setAnimKey((k) => k + 1);
    onClick?.();
  }, [disabled, onClick]);

  const particles = Array.from({ length: particleCount }, (_, i) => i + 1);

  return (
    <>
      <style>{heartLikeStyles(heartColor)}</style>
      <button
        type="button"
        className={`hlb-button ${liked ? 'hlb-liked' : ''} ${animKey > 0 ? 'hlb-animate' : ''} ${className}`}
        style={{ fontSize: `${size}px` }}
        onClick={handleClick}
        disabled={disabled}
        aria-label={liked ? '取消点赞' : '点赞'}
      >
        {/* key 变化时 React 重新挂载 wrapper，CSS 动画自动重新播放 */}
        <div className="hlb-wrapper" key={animKey}>
          <div className="hlb-ripple" />
          <svg className="hlb-heart" width="24" height="24" viewBox="0 0 24 24">
            <path d="M12,21.35L10.55,20.03C5.4,15.36 2,12.27 2,8.5C2,5.41 4.42,3 7.5,3C9.24,3 10.91,3.81 12,5.08C13.09,3.81 14.76,3 16.5,3C19.58,3 22,5.41 22,8.5C22,12.27 18.6,15.36 13.45,20.03L12,21.35Z" />
          </svg>
          <div className="hlb-particles" style={{ '--total-particles': particleCount } as React.CSSProperties}>
            {particles.map((i) => (
              <div
                key={i}
                className="hlb-particle"
                style={{
                  '--i': i,
                  '--color': PARTICLE_COLORS[(i - 1) % PARTICLE_COLORS.length],
                } as React.CSSProperties}
              />
            ))}
          </div>
        </div>
      </button>
    </>
  );
}

function heartLikeStyles(heartColor: string) {
  return `
    .hlb-button {
      --color-heart: ${heartColor};
      --easing: cubic-bezier(.7,0,.3,1);
      --duration: .5s;
      appearance: none;
      border: none;
      border-radius: 50%;
      background: transparent;
      width: 1em;
      height: 1em;
      padding: 0;
      margin: 0;
      outline: none;
      cursor: pointer;
      position: relative;
      box-sizing: border-box;
      transition: transform var(--duration) var(--easing);
    }
    .hlb-button:disabled { cursor: default; }

    .hlb-wrapper {
      display: grid;
      align-items: center;
      justify-content: center;
      position: relative;
      box-sizing: border-box;
    }
    .hlb-wrapper > * {
      margin: auto;
      grid-area: 1 / 1;
      position: relative;
      box-sizing: border-box;
    }

    .hlb-heart {
      width: .55em;
      height: .55em;
      display: block;
      transform-origin: center 80%;
      position: relative;
      box-sizing: border-box;
    }
    .hlb-heart > path {
      stroke: var(--color-heart);
      stroke-width: 2;
      fill: transparent;
      transition: fill var(--duration) var(--easing);
    }
    .hlb-liked .hlb-heart > path {
      fill: var(--color-heart);
    }

    /* Animate on click */
    .hlb-animate .hlb-heart {
      animation: hlb-heart-bounce var(--duration) var(--easing);
    }
    .hlb-animate .hlb-heart > path {
      fill: var(--color-heart);
    }

    @keyframes hlb-heart-bounce {
      40% { transform: scale(0.7); }
      0%, 80%, 100% { transform: scale(1); }
    }

    /* Particles */
    .hlb-particles {
      width: 1px;
      height: 1px;
      position: relative;
      box-sizing: border-box;
    }
    .hlb-particle {
      position: absolute;
      top: 0;
      left: 0;
      height: .1em;
      width: .1em;
      border-radius: .05em;
      background-color: var(--color);
      --percentage: calc(var(--i) / var(--total-particles));
      --theta: calc(var(--percentage) * 1turn);
      transform: translate(-50%, -50%) rotate(var(--theta)) translateY(0) scaleY(0);
      transition: all var(--duration) var(--easing);
      box-sizing: border-box;
    }
    .hlb-animate .hlb-particle {
      animation: hlb-particles-out calc(var(--duration) * 1.2) var(--easing) forwards;
    }
    @keyframes hlb-particles-out {
      50% { height: .3em; }
      50%, 60% {
        height: .3em;
        transform: translate(-50%, -50%) rotate(var(--theta)) translateY(0.8em) scale(1);
      }
      60% { height: .2em; }
      100% {
        transform: translate(-50%, -50%) rotate(var(--theta)) translateY(1em) scale(0);
      }
    }

    /* Ripple */
    .hlb-ripple {
      height: 1em;
      width: 1em;
      border-radius: 50%;
      overflow: hidden;
      z-index: 1;
      position: relative;
      box-sizing: border-box;
    }
    .hlb-ripple:before {
      content: '';
      position: absolute;
      top: 0; left: 0;
      width: 100%; height: 100%;
      border: 0.4em solid var(--color-heart);
      border-radius: inherit;
      transform: scale(0);
      box-sizing: border-box;
    }
    .hlb-animate .hlb-ripple:before {
      animation: hlb-ripple-out var(--duration) var(--easing);
    }
    @keyframes hlb-ripple-out {
      from { transform: scale(0); }
      to { transform: scale(5); }
    }
  `;
}
