/**
 * Agent Switcher 浮层组件 v2.0
 *
 * 高级视觉效果版本：
 * - 3D 卡片倾斜效果 (Perspective Tilt)
 * - 鼠标跟随光效 (Spotlight)
 * - 脉冲发光动画
 * - 渐变边框
 * - 交错入场动画
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import {
  MessagesSquare,
  Image,
  PenLine,
  Bug,
  type LucideIcon,
} from 'lucide-react';
import {
  useAgentSwitcherStore,
  AGENT_DEFINITIONS,
  type AgentDefinition,
} from '@/stores/agentSwitcherStore';

/** 图标映射 */
const ICON_MAP: Record<string, LucideIcon> = {
  MessagesSquare,
  Image,
  PenLine,
  Bug,
};

/** 3D 卡片组件 */
function Agent3DCard({
  agent,
  index,
  isSelected,
  onClick,
  onHover,
}: {
  agent: AgentDefinition;
  index: number;
  isSelected: boolean;
  onClick: () => void;
  onHover: (index: number | null) => void;
}) {
  const cardRef = useRef<HTMLButtonElement>(null);
  const [transform, setTransform] = useState({ rotateX: 0, rotateY: 0 });
  const [mousePos, setMousePos] = useState({ x: 50, y: 50 });
  const Icon = ICON_MAP[agent.icon] || MessagesSquare;

  // 3D 倾斜效果
  const handleMouseMove = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;

    const rotateX = ((y - centerY) / centerY) * -12;
    const rotateY = ((x - centerX) / centerX) * 12;

    setTransform({ rotateX, rotateY });
    setMousePos({ x: (x / rect.width) * 100, y: (y / rect.height) * 100 });
  };

  const handleMouseLeave = () => {
    setTransform({ rotateX: 0, rotateY: 0 });
    setMousePos({ x: 50, y: 50 });
    onHover(null);
  };

  return (
    <button
      ref={cardRef}
      type="button"
      onClick={onClick}
      onMouseMove={handleMouseMove}
      onMouseEnter={() => onHover(index)}
      onMouseLeave={handleMouseLeave}
      className="group relative outline-none"
      style={{
        perspective: '1000px',
        animationDelay: `${index * 60}ms`,
      }}
    >
      {/* 外层光晕 - 选中时显示 */}
      <div
        className="absolute -inset-1 rounded-[28px] opacity-0 transition-opacity duration-500"
        style={{
          opacity: isSelected ? 1 : 0,
          background: `radial-gradient(circle at 50% 50%, ${agent.color.text}40 0%, transparent 70%)`,
          filter: 'blur(12px)',
          animation: isSelected ? 'pulse-glow 2s ease-in-out infinite' : 'none',
        }}
      />

      {/* 主卡片 */}
      <div
        className="relative w-[130px] h-[140px] rounded-[24px] flex flex-col items-center justify-center gap-3 transition-all duration-200 ease-out"
        style={{
          transform: `rotateX(${transform.rotateX}deg) rotateY(${transform.rotateY}deg) scale(${isSelected ? 1.05 : 1})`,
          transformStyle: 'preserve-3d',
          background: isSelected
            ? `linear-gradient(135deg, ${agent.color.bg} 0%, rgba(20, 20, 24, 0.95) 100%)`
            : 'linear-gradient(135deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 100%)',
          border: `1px solid ${isSelected ? agent.color.border : 'rgba(255, 255, 255, 0.08)'}`,
          boxShadow: isSelected
            ? `0 20px 40px -10px ${agent.color.text}30, 0 0 0 1px ${agent.color.border}, inset 0 1px 0 rgba(255,255,255,0.1)`
            : '0 4px 24px -4px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.06)',
        }}
      >
        {/* Spotlight 光效 */}
        <div
          className="absolute inset-0 rounded-[24px] opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
          style={{
            background: `radial-gradient(circle at ${mousePos.x}% ${mousePos.y}%, rgba(255,255,255,0.15) 0%, transparent 50%)`,
          }}
        />

        {/* 渐变边框动画 - 选中时 */}
        {isSelected && (
          <div
            className="absolute -inset-[1px] rounded-[24px] pointer-events-none"
            style={{
              background: `linear-gradient(135deg, ${agent.color.text}60, transparent, ${agent.color.text}40)`,
              backgroundSize: '200% 200%',
              animation: 'gradient-rotate 3s linear infinite',
              mask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
              maskComposite: 'exclude',
              WebkitMaskComposite: 'xor',
              padding: '1px',
            }}
          />
        )}

        {/* 图标容器 */}
        <div
          className="relative w-16 h-16 rounded-[20px] flex items-center justify-center transition-all duration-300"
          style={{
            background: `linear-gradient(135deg, ${agent.color.iconBg} 0%, ${agent.color.bg} 100%)`,
            boxShadow: `0 8px 32px -4px ${agent.color.text}50, inset 0 1px 0 rgba(255,255,255,0.2)`,
            transform: 'translateZ(20px)',
          }}
        >
          <Icon
            size={32}
            strokeWidth={1.5}
            style={{
              color: agent.color.text,
              filter: `drop-shadow(0 0 8px ${agent.color.text}80)`,
            }}
          />
        </div>

        {/* 名称 */}
        <div
          className="text-[14px] font-semibold transition-colors duration-200"
          style={{
            color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
            transform: 'translateZ(10px)',
            textShadow: isSelected ? `0 0 20px ${agent.color.text}60` : 'none',
          }}
        >
          {agent.name}
        </div>

        {/* 快捷键角标 */}
        <div
          className="absolute top-3 right-3 w-6 h-6 rounded-lg flex items-center justify-center text-[11px] font-bold transition-all duration-200"
          style={{
            background: isSelected ? agent.color.iconBg : 'rgba(255, 255, 255, 0.08)',
            color: isSelected ? agent.color.text : 'var(--text-muted)',
            boxShadow: isSelected ? `0 0 12px ${agent.color.text}40` : 'none',
            transform: 'translateZ(15px)',
          }}
        >
          {index + 1}
        </div>
      </div>
    </button>
  );
}

/** 主浮层组件 */
export function AgentSwitcher() {
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const {
    isOpen,
    selectedIndex,
    recentVisits,
    close,
    setSelectedIndex,
    moveSelection,
    addRecentVisit,
  } = useAgentSwitcherStore();

  // 导航到 Agent
  const navigateToAgent = useCallback(
    (agent: AgentDefinition) => {
      addRecentVisit({
        agentKey: agent.key,
        agentName: agent.name,
        title: '首页',
        path: agent.route,
      });
      close();
      navigate(agent.route);
    },
    [navigate, close, addRecentVisit]
  );

  // 鼠标悬浮时更新选中
  const handleHover = useCallback(
    (index: number | null) => {
      setHoveredIndex(index);
      if (index !== null) {
        setSelectedIndex(index);
      }
    },
    [setSelectedIndex]
  );

  // 键盘事件处理
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape'].includes(e.key)) {
        e.preventDefault();
      }

      switch (e.key) {
        case 'Escape':
          close();
          break;
        case 'ArrowLeft':
          moveSelection('left');
          break;
        case 'ArrowRight':
          moveSelection('right');
          break;
        case 'Enter': {
          const agent = AGENT_DEFINITIONS[selectedIndex];
          if (agent) navigateToAgent(agent);
          break;
        }
        case '1':
        case '2':
        case '3':
        case '4': {
          const index = parseInt(e.key, 10) - 1;
          const agent = AGENT_DEFINITIONS[index];
          if (agent) navigateToAgent(agent);
          break;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, selectedIndex, close, moveSelection, navigateToAgent]);

  // 点击遮罩关闭
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) close();
    },
    [close]
  );

  if (!isOpen) return null;

  // 计算当前选中的 Agent 颜色用于背景
  const activeAgent = AGENT_DEFINITIONS[hoveredIndex ?? selectedIndex];
  const activeColor = activeAgent?.color.text || '#60A5FA';

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center"
      onClick={handleBackdropClick}
      style={{
        background: 'rgba(0, 0, 0, 0.7)',
        backdropFilter: 'blur(20px) saturate(180%)',
        WebkitBackdropFilter: 'blur(20px) saturate(180%)',
      }}
    >
      {/* 动态背景光效 */}
      <div
        className="absolute inset-0 pointer-events-none transition-all duration-700"
        style={{
          background: `radial-gradient(ellipse 80% 50% at 50% 30%, ${activeColor}15 0%, transparent 60%)`,
        }}
      />

      {/* 网格背景 */}
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.03]"
        style={{
          backgroundImage: `
            linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)
          `,
          backgroundSize: '60px 60px',
        }}
      />

      {/* 主面板 */}
      <div
        ref={containerRef}
        className="relative flex flex-col items-center"
        style={{ animation: 'switcher-in 300ms cubic-bezier(0.16, 1, 0.3, 1)' }}
        role="dialog"
        aria-modal="true"
        aria-label="Agent 快捷切换"
      >
        {/* 标题 */}
        <div
          className="mb-8 text-center"
          style={{ animation: 'fade-in-up 400ms cubic-bezier(0.16, 1, 0.3, 1)' }}
        >
          <h2
            className="text-[24px] font-bold tracking-tight"
            style={{
              color: 'var(--text-primary)',
              textShadow: '0 2px 20px rgba(0,0,0,0.5)',
            }}
          >
            选择 Agent
          </h2>
          <p className="mt-2 text-[13px]" style={{ color: 'var(--text-muted)' }}>
            按 <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-[11px] font-mono">1-4</kbd> 快速跳转
            · <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-[11px] font-mono">ESC</kbd> 关闭
          </p>
        </div>

        {/* Agent 卡片网格 */}
        <div className="flex gap-4">
          {AGENT_DEFINITIONS.map((agent, index) => (
            <div
              key={agent.key}
              style={{
                animation: `card-pop-in 400ms cubic-bezier(0.34, 1.56, 0.64, 1) ${100 + index * 80}ms both`,
              }}
            >
              <Agent3DCard
                agent={agent}
                index={index}
                isSelected={selectedIndex === index}
                onClick={() => navigateToAgent(agent)}
                onHover={handleHover}
              />
            </div>
          ))}
        </div>

        {/* 最近访问 - 简化版 */}
        {recentVisits.length > 0 && (
          <div
            className="mt-8 flex items-center gap-3 px-6 py-3 rounded-full"
            style={{
              background: 'rgba(255, 255, 255, 0.04)',
              border: '1px solid rgba(255, 255, 255, 0.06)',
              animation: 'fade-in-up 500ms cubic-bezier(0.16, 1, 0.3, 1) 300ms both',
            }}
          >
            <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
              最近:
            </span>
            {recentVisits.slice(0, 3).map((visit, i) => {
              const agent = AGENT_DEFINITIONS.find((a) => a.key === visit.agentKey);
              const Icon = agent ? ICON_MAP[agent.icon] : MessagesSquare;
              return (
                <button
                  key={`${visit.path}-${i}`}
                  onClick={() => {
                    close();
                    navigate(visit.path);
                  }}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-full transition-all duration-200 hover:bg-white/10"
                >
                  <Icon size={14} style={{ color: agent?.color.text || 'var(--text-muted)' }} />
                  <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                    {visit.agentName}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 动画样式 */}
      <style>{`
        @keyframes switcher-in {
          from {
            opacity: 0;
            transform: scale(0.9);
          }
          to {
            opacity: 1;
            transform: scale(1);
          }
        }

        @keyframes fade-in-up {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes card-pop-in {
          from {
            opacity: 0;
            transform: scale(0.8) translateY(20px);
          }
          to {
            opacity: 1;
            transform: scale(1) translateY(0);
          }
        }

        @keyframes pulse-glow {
          0%, 100% {
            opacity: 0.6;
            transform: scale(1);
          }
          50% {
            opacity: 1;
            transform: scale(1.05);
          }
        }

        @keyframes gradient-rotate {
          0% {
            background-position: 0% 50%;
          }
          50% {
            background-position: 100% 50%;
          }
          100% {
            background-position: 0% 50%;
          }
        }
      `}</style>
    </div>,
    document.body
  );
}

export default AgentSwitcher;
