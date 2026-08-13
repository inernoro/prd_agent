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
 * 可读性：底部计时条跟随宿主容器缩放，避免小节点下反向放大后被容器裁切。
 */

const STYLE_ID = 'gen-sweep-loader-styles';
const GLOBAL_CSS = `
/* container-type 供下面 .gen-sweep__row 的 cqw 字号取容器宽（#1350 引入，勿删）。 */
.gen-sweep{position:absolute;inset:0;overflow:hidden;border-radius:inherit;pointer-events:none;container-type:inline-size}
/* 底：一层几乎看不见的斜纹 + 一层极淡的竖向渐变，给「有东西在酝酿」的质感。 */
.gen-sweep__fill{position:absolute;inset:0;
  background:
    linear-gradient(180deg, rgba(129,140,248,0.05) 0%, transparent 45%, rgba(129,140,248,0.04) 100%),
    repeating-linear-gradient(45deg, rgba(255,255,255,0.014) 0 14px, transparent 14px 28px);}
/* 流光：宽而软的一道柔光，不是一条亮带。
   上一版是 60% 宽、峰值 0.20 的三段渐变，边缘硬、亮度跳，扫过去像一把尺子在刮
   （2026-08-11 用户原话：这个版本的流光太丑了吧）。这一版拉到 92% 宽、峰值 0.10、
   五段渐变把两侧化开，周期放慢到 2.8s，整体更像光线缓缓掠过表面。
   仍然用 transform 平移（不是 background-position 百分比），两端完全移出容器，
   所以循环处没有接缝、不会抽搐。 */
.gen-sweep__glare{position:absolute;top:-10%;bottom:-10%;left:0;width:92%;
  background:linear-gradient(108deg,
    transparent 0%,
    rgba(148,163,255,0.015) 22%,
    rgba(165,180,252,0.10) 50%,
    rgba(148,163,255,0.015) 78%,
    transparent 100%);
  will-change:transform;
  animation:gen-sweep-move 2.8s linear infinite;}
@keyframes gen-sweep-move{from{transform:translate3d(-110%,0,0)}to{transform:translate3d(210%,0,0)}}
@media (prefers-reduced-motion: reduce){.gen-sweep__glare{animation:none;opacity:.5;transform:translate3d(5%,0,0)}}
/* 计时条一律按宿主宽度收缩，不做画布反向缩放（#1350 定的口径，有 GenSweepLoader.test.tsx 钉着）。
   历史上这里挂过 scale(var(--invZoom)) + min-width:140px：低倍下计时条纹丝不动而卡片越来越窄，
   zoom<0.78 就比卡片还宽，撞上 .gen-sweep 的 overflow:hidden 被切一半。
   #1350 换成「宽度跟着宿主走 + max-width 留 16px 余量 + 字号用 cqw 收缩」，同一个症状根治且不引入
   与画布缩放耦合的算式。画布这边另有一层保险：卡片在屏幕上太小时 showBar 直接不渲染计时条
   （见下面 screenW/screenH），小到读不清就不该占着画面。 */
.gen-sweep__bar{position:absolute;left:50%;bottom:max(8px,10%);
  transform:translateX(-50%);transform-origin:center bottom;
  box-sizing:border-box;width:min(78%,340px);max-width:calc(100% - 16px);min-width:0;display:flex;flex-direction:column;gap:6px;
  background:rgba(0,0,0,0.40);border:1px solid rgba(255,255,255,0.12);
  border-radius:14px;padding:8px 11px;overflow:hidden;backdrop-filter:blur(4px)}
.gen-sweep__row{min-width:0;display:flex;justify-content:space-between;gap:6px;font-size:clamp(8px,2.8cqw,11px);font-weight:800;line-height:1;color:rgba(255,255,255,0.86)}
.gen-sweep__row>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
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
    <div className={`gen-sweep${className ? ` ${className}` : ''}`} data-testid="generation-progress">
      <div className="gen-sweep__fill" />
      <div className="gen-sweep__glare" />
      {!showBar ? null : (
      <div
        className="gen-sweep__bar"
        data-testid="generation-progress-bar"
        style={{
          left: '50%',
          bottom: 'max(8px, 10%)',
          width: 'min(78%, 340px)',
          maxWidth: 'calc(100% - 16px)',
          minWidth: 0,
          transform: 'translateX(-50%)',
          overflow: 'hidden',
        }}
      >

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
