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
import { useAuthStore } from '@/stores/authStore';

/** 图标相对路径映射（CDN 前缀从 authStore.cdnBaseUrl 获取） */
const ICON_PATHS: Record<string, string> = {
  'prd-agent': 'icon/backups/agent/prd-agent.png',
  'visual-agent': 'icon/backups/agent/visual-agent.png',
  'literary-agent': 'icon/backups/agent/literary-agent.png',
  'defect-agent': 'icon/backups/agent/defect-agent.png',
  'video-agent': 'icon/backups/agent/video-agent.png',
};

function getAgentIconUrl(appKey: string): string {
  const path = ICON_PATHS[appKey];
  if (!path) return '';
  const base = (useAuthStore.getState().cdnBaseUrl ?? '').replace(/\/+$/, '');
  return base ? `${base}/${path}` : `/${path}`;
}

/** Agent 功能描述 */
const AGENT_DESCRIPTIONS: Record<string, string> = {
  'prd-agent': '智能解读PRD文档，快速提取需求要点',
  'visual-agent': 'AI驱动的视觉创作，一键生成精美图像',
  'literary-agent': '文学创作助手，为文章配图赋予灵魂',
  'defect-agent': '缺陷管理专家，高效追踪问题闭环',
  'video-agent': '文章转视频教程，AI驱动分镜创作',
};

/** 入场方向配置 */
const ENTRY_DIRECTIONS = [
  { x: -80, y: -40, rotate: -5 },
  { x: -40, y: -40, rotate: -3 },
  { x: 0, y: -40, rotate: 0 },
  { x: 40, y: -40, rotate: 3 },
  { x: 80, y: -40, rotate: 5 },
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
  convergeOffset,
}: {
  agent: AgentDefinition;
  index: number;
  isSelected: boolean;
  isTransitioning: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
  isClosing: boolean;
  cardRef?: React.Ref<HTMLButtonElement>;
  convergeOffset?: { x: number; y: number };
}) {
  const iconUrl = getAgentIconUrl(agent.key);
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
        // 穿越动画时: 4张卡片向选中卡片中心汇聚
        transform: isTransitioning && convergeOffset
          ? `translate(${convergeOffset.x}px, ${convergeOffset.y}px) scale(0.15)`
          : undefined,
        opacity: isTransitioning ? 0 : undefined,
        transition: isTransitioning
          ? 'transform 0.28s cubic-bezier(0.4, 0, 1, 1), opacity 0.22s ease-out 0.06s'
          : undefined,
      }}
    >
      {/* 主卡片 — 图片铺满 + 底部文字叠加 */}
      <div
        className="relative w-[200px] h-[260px] rounded-[28px] overflow-hidden transition-all duration-400 ease-out cursor-pointer"
        style={{
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
        {/* 图片铺满整个卡片 */}
        <img
          src={iconUrl}
          alt={agent.name}
          className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 ease-out"
          style={{
            transform: isSelected ? 'scale(1.06)' : 'scale(1)',
          }}
          draggable={false}
        />

        {/* 底部渐变遮罩 — 保证文字可读 */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background: isSelected
              ? `linear-gradient(0deg, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.4) 45%, transparent 70%), linear-gradient(0deg, ${agent.color.text}18 0%, transparent 40%)`
              : 'linear-gradient(0deg, rgba(0,0,0,0.8) 0%, rgba(0,0,0,0.3) 45%, transparent 70%)',
          }}
        />

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

        {/* 文字区域 — 定位在底部 */}
        <div className="absolute bottom-0 left-0 right-0 px-5 pb-5">
          <h3
            className="text-[18px] font-semibold text-center mb-1.5 transition-all duration-300"
            style={{
              color: isSelected ? '#fff' : 'rgba(255,255,255,0.92)',
              textShadow: '0 1px 4px rgba(0,0,0,0.5)',
            }}
          >
            {agent.name}
          </h3>
          <p
            className="text-[12px] text-center leading-relaxed transition-all duration-300"
            style={{
              color: isSelected ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.55)',
              textShadow: '0 1px 3px rgba(0,0,0,0.5)',
            }}
          >
            {description}
          </p>
        </div>

        {/* 快捷键 */}
        <div
          className="absolute top-4 right-4 w-8 h-8 rounded-xl flex items-center justify-center text-[13px] font-bold transition-all duration-300 backdrop-blur-sm"
          style={{
            background: isSelected ? `${agent.color.text}45` : 'rgba(0, 0, 0, 0.35)',
            color: isSelected ? '#fff' : 'rgba(255,255,255,0.7)',
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
 * 传送门穿越过渡层 — 山洞/缝隙穿越效果
 *
 * 核心原理：
 * - canvas 作为透明遮罩层，用 evenodd 镂空一个不规则洞口
 * - 洞口区域完全透明，露出下方已导航的目标页面
 * - 洞口从极小的裂缝缓缓扩张至全屏
 * - 洞口边缘有主题色发光，营造传送门感
 * - onNavigate 在动画早期触发，页面在洞口扩张前已加载
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
  const cbRef = useRef({ onNavigate, onComplete });
  cbRef.current = { onNavigate, onComplete };
  const navigatedRef = useRef(false);

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

    // 洞口需要扩到足以覆盖全屏
    const maxR = Math.hypot(
      Math.max(cx, vw - cx),
      Math.max(cy, vh - cy)
    ) * 1.5;

    const color = agent.color.text;
    const cr = parseInt(color.slice(1, 3), 16);
    const cg = parseInt(color.slice(3, 5), 16);
    const cb = parseInt(color.slice(5, 7), 16);

    // 不规则洞口噪声 — 模拟山洞/缝隙的粗糙边缘
    const N = 64;
    let noiseArr = Array.from({ length: N }, () => (Math.random() - 0.5) * 0.4);
    // 平滑3次，让边缘看起来自然
    for (let s = 0; s < 3; s++) {
      noiseArr = noiseArr.map((_, i) => {
        const p = noiseArr[(i - 1 + N) % N];
        const c = noiseArr[i];
        const n = noiseArr[(i + 1) % N];
        return p * 0.25 + c * 0.5 + n * 0.25;
      });
    }

    const duration = 700;
    const startTime = performance.now();
    let frame: number;

    // 首帧：全黑遮罩
    ctx.fillStyle = '#080810';
    ctx.fillRect(0, 0, vw, vh);

    /** 在当前路径上追加不规则椭圆洞口 */
    function traceHole(radius: number, nScale: number) {
      const pts: [number, number][] = [];
      for (let i = 0; i < N; i++) {
        const angle = (i / N) * Math.PI * 2;
        const r = radius * (1 + noiseArr[i] * nScale);
        pts.push([
          cx + r * Math.cos(angle) * 1.15,
          cy + r * Math.sin(angle) * 0.85,
        ]);
      }
      const last = pts[pts.length - 1];
      ctx.moveTo((last[0] + pts[0][0]) / 2, (last[1] + pts[0][1]) / 2);
      for (let i = 0; i < pts.length; i++) {
        const next = pts[(i + 1) % pts.length];
        ctx.quadraticCurveTo(
          pts[i][0], pts[i][1],
          (pts[i][0] + next[0]) / 2, (pts[i][1] + next[1]) / 2
        );
      }
      ctx.closePath();
    }

    function draw(now: number) {
      const elapsed = now - startTime;
      const t = Math.min(elapsed / duration, 1);

      // 缓缓打开：前期稍慢营造裂缝感，后期加速展开
      const ease = t < 0.2
        ? Math.pow(t / 0.2, 1.5) * 0.15
        : 0.15 + 0.85 * (1 - Math.pow(1 - (t - 0.2) / 0.8, 2));

      // 提前导航
      if (t >= 0.12 && !navigatedRef.current) {
        navigatedRef.current = true;
        cbRef.current.onNavigate();
      }

      const radius = 30 + (maxR - 30) * ease;
      // 洞口越大越规则（小 = 山洞粗糙感，大 = 平滑圆形收尾）
      const nScale = Math.max(0, 1 - ease * 1.5);

      // 清除为全透明
      ctx.clearRect(0, 0, vw, vh);

      // ═══ 暗色遮罩 + evenodd 镂空 ═══
      const overlayAlpha = t > 0.88 ? Math.max(0, 1 - (t - 0.88) / 0.12) : 1;
      ctx.beginPath();
      ctx.rect(0, 0, vw, vh);
      traceHole(radius, nScale);
      ctx.fillStyle = `rgba(8, 8, 15, ${overlayAlpha})`;
      ctx.fill('evenodd');

      // ═══ 洞口边缘发光 ═══
      const glowAlpha = t < 0.08 ? t / 0.08 : t > 0.7 ? Math.max(0, 1 - (t - 0.7) / 0.3) : 1;
      if (glowAlpha > 0.01) {
        // 主题色外发光
        ctx.save();
        ctx.beginPath();
        traceHole(radius, nScale);
        ctx.strokeStyle = `rgba(${cr},${cg},${cb},${glowAlpha * 0.7})`;
        ctx.lineWidth = 4;
        ctx.shadowColor = color;
        ctx.shadowBlur = 40;
        ctx.stroke();
        ctx.restore();

        // 白色内发光
        ctx.save();
        ctx.beginPath();
        traceHole(radius, nScale);
        ctx.strokeStyle = `rgba(255,255,255,${glowAlpha * 0.5})`;
        ctx.lineWidth = 1.5;
        ctx.shadowColor = `rgba(${cr},${cg},${cb},0.8)`;
        ctx.shadowBlur = 15;
        ctx.stroke();
        ctx.restore();
      }

      if (t < 1) {
        frame = requestAnimationFrame(draw);
      } else {
        ctx.clearRect(0, 0, vw, vh);
        cbRef.current.onComplete();
      }
    }

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [cx, cy, agent]);

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
  const [convergeOffsets, setConvergeOffsets] = useState<Record<number, { x: number; y: number }>>({});
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

      // 获取点击卡片位置
      const clickedEl = cardRefs.current[index];
      if (!clickedEl) return;

      const clickedRect = clickedEl.getBoundingClientRect();
      const targetCx = clickedRect.left + clickedRect.width / 2;
      const targetCy = clickedRect.top + clickedRect.height / 2;

      // 计算所有卡片向选中卡片中心汇聚的偏移量
      const offsets: Record<number, { x: number; y: number }> = {};
      cardRefs.current.forEach((el, i) => {
        if (el) {
          const r = el.getBoundingClientRect();
          const cardCx = r.left + r.width / 2;
          const cardCy = r.top + r.height / 2;
          offsets[i] = { x: targetCx - cardCx, y: targetCy - cardCy };
        }
      });

      setConvergeOffsets(offsets);
      setTransitionRect(clickedRect);
      setTransitionAgent(agent);
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
    setConvergeOffsets({});
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
        case '4':
        case '5': {
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
          // 穿越动画时：立即隐藏背景，让目标页面透过洞口可见
          // 必须用 animation:none 清除 bgFadeIn 的 fill:both，否则其 opacity:1 会覆盖 inline style
          animation: isTransitioning
            ? 'none'
            : isClosing
            ? 'bgFadeOut 0.25s cubic-bezier(0.55, 0, 1, 0.45) both'
            : 'bgFadeIn 0.35s cubic-bezier(0.22, 1, 0.36, 1) both',
          visibility: isTransitioning ? 'hidden' : undefined,
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
                convergeOffset={convergeOffsets[index]}
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

      {/* 传送门穿越过渡层 — 点击后立即展示 */}
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
