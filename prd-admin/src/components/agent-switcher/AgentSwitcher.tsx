/**
 * Agent Switcher 浮层组件 v6.0
 *
 * 精美背景 + 强化发光效果：
 * - 渐变背景 + 多层光球
 * - 选中卡片多层发光
 * - 图标呼吸光效
 */

import { useCallback, useEffect, useState } from 'react';
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

/** Agent 主题色 */
const AGENT_GLOW_COLORS: Record<string, string> = {
  'prd-agent': '#3b82f6',      // 蓝色
  'visual-agent': '#a855f7',   // 紫色
  'literary-agent': '#22c55e', // 绿色
  'defect-agent': '#f97316',   // 橙色
};

/** Agent 卡片组件 */
function AgentCard({
  agent,
  index,
  isSelected,
  onClick,
  onMouseEnter,
  delay,
}: {
  agent: AgentDefinition;
  index: number;
  isSelected: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
  delay: number;
}) {
  const iconUrl = ICON_URLS[agent.key];
  const glowColor = AGENT_GLOW_COLORS[agent.key];

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className="group relative outline-none focus:outline-none"
      style={{
        animation: `cardFloat 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) ${delay}ms both`,
      }}
    >
      {/* 选中时的外层大光晕 */}
      {isSelected && (
        <div
          className="absolute -inset-4 rounded-[32px] pointer-events-none"
          style={{
            background: `radial-gradient(ellipse at center, ${glowColor}30 0%, transparent 70%)`,
            animation: 'glowPulse 2s ease-in-out infinite',
          }}
        />
      )}

      {/* 选中时的中层光晕 */}
      {isSelected && (
        <div
          className="absolute -inset-1 rounded-[28px] pointer-events-none"
          style={{
            background: `linear-gradient(135deg, ${glowColor}40, transparent 50%, ${glowColor}20)`,
            filter: 'blur(2px)',
          }}
        />
      )}

      {/* 主卡片 */}
      <div
        className="relative w-[140px] h-[160px] rounded-[24px] flex flex-col items-center justify-center gap-4 transition-all duration-300 ease-out overflow-hidden"
        style={{
          background: isSelected
            ? `linear-gradient(145deg, rgba(30, 35, 55, 0.9) 0%, rgba(20, 24, 40, 0.95) 100%)`
            : 'rgba(20, 24, 36, 0.6)',
          border: isSelected
            ? `1px solid ${glowColor}60`
            : '1px solid rgba(255, 255, 255, 0.08)',
          boxShadow: isSelected
            ? `0 0 20px ${glowColor}40, 0 0 40px ${glowColor}20, 0 20px 40px -10px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.1)`
            : '0 4px 24px -4px rgba(0,0,0,0.4)',
          transform: isSelected ? 'translateY(-6px) scale(1.03)' : 'translateY(0) scale(1)',
        }}
      >
        {/* 卡片内部顶部光线 */}
        <div
          className="absolute top-0 left-0 right-0 h-[1px] transition-opacity duration-300"
          style={{
            background: isSelected
              ? `linear-gradient(90deg, transparent, ${glowColor}80, transparent)`
              : 'linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent)',
            opacity: isSelected ? 1 : 0.5,
          }}
        />

        {/* 选中时的内部光斑 */}
        {isSelected && (
          <div
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[100px] h-[100px] rounded-full pointer-events-none"
            style={{
              background: `radial-gradient(circle, ${glowColor}15 0%, transparent 70%)`,
            }}
          />
        )}

        {/* 图标容器 */}
        <div
          className="relative w-[72px] h-[72px] transition-all duration-300 ease-out"
          style={{
            transform: isSelected ? 'scale(1.12)' : 'scale(1)',
            filter: isSelected
              ? `drop-shadow(0 0 20px ${glowColor}70) drop-shadow(0 4px 12px ${glowColor}50)`
              : 'drop-shadow(0 2px 4px rgba(0,0,0,0.3))',
          }}
        >
          <img
            src={iconUrl}
            alt={agent.name}
            className="w-full h-full object-contain"
            draggable={false}
            style={{
              animation: isSelected ? 'iconGlow 2s ease-in-out infinite' : 'none',
            }}
          />
        </div>

        {/* 名称 */}
        <span
          className="text-[14px] font-medium tracking-wide transition-all duration-300"
          style={{
            color: isSelected ? '#fff' : 'rgba(255,255,255,0.5)',
            textShadow: isSelected ? `0 0 20px ${glowColor}80` : 'none',
          }}
        >
          {agent.name}
        </span>

        {/* 快捷键角标 */}
        <div
          className="absolute top-3 right-3 w-6 h-6 rounded-lg flex items-center justify-center text-[11px] font-bold transition-all duration-300"
          style={{
            background: isSelected ? `${glowColor}30` : 'rgba(255, 255, 255, 0.06)',
            color: isSelected ? '#fff' : 'rgba(255,255,255,0.35)',
            border: isSelected ? `1px solid ${glowColor}50` : '1px solid rgba(255, 255, 255, 0.08)',
            boxShadow: isSelected ? `0 0 10px ${glowColor}40` : 'none',
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
  const [isClosing, setIsClosing] = useState(false);

  const {
    isOpen,
    selectedIndex,
    close,
    setSelectedIndex,
    moveSelection,
    addRecentVisit,
  } = useAgentSwitcherStore();

  const navigateToAgent = useCallback(
    (agent: AgentDefinition) => {
      addRecentVisit({
        agentKey: agent.key,
        agentName: agent.name,
        title: '首页',
        path: agent.route,
      });
      setIsClosing(true);
      setTimeout(() => {
        close();
        setIsClosing(false);
        navigate(agent.route);
      }, 200);
    },
    [navigate, close, addRecentVisit]
  );

  const handleClose = useCallback(() => {
    setIsClosing(true);
    setTimeout(() => {
      close();
      setIsClosing(false);
    }, 200);
  }, [close]);

  // 键盘事件
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (['ArrowLeft', 'ArrowRight', 'Enter', 'Escape'].includes(e.key)) {
        e.preventDefault();
      }

      switch (e.key) {
        case 'Escape':
          handleClose();
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
          const idx = parseInt(e.key, 10) - 1;
          const agent = AGENT_DEFINITIONS[idx];
          if (agent) navigateToAgent(agent);
          break;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, selectedIndex, handleClose, moveSelection, navigateToAgent]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) handleClose();
    },
    [handleClose]
  );

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center"
      onClick={handleBackdropClick}
      style={{
        animation: isClosing ? 'fadeOut 0.2s ease-out both' : 'fadeIn 0.3s ease-out both',
      }}
    >
      {/* 多层渐变背景 */}
      <div
        className="absolute inset-0"
        style={{
          background: `
            radial-gradient(ellipse 80% 50% at 50% 0%, rgba(59, 130, 246, 0.15) 0%, transparent 50%),
            radial-gradient(ellipse 60% 40% at 70% 100%, rgba(168, 85, 247, 0.12) 0%, transparent 50%),
            radial-gradient(ellipse 50% 30% at 20% 80%, rgba(34, 197, 94, 0.08) 0%, transparent 50%),
            linear-gradient(180deg, #0a0e1a 0%, #060810 50%, #030408 100%)
          `,
        }}
      />

      {/* 浮动光球 1 - 顶部蓝色 */}
      <div
        className="absolute pointer-events-none"
        style={{
          width: '400px',
          height: '400px',
          top: '-100px',
          left: '30%',
          background: 'radial-gradient(circle, rgba(59, 130, 246, 0.2) 0%, transparent 60%)',
          filter: 'blur(60px)',
          animation: 'floatOrb 8s ease-in-out infinite',
        }}
      />

      {/* 浮动光球 2 - 右下紫色 */}
      <div
        className="absolute pointer-events-none"
        style={{
          width: '300px',
          height: '300px',
          bottom: '10%',
          right: '15%',
          background: 'radial-gradient(circle, rgba(168, 85, 247, 0.15) 0%, transparent 60%)',
          filter: 'blur(50px)',
          animation: 'floatOrb 10s ease-in-out infinite reverse',
        }}
      />

      {/* 浮动光球 3 - 左下绿色 */}
      <div
        className="absolute pointer-events-none"
        style={{
          width: '250px',
          height: '250px',
          bottom: '20%',
          left: '10%',
          background: 'radial-gradient(circle, rgba(34, 197, 94, 0.1) 0%, transparent 60%)',
          filter: 'blur(40px)',
          animation: 'floatOrb 12s ease-in-out infinite 2s',
        }}
      />

      {/* 毛玻璃遮罩层 */}
      <div
        className="absolute inset-0"
        style={{
          backdropFilter: 'blur(20px) saturate(150%)',
          WebkitBackdropFilter: 'blur(20px) saturate(150%)',
        }}
      />

      {/* 内容区域 */}
      <div
        className="relative"
        style={{
          animation: isClosing ? 'contentOut 0.2s ease-in both' : 'contentIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) both',
        }}
        role="dialog"
        aria-modal="true"
      >
        {/* 标题 */}
        <div className="text-center mb-10">
          <h2
            className="text-[28px] font-semibold tracking-wide"
            style={{
              color: 'rgba(255, 255, 255, 0.95)',
              textShadow: '0 0 40px rgba(255, 255, 255, 0.2)',
            }}
          >
            选择 Agent
          </h2>
          <p
            className="mt-3 text-[13px] font-light"
            style={{ color: 'rgba(255, 255, 255, 0.4)' }}
          >
            按 1-4 快速切换 · ESC 关闭
          </p>
        </div>

        {/* Agent 卡片 */}
        <div className="flex gap-5 justify-center">
          {AGENT_DEFINITIONS.map((agent, index) => (
            <AgentCard
              key={agent.key}
              agent={agent}
              index={index}
              isSelected={selectedIndex === index}
              onClick={() => navigateToAgent(agent)}
              onMouseEnter={() => setSelectedIndex(index)}
              delay={isClosing ? 0 : 100 + index * 70}
            />
          ))}
        </div>

        {/* 底部提示 */}
        <div className="mt-10 flex justify-center gap-6">
          <div
            className="flex items-center gap-2 text-[12px]"
            style={{ color: 'rgba(255, 255, 255, 0.35)' }}
          >
            <span
              className="px-2 py-1 rounded-md"
              style={{
                background: 'rgba(255, 255, 255, 0.08)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
              }}
            >
              ←
            </span>
            <span
              className="px-2 py-1 rounded-md"
              style={{
                background: 'rgba(255, 255, 255, 0.08)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
              }}
            >
              →
            </span>
            <span className="ml-1">导航</span>
          </div>
          <div
            className="flex items-center gap-2 text-[12px]"
            style={{ color: 'rgba(255, 255, 255, 0.35)' }}
          >
            <span
              className="px-2 py-1 rounded-md"
              style={{
                background: 'rgba(255, 255, 255, 0.08)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
              }}
            >
              ↵
            </span>
            <span className="ml-1">确认</span>
          </div>
        </div>
      </div>

      {/* 动画样式 */}
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes fadeOut {
          from { opacity: 1; }
          to { opacity: 0; }
        }
        @keyframes contentIn {
          from {
            opacity: 0;
            transform: scale(0.95) translateY(10px);
          }
          to {
            opacity: 1;
            transform: scale(1) translateY(0);
          }
        }
        @keyframes contentOut {
          from {
            opacity: 1;
            transform: scale(1) translateY(0);
          }
          to {
            opacity: 0;
            transform: scale(0.98) translateY(-5px);
          }
        }
        @keyframes cardFloat {
          from {
            opacity: 0;
            transform: translateY(24px) scale(0.95);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
        @keyframes glowPulse {
          0%, 100% {
            opacity: 0.6;
            transform: scale(1);
          }
          50% {
            opacity: 1;
            transform: scale(1.05);
          }
        }
        @keyframes iconGlow {
          0%, 100% {
            filter: brightness(1);
          }
          50% {
            filter: brightness(1.15);
          }
        }
        @keyframes floatOrb {
          0%, 100% {
            transform: translate(0, 0);
          }
          25% {
            transform: translate(20px, -15px);
          }
          50% {
            transform: translate(-10px, 10px);
          }
          75% {
            transform: translate(15px, 5px);
          }
        }
      `}</style>
    </div>,
    document.body
  );
}

export default AgentSwitcher;
