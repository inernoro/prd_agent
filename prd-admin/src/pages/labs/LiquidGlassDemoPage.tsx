import { useRef, useState, useCallback } from 'react';
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

const INITIAL_POS: Record<CardKey, { x: number; y: number }> = {
  current: { x: 40, y: 120 },
  clarity: { x: 360, y: 200 },
  refract: { x: 680, y: 110 },
};

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
  const [pos, setPos] = useState(INITIAL_POS);
  const sceneRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ key: CardKey; dx: number; dy: number } | null>(null);

  const onPointerDown = useCallback(
    (key: CardKey) => (e: React.PointerEvent<HTMLDivElement>) => {
      const rect = sceneRef.current?.getBoundingClientRect();
      if (!rect) return;
      dragRef.current = {
        key,
        dx: e.clientX - rect.left - pos[key].x,
        dy: e.clientY - rect.top - pos[key].y,
      };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [pos],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const rect = sceneRef.current?.getBoundingClientRect();
    if (!drag || !rect) return;
    const x = Math.max(0, Math.min(rect.width - 280, e.clientX - rect.left - drag.dx));
    const y = Math.max(0, Math.min(rect.height - 160, e.clientY - rect.top - drag.dy));
    setPos((p) => ({ ...p, [drag.key]: { x, y } }));
  }, []);

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const reset = () => {
    setPos(INITIAL_POS);
    setBlur(7);
    setScale(60);
  };

  return (
    <div className="flex flex-col gap-5 h-full min-h-0">
      {/* SVG 真折射滤镜：fractalNoise 噪声驱动 feDisplacementMap 扭曲背景。scale 由滑杆控制。 */}
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
        <filter id="lgd-liquid" x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
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
          <span className="whitespace-nowrap">背景模糊 {blur}px</span>
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
          提示：折射强度仅作用于 A 方案；Safari/WebKit 不支持 backdrop 的 SVG 滤镜，会自动退到 clarity 级模糊（这是 A 方案的已知边界）。
        </span>
      </div>

      {/* 舞台 */}
      <div
        ref={sceneRef}
        className="lgd-scene flex-1 min-h-0"
        data-scene={scene}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        style={
          {
            '--lgd-current-blur': `blur(40px) saturate(180%) brightness(1.1)`,
            '--lgd-clarity-blur': `blur(${blur}px) saturate(150%)`,
          } as React.CSSProperties
        }
      >
        <div className="lgd-scene-caption">PRD&nbsp;AGENT</div>
        {CARDS.map((meta) => (
          <div
            key={meta.key}
            className={`lgd-card ${meta.className}`}
            style={{
              left: pos[meta.key].x,
              top: pos[meta.key].y,
              // A 方案的背景模糊随滑杆走（叠在 url(#lgd-liquid) 折射之上）
              ...(meta.key === 'refract'
                ? ({
                    backdropFilter: `url(#lgd-liquid) blur(${Math.max(1, blur - 5)}px) saturate(150%)`,
                  } as React.CSSProperties)
                : {}),
            }}
            onPointerDown={onPointerDown(meta.key)}
          >
            <GlassCardSample meta={meta} />
          </div>
        ))}
      </div>

      <p className="text-xs text-[var(--text-muted)]">
        本页为评估 demo，路径 <code>/labs/liquid-glass</code>，不接入任何线上业务。选型确认后，改动只需落到单一出口
        <code> components/design/GlassCard.tsx</code> 即可全站生效。
      </p>
    </div>
  );
}
