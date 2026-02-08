/**
 * Agent Switcher 浮层组件 v11.0
 *
 * 改进：
 * - 真正的边缘发光（不是背光）
 * - 山洞穿越过渡效果（点击后卡片放大填满屏幕）
 */

import { useCallback, useEffect, useState, useRef } from 'react';
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
  cardRef?: React.Ref<HTMLButtonElement>;
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
        // 穿越动画时隐藏其他卡片
        opacity: isTransitioning && !isSelected ? 0 : undefined,
        transition: isTransitioning ? 'opacity 0.3s ease-out' : undefined,
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

/** 山洞穿越过渡层 */
function TunnelTransition({
  agent,
  startRect,
  onComplete,
}: {
  agent: AgentDefinition;
  startRect: DOMRect;
  onComplete: () => void;
}) {
  const [phase, setPhase] = useState<'expand' | 'tunnel' | 'done'>('expand');
  const iconUrl = ICON_URLS[agent.key];

  useEffect(() => {
    // 阶段1: 卡片扩展 (0.4s)
    const expandTimer = setTimeout(() => {
      setPhase('tunnel');
    }, 400);

    // 阶段2: 隧道穿越 (0.5s)
    const tunnelTimer = setTimeout(() => {
      setPhase('done');
      onComplete();
    }, 900);

    return () => {
      clearTimeout(expandTimer);
      clearTimeout(tunnelTimer);
    };
  }, [onComplete]);

  return (
    <div className="fixed inset-0 z-[300] pointer-events-none">
      {/* 扩展的卡片 */}
      <div
        className="absolute rounded-[28px] overflow-hidden"
        style={{
          // 起始位置
          left: startRect.left,
          top: startRect.top,
          width: startRect.width,
          height: startRect.height,
          background: 'linear-gradient(145deg, rgba(25, 28, 40, 1) 0%, rgba(15, 17, 25, 1) 100%)',
          boxShadow: `
            inset 0 0 0 1.5px ${agent.color.text}60,
            0 0 60px 20px ${agent.color.text}30
          `,
          // 动画到全屏
          animation: phase === 'expand' || phase === 'tunnel'
            ? 'tunnelExpand 0.4s cubic-bezier(0.22, 1, 0.36, 1) forwards'
            : 'none',
        }}
      >
        {/* 居中的图标 */}
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{
            animation: phase === 'tunnel'
              ? 'iconZoomIn 0.5s cubic-bezier(0.22, 1, 0.36, 1) forwards'
              : 'none',
          }}
        >
          <img
            src={iconUrl}
            alt={agent.name}
            className="w-[100px] h-[100px] object-contain"
            style={{
              filter: `drop-shadow(0 0 40px ${agent.color.text}80)`,
            }}
          />
        </div>

        {/* 速度线效果 */}
        {phase === 'tunnel' && (
          <div className="absolute inset-0 overflow-hidden">
            {Array.from({ length: 20 }).map((_, i) => (
              <div
                key={i}
                className="absolute"
                style={{
                  left: '50%',
                  top: '50%',
                  width: '2px',
                  height: '100px',
                  background: `linear-gradient(to bottom, transparent, ${agent.color.text}60, transparent)`,
                  transformOrigin: 'center top',
                  transform: `rotate(${(i * 18)}deg) translateY(-50%)`,
                  animation: `speedLine 0.5s ease-out ${i * 20}ms forwards`,
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* 白色闪光 */}
      <div
        className="absolute inset-0"
        style={{
          background: '#fff',
          opacity: 0,
          animation: phase === 'tunnel'
            ? 'flashWhite 0.5s ease-out 0.3s forwards'
            : 'none',
        }}
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
          // 穿越时背景快速淡出
          opacity: isTransitioning ? 0 : undefined,
          transition: isTransitioning ? 'opacity 0.3s ease-out' : undefined,
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
          /* 隧道扩展动画 */
          @keyframes tunnelExpand {
            0% {
              border-radius: 28px;
            }
            100% {
              left: 0 !important;
              top: 0 !important;
              width: 100vw !important;
              height: 100vh !important;
              border-radius: 0;
            }
          }
          /* 图标放大动画 */
          @keyframes iconZoomIn {
            0% {
              transform: scale(1);
              opacity: 1;
            }
            100% {
              transform: scale(3);
              opacity: 0;
            }
          }
          /* 速度线动画 */
          @keyframes speedLine {
            0% {
              height: 0;
              opacity: 0;
            }
            50% {
              opacity: 1;
            }
            100% {
              height: 200vh;
              opacity: 0;
            }
          }
          /* 白色闪光 */
          @keyframes flashWhite {
            0% {
              opacity: 0;
            }
            50% {
              opacity: 0.8;
            }
            100% {
              opacity: 1;
            }
          }
        `}</style>
      </div>

      {/* 穿越过渡层 */}
      {transitionAgent && transitionRect && (
        <TunnelTransition
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
