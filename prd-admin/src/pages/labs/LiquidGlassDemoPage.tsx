import { useRef, useState, useCallback, useLayoutEffect } from 'react';
import { Sun, Moon, RotateCcw } from 'lucide-react';
import { PageHeader } from '@/components/design/PageHeader';
import { Button } from '@/components/design/Button';
import './liquid-glass-demo.css';

/**
 * 液态玻璃三方对照（labs 评估页，不接入线上业务）
 *
 * 用户反馈现有液态玻璃"做得烂"，给了 bubbbly 的 WebGL 折射案例做参照。
 * 扒源码确认：bubbbly 用全屏 WebGL fragment shader 做「边缘折射 + 棱光」，
 * 采样的是静态背景图——这套不能直接搬到活 DOM（要逐帧栅格化背景，又慢又崩）。
 * 能落地到真实页面的只有两条，本页把它们和现状并排放在同一张会动的背景上：
 *   current  现有做法：blur(40px) 重模糊，背景糊成一坨，丢清晰度
 *   clarity  B 方案：降模糊保清晰 + 真边缘棱光/镜面反光（全浏览器通用，零兼容风险）
 *   refract  A 方案：SVG feDisplacementMap 真折射（最接近 bubbbly，WebKit 自动降级到 clarity 级）
 *
 * 拖动卡片划过高对比区域、拖 displacement 滑杆，最能看出三者差异。双主题各截一张交给真人选型。
 */

type CardKey = 'current' | 'clarity' | 'refract';

interface CardMeta {
  key: CardKey;
  className: string;
  label: string;
  desc: string;
}

const CARDS: CardMeta[] = [
  { key: 'current', className: 'lgd-current', label: 'CURRENT · 现有做法', desc: 'blur(40px) 重模糊' },
  { key: 'clarity', className: 'lgd-clarity', label: 'B · 清晰 + 棱光', desc: '降模糊 + 镜面反光' },
  { key: 'refract', className: 'lgd-refract', label: 'A · SVG 真折射', desc: 'feDisplacementMap' },
];

const CARD_W = 280;
const CARD_H = 160;

const INITIAL_POS: Record<CardKey, { x: number; y: number }> = {
  current: { x: 40, y: 120 },
  clarity: { x: 360, y: 200 },
  refract: { x: 680, y: 110 },
};

/** 按舞台实测宽度铺开三张卡，避免窄屏下被 overflow:hidden 裁出舞台(Codex P2)。 */
function computeInitialPos(width: number): Record<CardKey, { x: number; y: number }> {
  const usable = Math.max(0, width - CARD_W);
  return {
    current: { x: Math.round(usable * 0.04), y: 120 },
    clarity: { x: Math.round(usable * 0.5), y: 200 },
    refract: { x: Math.round(usable * 0.96), y: 110 },
  };
}

function GlassCardSample({ meta }: { meta: CardMeta }) {
  return (
    <>
      <span className="lgd-card-label">{meta.label} · {meta.desc}</span>
      <div className="lgd-card-head">
        <div className="lgd-card-avatar">PA</div>
        <div>
          <div className="lgd-card-title">PRD Agent</div>
          <div className="lgd-card-sub">inernoro / prd_agent</div>
        </div>
      </div>
      <div className="lgd-card-stats">
        <div>
          <div className="lgd-stat-num">1.2k</div>
          <div className="lgd-stat-label">Stars</div>
        </div>
        <div>
          <div className="lgd-stat-num">340</div>
          <div className="lgd-stat-label">Forks</div>
        </div>
        <div>
          <div className="lgd-stat-num">28</div>
          <div className="lgd-stat-label">Issues</div>
        </div>
      </div>
    </>
  );
}

export default function LiquidGlassDemoPage() {
  const [scene, setScene] = useState<'dark' | 'light'>('dark');
  const [blur, setBlur] = useState(7);
  const [scale, setScale] = useState(60);
  const [bare, setBare] = useState(false);
  const [pos, setPos] = useState(INITIAL_POS);
  const sceneRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ key: CardKey; dx: number; dy: number } | null>(null);
  // 是否已按「正宽度」铺开过初始位置(防止首次测得宽度为 0 时三张卡堆在原点后不再展开)
  const spreadDoneRef = useRef(false);

  // 初始按舞台宽度铺开；舞台尺寸变化时把卡片夹回可视范围(窄屏/缩放不丢卡)。
  useLayoutEffect(() => {
    const el = sceneRef.current;
    if (!el) return;
    if (el.clientWidth > 0) {
      setPos(computeInitialPos(el.clientWidth));
      spreadDoneRef.current = true;
    }
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w <= 0) return;
      // 首次拿到正宽度时补做铺开(初次测量为 0 的兜底)
      if (!spreadDoneRef.current) {
        setPos(computeInitialPos(w));
        spreadDoneRef.current = true;
        return;
      }
      setPos((prev) => {
        const clamp = (p: { x: number; y: number }) => ({
          x: Math.max(0, Math.min(w - CARD_W, p.x)),
          y: Math.max(0, Math.min(h - CARD_H, p.y)),
        });
        return { current: clamp(prev.current), clarity: clamp(prev.clarity), refract: clamp(prev.refract) };
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onPointerDown = useCallback(
    (key: CardKey) => (e: React.PointerEvent<HTMLDivElement>) => {
      const rect = sceneRef.current?.getBoundingClientRect();
      if (!rect) return;
      dragRef.current = {
        key,
        dx: e.clientX - rect.left - pos[key].x,
        dy: e.clientY - rect.top - pos[key].y,
      };
      // 在卡片自身上捕获指针,后续 move/up 全部派发到这张卡(即使指针移出卡片范围)
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* 个别环境不支持指针捕获,move 仍可工作 */
      }
    },
    [pos],
  );

  // move/up 挂在卡片上(配合 currentTarget 捕获),不依赖向 scene 冒泡
  const onCardPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const rect = sceneRef.current?.getBoundingClientRect();
    if (!drag || !rect) return;
    const x = Math.max(0, Math.min(rect.width - CARD_W, e.clientX - rect.left - drag.dx));
    const y = Math.max(0, Math.min(rect.height - CARD_H, e.clientY - rect.top - drag.dy));
    setPos((p) => ({ ...p, [drag.key]: { x, y } }));
  }, []);

  const onCardPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* 指针可能已释放 */
    }
  }, []);

  const reset = () => {
    setPos(computeInitialPos(sceneRef.current?.clientWidth ?? 1000));
    setBlur(7);
    setScale(60);
  };

  return (
    <div className="flex flex-col gap-5 h-full min-h-0">
      {/* SVG 真折射滤镜：fractalNoise 噪声驱动 feDisplacementMap 扭曲背景。
          注意：浏览器不会因为 feDisplacementMap 的 scale 属性变化而重算 backdrop-filter，
          所以滤镜 id 随 scale 变化，强制 backdrop-filter 重新解析引用。 */}
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
        <filter id={`lgd-liquid-${scale}`} x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.008 0.012" numOctaves={2} seed={92} result="noise" />
          <feGaussianBlur in="noise" stdDeviation="2" result="softNoise" />
          <feDisplacementMap in="SourceGraphic" in2="softNoise" scale={scale} xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </svg>

      <PageHeader
        title="液态玻璃 · 三方对照评估"
        description="把现有做法 / B 清晰棱光 / A SVG 真折射叠在同一张会动的背景上并排对比。拖动卡片划过彩色光斑与网格、拖 displacement 滑杆，差异最明显。双主题各截一张交给真人选型，选定后再并入全站 GlassCard。"
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setScene((s) => (s === 'dark' ? 'light' : 'dark'))}
            >
              {scene === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
              {scene === 'dark' ? '切到浅色舞台' : '切到深色舞台'}
            </Button>
            <Button
              variant={bare ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setBare((b) => !b)}
            >
              {bare ? '裸玻璃：开' : '裸玻璃：关'}
            </Button>
            <Button variant="ghost" size="sm" onClick={reset}>
              <RotateCcw size={14} />
              复位
            </Button>
          </div>
        }
      />

      {/* 控制条 */}
      <div className="flex flex-wrap items-center gap-6 text-sm text-[var(--text-secondary)]">
        <label className="flex items-center gap-3">
          <span className="whitespace-nowrap">背景模糊 (B/A) {blur}px</span>
          <input
            type="range"
            min={0}
            max={40}
            value={blur}
            onChange={(e) => setBlur(Number(e.target.value))}
            style={{ width: 160 }}
          />
        </label>
        <label className="flex items-center gap-3">
          <span className="whitespace-nowrap">折射强度 (A) {scale}</span>
          <input
            type="range"
            min={0}
            max={140}
            value={scale}
            onChange={(e) => setScale(Number(e.target.value))}
            style={{ width: 160 }}
          />
        </label>
        <span className="text-xs text-[var(--text-muted)]">
          提示：背景模糊作用于 B/A 两张卡（current 固定 40px 作为现状基线，不随滑杆变）；折射强度仅作用于 A。Safari/WebKit 不支持 backdrop 的 SVG 滤镜，会自动退到 clarity 级模糊（A 方案的已知边界）。
        </span>
      </div>

      {/* 舞台 */}
      <div
        ref={sceneRef}
        className={`lgd-scene flex-1 min-h-0${bare ? ' lgd-bare' : ''}`}
        data-scene={scene}
      >
        <div className="lgd-scene-caption">PRD&nbsp;AGENT</div>
        {/* 探针层：背后细密文字,模糊/折射对它的处理一眼可辨 */}
        <div className="lgd-probe" aria-hidden>
          {Array.from({ length: 18 }).map((_, i) => (
            <div key={i}>
              PRD·AGENT·LIQUID·GLASS·0123456789·ABCDEFGHIJ·{i.toString().padStart(2, '0')}·細密文字探针·
              REFRACTION·CLARITY·棱光·折射·清晰度·
            </div>
          ))}
        </div>
        {CARDS.map((meta) => {
          // backdrop-filter 全部走 inline,每帧用最新的 blur/scale 重算,避免
          // CSS 变量 / SVG 属性变化不触发 backdrop-filter 重算的浏览器坑。
          // current 固定 40px(代表现状基线,不随滑杆),clarity/refract 随滑杆。
          let backdropFilter: string;
          let webkitBackdropFilter: string;
          if (meta.key === 'current') {
            backdropFilter = webkitBackdropFilter = 'blur(40px) saturate(180%) brightness(1.1)';
          } else if (meta.key === 'clarity') {
            backdropFilter = webkitBackdropFilter = `blur(${blur}px) saturate(150%)`;
          } else {
            // A 折射:url() 折射 + 少量模糊;WebKit 不支持 url() backdrop,退到等效模糊
            backdropFilter = `url(#lgd-liquid-${scale}) blur(${Math.max(0, blur - 5)}px) saturate(150%)`;
            webkitBackdropFilter = `blur(${blur}px) saturate(150%)`;
          }
          return (
            <div
              key={meta.key}
              className={`lgd-card ${meta.className}`}
              style={{
                left: pos[meta.key].x,
                top: pos[meta.key].y,
                backdropFilter,
                WebkitBackdropFilter: webkitBackdropFilter,
              }}
              onPointerDown={onPointerDown(meta.key)}
              onPointerMove={onCardPointerMove}
              onPointerUp={onCardPointerUp}
            >
              <GlassCardSample meta={meta} />
            </div>
          );
        })}
      </div>

      <p className="text-xs text-[var(--text-muted)]">
        本页为评估 demo，路径 <code>/labs/liquid-glass</code>，不接入任何线上业务。选型确认后，改动只需落到单一出口
        <code> components/design/GlassCard.tsx</code> 即可全站生效。
      </p>
    </div>
  );
}
