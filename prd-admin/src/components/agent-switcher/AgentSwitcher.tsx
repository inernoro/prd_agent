/**
 * Agent Switcher 浮层组件 v12.0
 *
 * 改进：
 * - 真正的边缘发光（不是背光）
 * - 传送门穿越过渡效果（灵感来自可灵 AI 传送门）
 *   - Canvas 绘制的椭圆发光环从卡片中心展开
 *   - 环内显示 Agent 主题色渐变 + 光线效果
 *   - 白色核心光环 + 主题色外发光
 *   - 最终白光闪烁完成过渡
 */

import { useCallback, useEffect, useLayoutEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import {
  useAgentSwitcherStore,
  AGENT_DEFINITIONS,
  type AgentDefinition,
} from '@/stores/agentSwitcherStore';

/** 图标 URL 映射 */
const ICON_URLS: Record<string, string> = {
  'prd-agent': 'https://i.pa.759800.com/icon/backups/agent/prd-agent.png',
  'visual-agent': 'https://i.pa.759800.com/icon/backups/agent/visual-agent.png',
  'literary-agent': 'https://i.pa.759800.com/icon/backups/agent/literary-agent.png',
  'defect-agent': 'https://i.pa.759800.com/icon/backups/agent/defect-agent.png',
};

/** Agent 功能描述 */
const AGENT_DESCRIPTIONS: Record<string, string> = {
  'prd-agent': '智能解读PRD文档，快速提取需求要点',
  'visual-agent': 'AI驱动的视觉创作，一键生成精美图像',
  'literary-agent': '文学创作助手，为文章配图赋予灵魂',
  'defect-agent': '缺陷管理专家，高效追踪问题闭环',
};

/** 入场方向配置 */
const ENTRY_DIRECTIONS = [
  { x: -60, y: -40, rotate: -5 },
  { x: 60, y: -40, rotate: 5 },
  { x: -60, y: 40, rotate: 5 },
  { x: 60, y: 40, rotate: -5 },
];

/** Agent 卡片组件 */
function AgentCard({
  agent,
  index,
  isSelected,
  isTransitioning,
  onClick,
  onMouseEnter,
  isClosing,
  cardRef,
}: {
  agent: AgentDefinition;
  index: number;
  isSelected: boolean;
  isTransitioning: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
  isClosing: boolean;
  cardRef?: React.RefObject<HTMLButtonElement>;
}) {
  const iconUrl = ICON_URLS[agent.key];
  const description = AGENT_DESCRIPTIONS[agent.key];
  const direction = ENTRY_DIRECTIONS[index];

  return (
    <button
      ref={cardRef}
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className="group relative outline-none focus:outline-none"
      style={{
        animation: isClosing && !isTransitioning
          ? `cardExit 0.25s cubic-bezier(0.55, 0, 1, 0.45) ${index * 30}ms both`
          : isTransitioning
          ? 'none'
          : `cardEnter 0.45s cubic-bezier(0.22, 1, 0.36, 1) ${80 + index * 60}ms both`,
        ['--entry-x' as string]: `${direction.x}px`,
        ['--entry-y' as string]: `${direction.y}px`,
        ['--entry-rotate' as string]: `${direction.rotate}deg`,
        // 穿越动画时隐藏所有卡片（canvas 接管视觉）
        opacity: isTransitioning ? 0 : undefined,
        transition: isTransitioning ? 'opacity 0.25s ease-out' : undefined,
      }}
    >
      {/* 主卡片 */}
      <div
        className="relative w-[200px] h-[260px] rounded-[28px] overflow-hidden transition-all duration-400 ease-out cursor-pointer"
        style={{
          background: 'linear-gradient(145deg, rgba(25, 28, 40, 0.98) 0%, rgba(15, 17, 25, 0.99) 100%)',
          // 真正的边缘发光：多层 box-shadow
          boxShadow: isSelected
            ? `
              inset 0 0 0 1.5px ${agent.color.text}60,
              0 0 0 1px ${agent.color.text}30,
              0 0 15px 0 ${agent.color.text}40,
              0 0 30px -5px ${agent.color.text}30,
              0 25px 50px -12px rgba(0, 0, 0, 0.7)
            `
            : '0 20px 40px -12px rgba(0, 0, 0, 0.5)',
          transform: isSelected
            ? 'translateY(-8px) scale(1.02)'
            : 'translateY(0) scale(1)',
        }}
      >
        {/* 边缘光晕层 - 内边框发光 */}
        <div
          className="absolute inset-0 rounded-[28px] pointer-events-none transition-opacity duration-300"
          style={{
            opacity: isSelected ? 1 : 0,
            background: `
              linear-gradient(135deg, ${agent.color.text}15 0%, transparent 50%),
              linear-gradient(315deg, ${agent.color.text}10 0%, transparent 50%)
            `,
          }}
        />

        {/* 顶部高光边缘 */}
        <div
          className="absolute top-0 left-4 right-4 h-[1px] pointer-events-none transition-opacity duration-300"
          style={{
            opacity: isSelected ? 1 : 0.3,
            background: isSelected
              ? `linear-gradient(90deg, transparent, ${agent.color.text}80, transparent)`
              : 'linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent)',
          }}
        />

        {/* 图标区域 */}
        <div className="relative pt-8 pb-4 flex justify-center">
          <div
            className="relative w-[100px] h-[100px] transition-all duration-400"
            style={{
              transform: isSelected ? 'scale(1.08) translateY(-2px)' : 'scale(1)',
              filter: isSelected
                ? `drop-shadow(0 0 20px ${agent.color.text}60)`
                : 'drop-shadow(0 4px 8px rgba(0,0,0,0.3))',
            }}
          >
            <img
              src={iconUrl}
              alt={agent.name}
              className="w-full h-full object-contain"
              draggable={false}
            />
          </div>
        </div>

        {/* 文字区域 */}
        <div className="px-5 pb-6">
          <h3
            className="text-[18px] font-semibold text-center mb-2 transition-all duration-300"
            style={{
              color: isSelected ? '#fff' : 'rgba(255,255,255,0.85)',
            }}
          >
            {agent.name}
          </h3>
          <p
            className="text-[13px] text-center leading-relaxed transition-all duration-300"
            style={{
              color: isSelected ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.45)',
            }}
          >
            {description}
          </p>
        </div>

        {/* 底部渐变 */}
        <div
          className="absolute bottom-0 left-0 right-0 h-20 pointer-events-none transition-opacity duration-400"
          style={{
            background: isSelected
              ? `linear-gradient(0deg, ${agent.color.text}12 0%, transparent 100%)`
              : 'transparent',
          }}
        />

        {/* 快捷键 */}
        <div
          className="absolute top-4 right-4 w-8 h-8 rounded-xl flex items-center justify-center text-[13px] font-bold transition-all duration-300"
          style={{
            background: isSelected ? `${agent.color.text}35` : 'rgba(255, 255, 255, 0.06)',
            color: isSelected ? '#fff' : 'rgba(255,255,255,0.5)',
            boxShadow: isSelected ? `0 0 12px ${agent.color.text}30` : 'none',
          }}
        >
          {index + 1}
        </div>
      </div>
    </button>
  );
}

/**
 * 传送门穿越过渡层 — 灵感来自可灵 AI 的传送门效果
 *
 * 架构要点：
 * - onNavigate 在动画早期(150ms)触发，页面开始加载，用户不感受到延迟
 * - canvas 全程完全不透明(solid base fill)，不会透出背后的 UI
 * - 动画后半段 canvas 通过 CSS opacity 淡出，露出已加载的目标页面
 * - onComplete 在动画结束时触发，关闭 modal
 */
function PortalTransition({
  agent,
  startRect,
  onNavigate,
  onComplete,
}: {
  agent: AgentDefinition;
  startRect: DOMRect;
  onNavigate: () => void;
  onComplete: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 用 ref 持有回调，避免闭包过期 + 避免重新触发 effect
  const cbRef = useRef({ onNavigate, onComplete });
  cbRef.current = { onNavigate, onComplete };
  const navigatedRef = useRef(false);
  const iconUrl = ICON_URLS[agent.key];

  const cx = startRect.left + startRect.width / 2;
  const cy = startRect.top + startRect.height / 2;

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    canvas.width = vw * dpr;
    canvas.height = vh * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

    const iconImg = new Image();
    iconImg.crossOrigin = 'anonymous';
    iconImg.src = iconUrl;

    const maxR = Math.hypot(
      Math.max(cx, vw - cx),
      Math.max(cy, vh - cy)
    ) * 1.3;

    const startRadius = 60;
    const tiltAngle = -0.12;
    const color = agent.color.text;
    const cr = parseInt(color.slice(1, 3), 16);
    const cg = parseInt(color.slice(3, 5), 16);
    const cb = parseInt(color.slice(5, 7), 16);

    // 门内光线
    const innerRays = Array.from({ length: 16 }, (_, i) => ({
      angle: (i / 16) * Math.PI * 2,
      width: 0.04 + Math.random() * 0.03,
      brightness: 0.5 + Math.random() * 0.5,
    }));
    // 门外泄漏光线 — 粗、长、亮，四面八方
    const leakRays = Array.from({ length: 32 }, (_, i) => ({
      angle: (i / 32) * Math.PI * 2 + (Math.random() - 0.5) * 0.08,
      length: 150 + Math.random() * 300,
      width: 3 + Math.random() * 6,
      brightness: 0.4 + Math.random() * 0.6,
    }));

    const duration = 600; // 600ms 快速过渡
    const startTime = performance.now();
    let frame: number;

    // 首帧：全黑，防止闪烁
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, vw, vh);

    function draw(now: number) {
      const elapsed = now - startTime;
      const t = Math.min(elapsed / duration, 1);
      const ease = 1 - Math.pow(1 - t, 3);

      // ── 提前导航（150ms ~ 25%）──
      if (t >= 0.25 && !navigatedRef.current) {
        navigatedRef.current = true;
        cbRef.current.onNavigate();
      }

      const radius = startRadius + (maxR - startRadius) * ease;
      const rx = radius * 1.15;
      const ry = radius * 0.9;

      // ═══ 底层：全画面实心暗色（完全不透明，杜绝穿透）═══
      ctx.fillStyle = '#0a0a0f';
      ctx.fillRect(0, 0, vw, vh);

      // ═══ 层1: 传送门内部（clip 到椭圆）═══
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, tiltAngle, 0, Math.PI * 2);
      ctx.clip();

      // 不透明径向渐变 — 传送门里的世界
      const pg = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 0.85);
      pg.addColorStop(0, `rgb(${cr}, ${cg}, ${cb})`);
      pg.addColorStop(0.3, `rgb(${(cr * 0.6) | 0}, ${(cg * 0.6) | 0}, ${(cb * 0.6) | 0})`);
      pg.addColorStop(0.6, `rgb(${(cr * 0.25) | 0}, ${(cg * 0.25) | 0}, ${(cb * 0.25) | 0})`);
      pg.addColorStop(1, 'rgb(10, 10, 18)');
      ctx.fillStyle = pg;
      ctx.fillRect(0, 0, vw, vh);

      // 门内放射光线
      const irAlpha = Math.max(0, 1 - ease * 1.5) * 0.4;
      if (irAlpha > 0.01) {
        for (const ray of innerRays) {
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(ray.angle + ease * 0.5);
          const len = radius * 0.85;
          const w = radius * ray.width;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(w, len);
          ctx.lineTo(-w, len);
          ctx.closePath();
          const g = ctx.createLinearGradient(0, 0, 0, len);
          g.addColorStop(0, `rgba(255,255,255,${irAlpha * ray.brightness})`);
          g.addColorStop(0.15, `rgba(${cr},${cg},${cb},${irAlpha * ray.brightness * 0.6})`);
          g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g;
          ctx.fill();
          ctx.restore();
        }
      }

      // Agent 图标穿越
      if (iconImg.complete && iconImg.naturalWidth > 0) {
        const ia = Math.max(0, 1 - t * 3);
        if (ia > 0.01) {
          const s = 80 * (1 + ease * 3);
          ctx.save();
          ctx.globalAlpha = ia;
          ctx.shadowColor = color;
          ctx.shadowBlur = 20 + ease * 40;
          ctx.drawImage(iconImg, cx - s / 2, cy - s / 2, s, s);
          ctx.restore();
        }
      }
      ctx.restore(); // 结束门内 clip

      // ═══ 层2: 光泄漏（门外暗色表面上，四面八方辐射）═══
      const la = t < 0.55 ? Math.min(1, t * 5) : Math.max(0, 1 - ((t - 0.55) / 0.45));
      if (la > 0.01) {
        for (const ray of leakRays) {
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(ray.angle);
          // 椭圆边缘距离（简化计算）
          const a2 = (rx * Math.cos(ray.angle - tiltAngle)) ** 2;
          const b2 = (ry * Math.sin(ray.angle - tiltAngle)) ** 2;
          const edge = Math.sqrt(a2 + b2);
          const len = ray.length * (0.5 + ease * 2);
          // 从边缘起的三角形光束
          ctx.beginPath();
          ctx.moveTo(-ray.width, edge);
          ctx.lineTo(0, edge + len);
          ctx.lineTo(ray.width, edge);
          ctx.closePath();
          const g = ctx.createLinearGradient(0, edge, 0, edge + len);
          g.addColorStop(0, `rgba(255,255,255,${la * ray.brightness * 0.5})`);
          g.addColorStop(0.15, `rgba(${cr},${cg},${cb},${la * ray.brightness * 0.35})`);
          g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g;
          ctx.fill();
          ctx.restore();
        }
      }

      // ═══ 层3: 发光环 ═══
      const ra = t < 0.45 ? Math.min(1, t * 6) : Math.max(0, 1 - ((t - 0.45) / 0.55));
      if (ra > 0.01) {
        const rw = Math.max(1.5, 4 * (1 - ease) + 1.5);
        const pulse = 1 + Math.sin(t * Math.PI * 5) * 0.12 * (1 - ease);
        // 主题色外发光
        for (let i = 0; i < 2; i++) {
          ctx.save();
          ctx.beginPath();
          ctx.ellipse(cx, cy, rx, ry, tiltAngle, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},${ra * (0.8 - i * 0.3)})`;
          ctx.lineWidth = rw + i * 4;
          ctx.shadowColor = color;
          ctx.shadowBlur = (40 + i * 40) * pulse;
          ctx.stroke();
          ctx.restore();
        }
        // 白色核心
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, tiltAngle, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,255,255,${ra * 0.9})`;
        ctx.lineWidth = rw * 0.6;
        ctx.shadowColor = '#fff';
        ctx.shadowBlur = 15 * pulse;
        ctx.stroke();
        ctx.restore();
      }

      // ═══ 层4: 白光闪 ═══
      if (t > 0.8) {
        ctx.save();
        ctx.globalAlpha = (t - 0.8) / 0.2;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, vw, vh);
        ctx.restore();
      }

      // ═══ canvas 整体淡出（露出已导航的目标页面）═══
      if (t > 0.5) {
        canvas.style.opacity = String(Math.max(0, 1 - ((t - 0.5) / 0.5)));
      }

      if (t < 1) {
        frame = requestAnimationFrame(draw);
      } else {
        canvas.style.opacity = '0';
        cbRef.current.onComplete();
      }
    }

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [cx, cy, agent, iconUrl]);

  return (
    <div className="fixed inset-0 z-[300] pointer-events-none">
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
      />
    </div>
  );
}

/** 主浮层组件 */
export function AgentSwitcher() {
  const navigate = useNavigate();
  const [isClosing, setIsClosing] = useState(false);
  const [transitionAgent, setTransitionAgent] = useState<AgentDefinition | null>(null);
  const [transitionRect, setTransitionRect] = useState<DOMRect | null>(null);
  const cardRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const {
    isOpen,
    selectedIndex,
    close,
    setSelectedIndex,
    moveSelection,
    addRecentVisit,
  } = useAgentSwitcherStore();

  const navigateToAgent = useCallback(
    (agent: AgentDefinition, index: number) => {
      addRecentVisit({
        agentKey: agent.key,
        agentName: agent.name,
        title: '首页',
        path: agent.route,
      });

      // 获取卡片位置，启动穿越动画
      const cardEl = cardRefs.current[index];
      if (cardEl) {
        const rect = cardEl.getBoundingClientRect();
        setTransitionRect(rect);
        setTransitionAgent(agent);
      }
    },
    [addRecentVisit]
  );

  // 动画早期触发：提前导航，页面开始加载
  const handleNavigate = useCallback(() => {
    if (transitionAgent) {
      navigate(transitionAgent.route);
    }
  }, [transitionAgent, navigate]);

  // 动画结束触发：关闭 modal、清理状态
  const handleTransitionComplete = useCallback(() => {
    close();
    setTransitionAgent(null);
    setTransitionRect(null);
  }, [close]);

  const handleClose = useCallback(() => {
    setIsClosing(true);
    setTimeout(() => {
      close();
      setIsClosing(false);
    }, 280);
  }, [close]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (['ArrowLeft', 'ArrowRight', 'Enter', 'Escape'].includes(e.key)) {
        e.preventDefault();
      }

      switch (e.key) {
        case 'Escape':
          if (!transitionAgent) handleClose();
          break;
        case 'ArrowLeft':
          if (!transitionAgent) moveSelection('left');
          break;
        case 'ArrowRight':
          if (!transitionAgent) moveSelection('right');
          break;
        case 'Enter': {
          if (!transitionAgent) {
            const agent = AGENT_DEFINITIONS[selectedIndex];
            if (agent) navigateToAgent(agent, selectedIndex);
          }
          break;
        }
        case '1':
        case '2':
        case '3':
        case '4': {
          if (!transitionAgent) {
            const idx = parseInt(e.key, 10) - 1;
            const agent = AGENT_DEFINITIONS[idx];
            if (agent) navigateToAgent(agent, idx);
          }
          break;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, selectedIndex, handleClose, moveSelection, navigateToAgent, transitionAgent]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget && !transitionAgent) handleClose();
    },
    [handleClose, transitionAgent]
  );

  if (!isOpen) return null;

  const isTransitioning = !!transitionAgent;

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[200] flex items-center justify-center"
        onClick={handleBackdropClick}
        style={{
          animation: isClosing
            ? 'bgFadeOut 0.25s cubic-bezier(0.55, 0, 1, 0.45) both'
            : 'bgFadeIn 0.35s cubic-bezier(0.22, 1, 0.36, 1) both',
          // 穿越时延迟淡出背景 — canvas 先接管视觉，300ms后背景也开始淡出露出目标页面
          opacity: isTransitioning ? 0 : undefined,
          transition: isTransitioning ? 'opacity 0.25s ease-out 0.25s' : undefined,
        }}
      >
        {/* 深黑背景 */}
        <div
          className="absolute inset-0"
          style={{
            background: 'linear-gradient(180deg, #0a0a0f 0%, #0f0f18 50%, #0a0a12 100%)',
          }}
        />

        {/* 网格背景 */}
        <div
          className="absolute inset-0 opacity-[0.015]"
          style={{
            backgroundImage: `
              linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)
            `,
            backgroundSize: '60px 60px',
          }}
        />

        {/* 中央光晕 */}
        <div
          className="absolute pointer-events-none"
          style={{
            width: '900px',
            height: '700px',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            background: 'radial-gradient(ellipse at center, rgba(100, 120, 255, 0.05) 0%, transparent 55%)',
          }}
        />

        {/* 内容区域 */}
        <div
          className="relative"
          style={{
            animation: isClosing
              ? 'contentFadeOut 0.2s cubic-bezier(0.55, 0, 1, 0.45) both'
              : 'contentFadeIn 0.4s cubic-bezier(0.22, 1, 0.36, 1) both',
          }}
          role="dialog"
          aria-modal="true"
        >
          {/* 标题 */}
          <div
            className="text-center mb-12"
            style={{
              animation: isClosing ? 'none' : 'titleSlideIn 0.5s cubic-bezier(0.22, 1, 0.36, 1) 0.05s both',
              opacity: isTransitioning ? 0 : undefined,
              transition: isTransitioning ? 'opacity 0.2s ease-out' : undefined,
            }}
          >
            <h2
              className="text-[36px] font-bold tracking-tight"
              style={{
                color: '#fff',
                background: 'linear-gradient(180deg, #fff 0%, rgba(255,255,255,0.7) 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
              }}
            >
              选择你的 Agent
            </h2>
            <p
              className="mt-4 text-[15px]"
              style={{ color: 'rgba(255, 255, 255, 0.4)' }}
            >
              每个 Agent 都是为特定场景打造的智能助手
            </p>
          </div>

          {/* Agent 卡片网格 */}
          <div className="flex gap-6 justify-center">
            {AGENT_DEFINITIONS.map((agent, index) => (
              <AgentCard
                key={agent.key}
                agent={agent}
                index={index}
                isSelected={selectedIndex === index}
                isTransitioning={isTransitioning}
                onClick={() => navigateToAgent(agent, index)}
                onMouseEnter={() => !isTransitioning && setSelectedIndex(index)}
                isClosing={isClosing}
                cardRef={el => { cardRefs.current[index] = el; }}
              />
            ))}
          </div>

          {/* 底部提示 */}
          <div
            className="mt-12 flex justify-center gap-8"
            style={{
              animation: isClosing ? 'none' : 'hintFadeIn 0.5s cubic-bezier(0.22, 1, 0.36, 1) 0.35s both',
              opacity: isTransitioning ? 0 : undefined,
              transition: isTransitioning ? 'opacity 0.2s ease-out' : undefined,
            }}
          >
            <div
              className="flex items-center gap-3 text-[13px]"
              style={{ color: 'rgba(255, 255, 255, 0.35)' }}
            >
              <div className="flex gap-1">
                <span
                  className="px-2 py-1 rounded-lg"
                  style={{
                    background: 'rgba(255, 255, 255, 0.06)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                  }}
                >
                  ←
                </span>
                <span
                  className="px-2 py-1 rounded-lg"
                  style={{
                    background: 'rgba(255, 255, 255, 0.06)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                  }}
                >
                  →
                </span>
              </div>
              <span>切换选择</span>
            </div>
            <div
              className="flex items-center gap-3 text-[13px]"
              style={{ color: 'rgba(255, 255, 255, 0.35)' }}
            >
              <span
                className="px-3 py-1 rounded-lg"
                style={{
                  background: 'rgba(255, 255, 255, 0.06)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                }}
              >
                Enter
              </span>
              <span>确认进入</span>
            </div>
            <div
              className="flex items-center gap-3 text-[13px]"
              style={{ color: 'rgba(255, 255, 255, 0.35)' }}
            >
              <span
                className="px-3 py-1 rounded-lg"
                style={{
                  background: 'rgba(255, 255, 255, 0.06)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                }}
              >
                Esc
              </span>
              <span>关闭</span>
            </div>
          </div>
        </div>

        {/* 动画样式 */}
        <style>{`
          @keyframes bgFadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
          }
          @keyframes bgFadeOut {
            from { opacity: 1; }
            to { opacity: 0; }
          }
          @keyframes contentFadeIn {
            from {
              opacity: 0;
              transform: scale(0.98);
            }
            to {
              opacity: 1;
              transform: scale(1);
            }
          }
          @keyframes contentFadeOut {
            from {
              opacity: 1;
              transform: scale(1);
            }
            to {
              opacity: 0;
              transform: scale(0.98);
            }
          }
          @keyframes titleSlideIn {
            from {
              opacity: 0;
              transform: translateY(-15px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }
          @keyframes hintFadeIn {
            from {
              opacity: 0;
              transform: translateY(8px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }
          @keyframes cardEnter {
            0% {
              opacity: 0;
              transform: translate(var(--entry-x), var(--entry-y)) rotate(var(--entry-rotate)) scale(0.85);
            }
            100% {
              opacity: 1;
              transform: translate(0, 0) rotate(0deg) scale(1);
            }
          }
          @keyframes cardExit {
            from {
              opacity: 1;
              transform: translate(0, 0) rotate(0deg) scale(1);
            }
            to {
              opacity: 0;
              transform: translate(calc(var(--entry-x) * 0.5), calc(var(--entry-y) * 0.5)) rotate(calc(var(--entry-rotate) * 0.5)) scale(0.9);
            }
          }
        `}</style>
      </div>

      {/* 传送门穿越过渡层 */}
      {transitionAgent && transitionRect && (
        <PortalTransition
          agent={transitionAgent}
          startRect={transitionRect}
          onNavigate={handleNavigate}
          onComplete={handleTransitionComplete}
        />
      )}
    </>,
    document.body
  );
}

export default AgentSwitcher;
