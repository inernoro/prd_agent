import { useEffect, useRef, useState } from 'react';
import { getGenAvgMs } from '@/lib/genTiming';

// build-marker: gen-sweep-loader v1 (2026-06-23) — 强制 chunk 重编译，冲掉 CDS 构建缓存

/**
 * GenSweepLoader — 生图等待「流光进度条」加载动效（靛蓝新风格，2026-06 替换金色 Nebula）
 *
 * 设计：占位整块靛蓝流光斜扫（产物正在浮现感）+ 底部计时条（已耗时 / 预计 ~Ns + 渐变进度条）。
 * 倒计时直接做进动效：进度条按 已耗时/预计 逼近、封顶 95%（出图替换占位才算 100%），
 * 超过预计转黄显示「即将完成」，避免「卡 93%」式假精确。
 *
 * 性能：纯 background-position + transform 动画（GPU 合成），全局样式单例注入；多实例不爆层。
 * 可读性：底部计时条用 invZoom 反缩放，任意画布缩放下文字与进度条都保持清晰可读。
 */

const STYLE_ID = 'gen-sweep-loader-styles';
const GLOBAL_CSS = `
.gen-sweep{position:absolute;inset:0;overflow:hidden;border-radius:inherit;pointer-events:none}
.gen-sweep__fill{position:absolute;inset:0;
  background:
    linear-gradient(100deg, transparent 28%, rgba(129,140,248,0.20) 50%, transparent 72%),
    repeating-linear-gradient(45deg, rgba(255,255,255,0.022) 0 12px, transparent 12px 24px);
  background-size:220% 100%, auto;
  will-change:background-position;
  animation:gen-sweep-move 1.5s linear infinite;}
@keyframes gen-sweep-move{to{background-position:-220% 0, 0 0}}
/* 宽度必须除以 invZoom，否则计时条会「涨」出卡片被裁掉。
   推导：布局宽 L 经 scale(1/zoom) 之后的屏幕宽恒为 L，而卡片的屏幕宽是 cardW*zoom；
   zoom 越小卡片越窄、计时条却纹丝不动，zoom<0.78 时它就比卡片还宽，
   撞上 .gen-sweep 的 overflow:hidden 直接被切一半（2026-08-11 用户截图里「预计 ~55」被切）。
   写成 88%/invZoom 之后屏幕宽 = 0.88*cardW*zoom，永远是卡片的 88%。
   min-width 必须去掉——它会把这个上限重新顶穿。 */
.gen-sweep__bar{position:absolute;left:50%;bottom:10%;
  transform:translateX(-50%) scale(var(--invZoom, 1));transform-origin:center bottom;
  width:min(calc(88% / var(--invZoom, 1)), 340px);max-width:340px;display:flex;flex-direction:column;gap:6px;
  background:rgba(0,0,0,0.40);border:1px solid rgba(255,255,255,0.12);
  border-radius:14px;padding:8px 11px;backdrop-filter:blur(4px)}
.gen-sweep__row{display:flex;justify-content:space-between;gap:10px;font-size:11px;font-weight:800;line-height:1;color:rgba(255,255,255,0.86)}
.gen-sweep__est{color:rgba(255,255,255,0.55)}
.gen-sweep__est--over{color:rgba(251,191,36,0.95)}
.gen-sweep__track{height:5px;border-radius:99px;background:rgba(255,255,255,0.14);overflow:hidden}
.gen-sweep__pct{height:100%;border-radius:99px;background:linear-gradient(90deg,#818cf8,#a5b4fc);transition:width .7s ease-out}
.gen-sweep__pct--over{background:rgba(251,191,36,0.9)}
`;

function ensureStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = GLOBAL_CSS;
  document.head.appendChild(el);
}

export function GenSweepLoader({ createdAt, className, screenW, screenH }: {
  createdAt?: number;
  className?: string;
  /**
   * 卡片此刻在**屏幕上**的尺寸（世界尺寸 × zoom）。
   * 传了就据此决定还显不显示计时条：卡片本身还没计时条大的时候，
   * 它不是信息而是遮挡（低缩放下三个反缩放标签必然互相压，冒烟实测）。
   */
  screenW?: number;
  screenH?: number;
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

  // 没传屏幕尺寸的老调用方保持原样显示；传了就按「装得下才显示」判断。
  const showBar = typeof screenW !== 'number' || typeof screenH !== 'number'
    || (screenW >= 200 && screenH >= 120);

  return (
    <div className={`gen-sweep${className ? ` ${className}` : ''}`}>
      <div className="gen-sweep__fill" />
      {!showBar ? null : (
      <div className="gen-sweep__bar">
        <div className="gen-sweep__row">
          <span>已耗时 {elapsedS}s</span>
          <span className={`gen-sweep__est${overtime ? ' gen-sweep__est--over' : ''}`}>
            {overtime ? '即将完成' : `预计 ~${estS}s`}
          </span>
        </div>
        <div className="gen-sweep__track">
          <div className={`gen-sweep__pct${overtime ? ' gen-sweep__pct--over' : ''}`} style={{ width: `${pct}%` }} />
        </div>
      </div>
      )}
    </div>
  );
}

export default GenSweepLoader;
