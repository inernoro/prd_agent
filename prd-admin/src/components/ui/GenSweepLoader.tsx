import { useEffect, useRef, useState } from 'react';
import { getGenAvgMs } from '@/lib/genTiming';
import { MapSpinner } from '@/components/ui/VideoLoader';

// build-marker: gen-sweep-loader v2 (2026-08-02) — 朦胧底稿 + 点阵等待态

/**
 * GenSweepLoader — 生图等待「朦胧预览 + 点阵生长」加载动效
 *
 * 设计：有参考图时把参考图作为朦胧底稿；纯文生图时使用环境渐变。
 * 点阵与柔和扫光表达“图像正在成形”，底部状态条继续展示耗时、预估与渐进进度。
 * 倒计时直接做进动效：进度条按 已耗时/预计 逼近、封顶 95%（出图替换占位才算 100%），
 * 超过预计转黄显示「即将完成」，避免「卡 93%」式假精确。
 *
 * 性能：图片只做 blur/scale，点阵只动画 background-position/opacity，全局样式单例注入。
 * 可读性：底部计时条用 invZoom 反缩放，任意画布缩放下文字与进度条都保持清晰可读。
 * 无障碍：系统要求减少动态效果时关闭点阵、扫光与进度过渡。
 */

const STYLE_ID = 'gen-sweep-loader-styles';
const GLOBAL_CSS = `
.gen-sweep{position:absolute;inset:0;overflow:hidden;border-radius:inherit;pointer-events:none;
  background:
    radial-gradient(circle at 18% 24%,rgba(99,102,241,.42),transparent 36%),
    radial-gradient(circle at 78% 68%,rgba(236,72,153,.24),transparent 42%),
    radial-gradient(circle at 62% 16%,rgba(56,189,248,.24),transparent 34%),
    var(--bg-elevated)}
.gen-sweep__preview{position:absolute;inset:-7%;width:114%;height:114%;object-fit:cover;
  filter:blur(26px) saturate(.72) brightness(.64);opacity:.88;transform:scale(1.03)}
.gen-sweep__ambient{position:absolute;inset:-12%;opacity:.85;
  background:
    radial-gradient(circle at 22% 32%,rgba(129,140,248,.70),transparent 34%),
    radial-gradient(circle at 74% 26%,rgba(244,114,182,.42),transparent 38%),
    radial-gradient(circle at 58% 78%,rgba(56,189,248,.36),transparent 38%);
  filter:blur(24px)}
.gen-sweep__veil{position:absolute;inset:0;background:linear-gradient(180deg,transparent,color-mix(in srgb,var(--bg-base) 34%,transparent))}
.gen-sweep__dots{position:absolute;inset:0;opacity:.72;
  background-image:radial-gradient(circle,color-mix(in srgb,var(--text-primary) 62%,transparent) 0 2px,transparent 2.5px);
  background-size:30px 30px;background-position:0 0;
  animation:gen-dot-breathe 1.8s ease-in-out infinite;will-change:background-position,opacity}
.gen-sweep__fill{position:absolute;inset:0;
  background:
    linear-gradient(102deg,transparent 30%,color-mix(in srgb,var(--text-primary) 14%,transparent) 50%,transparent 70%);
  background-size:220% 100%;
  will-change:background-position;
  animation:gen-sweep-move 2.2s ease-in-out infinite;}
@keyframes gen-sweep-move{to{background-position:-220% 0}}
@keyframes gen-dot-breathe{0%,100%{opacity:.48;background-position:0 0}50%{opacity:.82;background-position:15px 15px}}
.gen-sweep__bar{position:absolute;left:5%;bottom:5%;
  transform:scale(var(--invZoom, 1));transform-origin:left bottom;
  width:min(84%,340px);min-width:150px;display:flex;flex-direction:column;gap:7px;
  background:color-mix(in srgb,var(--text-primary) 92%,transparent);border:1px solid var(--text-primary);
  border-radius:16px;padding:9px 12px;backdrop-filter:blur(14px) saturate(125%);
  box-shadow:0 8px 26px color-mix(in srgb,var(--bg-base) 24%,transparent)}
.gen-sweep__row{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:11px;font-weight:750;line-height:1;color:var(--bg-base)}
.gen-sweep__state{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.gen-sweep__est{color:color-mix(in srgb,var(--bg-base) 58%,transparent);white-space:nowrap}
.gen-sweep__est--over{color:var(--semantic-warning-text)}
.gen-sweep__track{height:4px;border-radius:99px;background:color-mix(in srgb,var(--bg-base) 14%,transparent);overflow:hidden}
.gen-sweep__pct{height:100%;border-radius:99px;background:linear-gradient(90deg,var(--accent-primary),var(--accent-gold-2));transition:width .7s ease-out}
.gen-sweep__pct--over{background:var(--semantic-warning-text)}
@media (prefers-reduced-motion:reduce){
  .gen-sweep__dots,.gen-sweep__fill{animation:none}
  .gen-sweep__pct{transition:none}
}
`;

function ensureStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = GLOBAL_CSS;
  document.head.appendChild(el);
}

export function GenSweepLoader({
  createdAt,
  className,
  previewSrc,
}: {
  createdAt?: number;
  className?: string;
  /** 图生图时使用的参考图，只作为重度模糊的等待底稿，不冒充生成结果。 */
  previewSrc?: string;
}) {
  ensureStyles();
  const [now, setNow] = useState(() => Date.now());
  // 兜底起点固定在挂载时刻（不随每秒 now 漂移）：createdAt 缺失时若用 now 当起点，elapsed 恒为 0。
  const mountAtRef = useRef(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const start = createdAt && createdAt > 0 ? createdAt : mountAtRef.current;
  const elapsedMs = Math.max(0, now - start);
  const estMs = getGenAvgMs();
  const elapsedS = Math.round(elapsedMs / 1000);
  const estS = Math.max(1, Math.round(estMs / 1000));
  const overtime = elapsedMs > estMs;
  const pct = Math.min(95, Math.round((elapsedMs / estMs) * 100));

  return (
    <div
      className={`gen-sweep${className ? ` ${className}` : ''}`}
      role="status"
      aria-label="正在生成图片"
    >
      {previewSrc ? (
        <img className="gen-sweep__preview" src={previewSrc} alt="" aria-hidden="true" />
      ) : (
        <div className="gen-sweep__ambient" aria-hidden="true" />
      )}
      <div className="gen-sweep__veil" aria-hidden="true" />
      <div className="gen-sweep__dots" aria-hidden="true" />
      <div className="gen-sweep__fill" />
      <div className="gen-sweep__bar" aria-hidden="true">
        <div className="gen-sweep__row">
          <span className="gen-sweep__state">
            <MapSpinner size={14} color="var(--bg-base)" />
            正在生成 · {elapsedS}s
          </span>
          <span className={`gen-sweep__est${overtime ? ' gen-sweep__est--over' : ''}`}>
            {overtime ? '即将完成' : `预计 ~${estS}s`}
          </span>
        </div>
        <div className="gen-sweep__track">
          <div className={`gen-sweep__pct${overtime ? ' gen-sweep__pct--over' : ''}`} style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}

export default GenSweepLoader;
