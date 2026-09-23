import { useEffect, useLayoutEffect, useState } from 'react';

/**
 * 配图「显影中」占位：按目标尺寸比例画出一张正在成形的画框。
 *
 * 替代原来的两种加载态：
 * - 右侧卡片里的 PrdPetalBreathingLoader（一团模糊光晕，看不出在生成什么，浅色下发脏）；
 * - 正文里的 `> 配图 N 生成中...` 引用块（静止文字，看不出进展）。
 *
 * 设计取舍：
 * - 形状即产物：外框就是最终图片的比例，里面是淡淡的构图骨架（地平线 / 光源 / 两块主体），
 *   用户在等待期看到的是「这张图正在显影」，而不是一个通用 spinner。
 * - 变化可感知：斜向扫光 + 底部不定进度条 + 每秒递增的已等待时长。
 *   生图接口没有真实进度，所以只给已等待时长，不编造百分比或预估。
 * - 颜色全部走主题 token（--nested-block-bg / --border-* / --text-* / --accent-primary），
 *   暗色与浅色两套皮肤都成立。
 */

const STYLE_ID = 'literary-developing-placeholder-styles';

const CSS = `
.lit-dev {
  position: relative;
  width: 100%;
  overflow: hidden;
  border-radius: 10px;
  background: var(--nested-block-bg);
  border: 1px solid var(--border-subtle);
  isolation: isolate;
}
.lit-dev-sketch {
  position: absolute;
  inset: 0;
  color: var(--border-default);
  animation: lit-dev-breathe 2.6s ease-in-out infinite;
}
.lit-dev-sweep {
  position: absolute;
  inset: -20% -60%;
  background: linear-gradient(
    105deg,
    transparent 38%,
    color-mix(in srgb, var(--accent-primary) 16%, transparent) 50%,
    transparent 62%
  );
  animation: lit-dev-sweep 2.2s cubic-bezier(0.45, 0, 0.35, 1) infinite;
  z-index: 1;
}
.lit-dev-meta {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-secondary);
  z-index: 2;
}
.lit-dev-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 600;
}
.lit-dev-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-primary);
  animation: lit-dev-dot 1.2s ease-in-out infinite;
}
.lit-dev-elapsed {
  flex: none;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
}
.lit-dev-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  overflow: hidden;
  background: var(--border-subtle);
  z-index: 2;
}
.lit-dev-bar::after {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  width: 36%;
  background: var(--accent-primary);
  border-radius: 2px;
  animation: lit-dev-bar 1.6s ease-in-out infinite;
}
.lit-dev--compact { border-radius: 8px; }
.lit-dev--compact .lit-dev-meta {
  top: 0;
  bottom: 0;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  font-size: 12px;
}
@keyframes lit-dev-sweep {
  0% { transform: translateX(-45%); }
  100% { transform: translateX(45%); }
}
@keyframes lit-dev-breathe {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}
@keyframes lit-dev-dot {
  0%, 100% { transform: scale(0.7); opacity: 0.5; }
  50% { transform: scale(1); opacity: 1; }
}
@keyframes lit-dev-bar {
  0% { left: -36%; }
  100% { left: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .lit-dev-sketch, .lit-dev-sweep, .lit-dev-dot, .lit-dev-bar::after { animation: none; }
  .lit-dev-sweep { display: none; }
  .lit-dev-bar::after { left: 0; width: 100%; opacity: 0.4; }
}
`;

function ensureStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

/** 把 "1024x1536" 这类尺寸串解析成宽高比；解析不出按 1:1。 */
export function ratioFromSize(size?: string | null): number {
  const [w, h] = String(size || '').split(/[xX×]/).map(Number);
  return w > 0 && h > 0 ? w / h : 1;
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `已等待 ${s}s`;
  const m = Math.floor(s / 60);
  return `已等待 ${m}:${String(s % 60).padStart(2, '0')}`;
}

export interface IllustrationDevelopingPlaceholderProps {
  /** 目标图片宽高比（宽 / 高） */
  ratio: number;
  /** 左下角文案，如「配图 1 生成中」 */
  label: string;
  /** 开始时间（ms）。不传则从组件挂载时起算。 */
  startedAt?: number;
  /** 卡片内的紧凑模式：撑满父容器，文案居中（避开卡片底部的提示词浮层） */
  fill?: boolean;
  className?: string;
}

export function IllustrationDevelopingPlaceholder({
  ratio,
  label,
  startedAt,
  fill,
  className,
}: IllustrationDevelopingPlaceholderProps) {
  useLayoutEffect(ensureStyles, []);
  const [mountedAt] = useState(() => Date.now());
  const origin = startedAt ?? mountedAt;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;

  return (
    <div
      className={`lit-dev${fill ? ' lit-dev--compact' : ''}${className ? ` ${className}` : ''}`}
      style={fill ? { height: '100%' } : { aspectRatio: String(safeRatio) }}
      role="status"
      aria-live="polite"
      aria-label={label}
      data-generating="true"
    >
      <svg
        className="lit-dev-sketch"
        viewBox="0 0 100 100"
        preserveAspectRatio="xMidYMax slice"
        aria-hidden="true"
      >
        <circle cx="80" cy="24" r="8" fill="currentColor" opacity="0.9" />
        <path d="M0 70 L24 50 L42 62 L62 42 L100 68 L100 100 L0 100 Z" fill="currentColor" opacity="0.55" />
        <path d="M0 80 L30 66 L58 78 L100 72 L100 100 L0 100 Z" fill="currentColor" opacity="0.8" />
      </svg>
      <div className="lit-dev-sweep" aria-hidden="true" />
      <div className="lit-dev-meta">
        <span className="lit-dev-label">
          <span className="lit-dev-dot" aria-hidden="true" />
          {label}
        </span>
        <span className="lit-dev-elapsed" aria-hidden="true">{formatElapsed(now - origin)}</span>
      </div>
      <div className="lit-dev-bar" aria-hidden="true" />
    </div>
  );
}
