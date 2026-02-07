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

/** 传送门穿越过渡层 — 灵感来自可灵 AI 的传送门效果 */
function PortalTransition({
  agent,
  startRect,
  onComplete,
}: {
  agent: AgentDefinition;
  startRect: DOMRect;
  onComplete: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const iconUrl = ICON_URLS[agent.key];

  // 传送门中心 = 卡片中心
  const cx = startRect.left + startRect.width / 2;
  const cy = startRect.top + startRect.height / 2;

  // 用 useLayoutEffect 同步初始化 canvas，消除首帧延迟
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // 高 DPI 适配
    const dpr = window.devicePixelRatio || 1;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    canvas.width = vw * dpr;
    canvas.height = vh * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

    // 预加载 Agent 图标
    const iconImg = new Image();
    iconImg.crossOrigin = 'anonymous';
    iconImg.src = iconUrl;

    // 计算覆盖全屏需要的最大半径
    const maxR = Math.hypot(
      Math.max(cx, vw - cx),
      Math.max(cy, vh - cy)
    ) * 1.3;

    const startRadius = 55;
    const tiltAngle = -0.15; // 椭圆倾斜角，模拟 3D 透视感
    const color = agent.color.text;

    // 解析 hex 颜色
    const cr = parseInt(color.slice(1, 3), 16);
    const cg = parseInt(color.slice(3, 5), 16);
    const cb = parseInt(color.slice(5, 7), 16);

    // 光线角度预计算（门内 + 泄漏到门外的）
    const innerRays = Array.from({ length: 18 }, (_, i) => ({
      angle: (i / 18) * Math.PI * 2,
      width: 0.03 + Math.random() * 0.02,
      brightness: 0.5 + Math.random() * 0.5,
    }));
    const leakRays = Array.from({ length: 24 }, (_, i) => ({
      angle: (i / 24) * Math.PI * 2 + (Math.random() - 0.5) * 0.15,
      length: 60 + Math.random() * 120,
      width: 1.5 + Math.random() * 2.5,
      brightness: 0.3 + Math.random() * 0.7,
    }));

    const duration = 950;
    const startTime = performance.now();
    let frame: number;

    // 同步绘制第一帧（全黑 + 小传送门），避免闪烁
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, vw, vh);

    function draw(now: number) {
      const elapsed = now - startTime;
      const t = Math.min(elapsed / duration, 1);

      // 缓动：ease-out cubic
      const ease = 1 - Math.pow(1 - t, 3);

      const radius = startRadius + (maxR - startRadius) * ease;
      const rx = radius * 1.15; // 水平轴稍宽
      const ry = radius * 0.9;  // 垂直轴稍短，形成 3D 透视椭圆

      ctx.clearRect(0, 0, vw, vh);

      // ═══ 层1: 传送门内部（通过环可见的内容）═══
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, tiltAngle, 0, Math.PI * 2);
      ctx.clip();

      // 径向渐变背景 — 更亮的内部，清晰的传送门世界
      const portalGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 0.85);
      portalGrad.addColorStop(0, `rgba(${cr}, ${cg}, ${cb}, 0.55)`);
      portalGrad.addColorStop(0.25, `rgba(${cr}, ${cg}, ${cb}, 0.35)`);
      portalGrad.addColorStop(0.5, `rgba(${Math.floor(cr * 0.5)}, ${Math.floor(cg * 0.5)}, ${Math.floor(cb * 0.5)}, 0.3)`);
      portalGrad.addColorStop(1, 'rgba(10, 10, 18, 0.9)');
      ctx.fillStyle = portalGrad;
      ctx.fillRect(0, 0, vw, vh);

      // 从中心向外的光线效果（门内）
      const innerRayAlpha = Math.max(0, 1 - ease * 1.4) * 0.3;
      if (innerRayAlpha > 0.01) {
        for (const ray of innerRays) {
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(ray.angle + ease * 0.3);
          const rayLen = radius * 0.85;
          const rayW = radius * ray.width;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(rayW, rayLen);
          ctx.lineTo(-rayW, rayLen);
          ctx.closePath();
          const rGrad = ctx.createLinearGradient(0, 0, 0, rayLen);
          rGrad.addColorStop(0, `rgba(255, 255, 255, ${innerRayAlpha * ray.brightness})`);
          rGrad.addColorStop(0.15, `rgba(${cr}, ${cg}, ${cb}, ${innerRayAlpha * ray.brightness * 0.6})`);
          rGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
          ctx.fillStyle = rGrad;
          ctx.fill();
          ctx.restore();
        }
      }

      // Agent 图标（淡出 + 缩放穿越效果）
      if (iconImg.complete && iconImg.naturalWidth > 0) {
        const iconAlpha = Math.max(0, 1 - t * 2.5);
        if (iconAlpha > 0.01) {
          const iconScale = 1 + ease * 3;
          const iconSize = 80 * iconScale;
          ctx.save();
          ctx.globalAlpha = iconAlpha;
          ctx.shadowColor = color;
          ctx.shadowBlur = 20 + ease * 40;
          ctx.drawImage(iconImg, cx - iconSize / 2, cy - iconSize / 2, iconSize, iconSize);
          ctx.restore();
        }
      }

      ctx.restore(); // 结束传送门内部裁剪

      // ═══ 层2: 暗色遮罩（椭圆孔洞）— 维持足够久，让"坑"清晰可见 ═══
      // 前55%保持全黑遮罩，之后逐渐淡出
      const overlayAlpha = t < 0.55 ? 1.0 : Math.max(0, 1 - ((t - 0.55) / 0.45));
      if (overlayAlpha > 0.01) {
        ctx.save();
        ctx.globalAlpha = overlayAlpha;
        ctx.fillStyle = '#0a0a0f';
        ctx.beginPath();
        ctx.rect(0, 0, vw, vh);
        ctx.ellipse(cx, cy, rx, ry, tiltAngle, 0, Math.PI * 2, true);
        ctx.fill('evenodd');
        ctx.restore();
      }

      // ═══ 层3: 光泄漏效果（从环边缘向四面八方扩散）═══
      const leakAlpha = t < 0.7 ? Math.min(1, t * 4) : Math.max(0, 1 - ((t - 0.7) / 0.3));
      if (leakAlpha > 0.01) {
        for (const ray of leakRays) {
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(ray.angle + tiltAngle);

          // 从椭圆边缘开始，向外辐射
          const edgeDist = Math.sqrt(
            (rx * Math.cos(ray.angle)) ** 2 + (ry * Math.sin(ray.angle)) ** 2
          );
          const leakLen = ray.length * (1 + ease * 2);

          ctx.beginPath();
          ctx.moveTo(0, edgeDist - 5);
          ctx.lineTo(ray.width * 0.5, edgeDist + leakLen);
          ctx.lineTo(-ray.width * 0.5, edgeDist + leakLen);
          ctx.closePath();

          const lGrad = ctx.createLinearGradient(0, edgeDist, 0, edgeDist + leakLen);
          lGrad.addColorStop(0, `rgba(255, 255, 255, ${leakAlpha * ray.brightness * 0.5})`);
          lGrad.addColorStop(0.3, `rgba(${cr}, ${cg}, ${cb}, ${leakAlpha * ray.brightness * 0.3})`);
          lGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
          ctx.fillStyle = lGrad;
          ctx.fill();
          ctx.restore();
        }
      }

      // ═══ 层4: 发光传送门环 ═══
      const ringAlpha = t < 0.6 ? Math.min(1, t * 5) : Math.max(0, 1 - ((t - 0.6) / 0.4));
      if (ringAlpha > 0.01) {
        const ringW = Math.max(1.5, 3.5 * (1 - ease) + 1.5);
        // 微弱脉动效果
        const pulse = 1 + Math.sin(t * Math.PI * 4) * 0.15 * (1 - ease);

        // 主题色发光层
        for (let i = 0; i < 2; i++) {
          ctx.save();
          ctx.beginPath();
          ctx.ellipse(cx, cy, rx, ry, tiltAngle, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${ringAlpha * (0.7 - i * 0.3)})`;
          ctx.lineWidth = ringW + i * 3;
          ctx.shadowColor = color;
          ctx.shadowBlur = (35 + i * 30) * pulse;
          ctx.stroke();
          ctx.restore();
        }

        // 白色核心光环
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, tiltAngle, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 255, 255, ${ringAlpha * 0.9})`;
        ctx.lineWidth = ringW * 0.5;
        ctx.shadowColor = '#ffffff';
        ctx.shadowBlur = 12 * pulse;
        ctx.stroke();
        ctx.restore();
      }

      // ═══ 层5: 结束白光闪烁 ═══
      if (t > 0.85) {
        ctx.save();
        ctx.globalAlpha = (t - 0.85) / 0.15;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, vw, vh);
        ctx.restore();
      }

      if (t < 1) {
        frame = requestAnimationFrame(draw);
      } else {
        onComplete();
      }
    }

    frame = requestAnimationFrame(draw);

    return () => cancelAnimationFrame(frame);
  }, [cx, cy, agent, iconUrl, onComplete]);

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

  const handleTransitionComplete = useCallback(() => {
    if (transitionAgent) {
      close();
      setTransitionAgent(null);
      setTransitionRect(null);
      navigate(transitionAgent.route);
    }
  }, [transitionAgent, close, navigate]);

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
          // 穿越时不淡出背景 — canvas 遮罩层接管视觉，保持暗色底色稳定
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
          onComplete={handleTransitionComplete}
        />
      )}
    </>,
    document.body
  );
}

export default AgentSwitcher;
