/**
 * Agent Switcher 浮层组件 v8.0
 *
 * 电影胶片滚动背景：
 * - 多层滚动光条
 * - 胶片齿孔动画
 * - 选中卡片发光效果
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
  'prd-agent': '#3b82f6',
  'visual-agent': '#a855f7',
  'literary-agent': '#22c55e',
  'defect-agent': '#f97316',
};

/** 电影胶片滚动背景 */
function FilmStripBackground() {
  return (
    <div className="absolute inset-0 overflow-hidden">
      {/* 基础深色渐变 */}
      <div
        className="absolute inset-0"
        style={{
          background: 'linear-gradient(135deg, #0a0a12 0%, #12121f 50%, #0a0a15 100%)',
        }}
      />

      {/* 胶片齿孔 - 左侧 */}
      <div
        className="absolute left-4 top-0 w-3 h-full"
        style={{
          background: `repeating-linear-gradient(
            to bottom,
            transparent 0px,
            transparent 20px,
            rgba(255,255,255,0.03) 20px,
            rgba(255,255,255,0.03) 30px,
            transparent 30px,
            transparent 50px
          )`,
          animation: 'filmScroll 2s linear infinite',
        }}
      />

      {/* 胶片齿孔 - 右侧 */}
      <div
        className="absolute right-4 top-0 w-3 h-full"
        style={{
          background: `repeating-linear-gradient(
            to bottom,
            transparent 0px,
            transparent 20px,
            rgba(255,255,255,0.03) 20px,
            rgba(255,255,255,0.03) 30px,
            transparent 30px,
            transparent 50px
          )`,
          animation: 'filmScroll 2s linear infinite',
        }}
      />

      {/* 滚动光条层 1 - 慢速 */}
      <div
        className="absolute inset-0"
        style={{
          background: `repeating-linear-gradient(
            180deg,
            transparent 0%,
            transparent 48%,
            rgba(59, 130, 246, 0.03) 49%,
            rgba(59, 130, 246, 0.05) 50%,
            rgba(59, 130, 246, 0.03) 51%,
            transparent 52%,
            transparent 100%
          )`,
          backgroundSize: '100% 200px',
          animation: 'scrollDown 8s linear infinite',
        }}
      />

      {/* 滚动光条层 2 - 中速 */}
      <div
        className="absolute inset-0"
        style={{
          background: `repeating-linear-gradient(
            180deg,
            transparent 0%,
            transparent 45%,
            rgba(168, 85, 247, 0.02) 48%,
            rgba(168, 85, 247, 0.04) 50%,
            rgba(168, 85, 247, 0.02) 52%,
            transparent 55%,
            transparent 100%
          )`,
          backgroundSize: '100% 300px',
          animation: 'scrollDown 12s linear infinite',
        }}
      />

      {/* 滚动光条层 3 - 快速斜向 */}
      <div
        className="absolute inset-0"
        style={{
          background: `repeating-linear-gradient(
            165deg,
            transparent 0%,
            transparent 49%,
            rgba(255, 255, 255, 0.015) 49.5%,
            rgba(255, 255, 255, 0.02) 50%,
            rgba(255, 255, 255, 0.015) 50.5%,
            transparent 51%,
            transparent 100%
          )`,
          backgroundSize: '100px 100px',
          animation: 'scrollDiagonal 4s linear infinite',
        }}
      />

      {/* 水平扫描线效果 */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: `repeating-linear-gradient(
            to bottom,
            transparent 0px,
            transparent 2px,
            rgba(0, 0, 0, 0.1) 2px,
            rgba(0, 0, 0, 0.1) 4px
          )`,
        }}
      />

      {/* 中央聚光效果 */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse 60% 50% at 50% 50%, rgba(59, 130, 246, 0.08) 0%, transparent 60%)',
        }}
      />

      {/* 暗角效果 */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse 80% 80% at 50% 50%, transparent 30%, rgba(0, 0, 0, 0.4) 100%)',
        }}
      />
    </div>
  );
}

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
            background: `radial-gradient(ellipse at center, ${glowColor}40 0%, transparent 70%)`,
            animation: 'glowPulse 2s ease-in-out infinite',
          }}
        />
      )}

      {/* 主卡片 */}
      <div
        className="relative w-[140px] h-[160px] rounded-[24px] flex flex-col items-center justify-center gap-4 transition-all duration-300 ease-out overflow-hidden"
        style={{
          background: isSelected
            ? 'rgba(20, 24, 40, 0.9)'
            : 'rgba(15, 18, 30, 0.75)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border: isSelected
            ? `1.5px solid ${glowColor}70`
            : '1px solid rgba(255, 255, 255, 0.1)',
          boxShadow: isSelected
            ? `0 0 30px ${glowColor}50, 0 0 60px ${glowColor}25, 0 20px 40px -10px rgba(0,0,0,0.5)`
            : '0 4px 24px -4px rgba(0,0,0,0.4)',
          transform: isSelected ? 'translateY(-8px) scale(1.05)' : 'translateY(0) scale(1)',
        }}
      >
        {/* 顶部光线 */}
        <div
          className="absolute top-0 left-0 right-0 h-[2px]"
          style={{
            background: isSelected
              ? `linear-gradient(90deg, transparent, ${glowColor}, transparent)`
              : 'linear-gradient(90deg, transparent, rgba(255,255,255,0.15), transparent)',
            boxShadow: isSelected ? `0 0 20px ${glowColor}` : 'none',
          }}
        />

        {/* 图标 */}
        <div
          className="relative w-[72px] h-[72px] transition-all duration-300 ease-out"
          style={{
            transform: isSelected ? 'scale(1.15)' : 'scale(1)',
            filter: isSelected
              ? `drop-shadow(0 0 25px ${glowColor}80) drop-shadow(0 0 50px ${glowColor}40)`
              : 'drop-shadow(0 2px 4px rgba(0,0,0,0.3))',
          }}
        >
          <img
            src={iconUrl}
            alt={agent.name}
            className="w-full h-full object-contain"
            draggable={false}
          />
        </div>

        {/* 名称 */}
        <span
          className="text-[14px] font-medium tracking-wide transition-all duration-300"
          style={{
            color: isSelected ? '#fff' : 'rgba(255,255,255,0.6)',
            textShadow: isSelected ? `0 0 20px ${glowColor}` : 'none',
          }}
        >
          {agent.name}
        </span>

        {/* 快捷键角标 */}
        <div
          className="absolute top-3 right-3 w-6 h-6 rounded-lg flex items-center justify-center text-[11px] font-bold transition-all duration-300"
          style={{
            background: isSelected ? `${glowColor}40` : 'rgba(255, 255, 255, 0.08)',
            color: isSelected ? '#fff' : 'rgba(255,255,255,0.4)',
            border: isSelected ? `1px solid ${glowColor}60` : '1px solid rgba(255, 255, 255, 0.1)',
            boxShadow: isSelected ? `0 0 15px ${glowColor}50` : 'none',
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
      {/* 电影胶片滚动背景 */}
      <FilmStripBackground />

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
              textShadow: '0 0 40px rgba(100, 150, 255, 0.4)',
            }}
          >
            选择 Agent
          </h2>
          <p
            className="mt-3 text-[13px] font-light"
            style={{ color: 'rgba(255, 255, 255, 0.45)' }}
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
            style={{ color: 'rgba(255, 255, 255, 0.4)' }}
          >
            <span
              className="px-2 py-1 rounded-md"
              style={{
                background: 'rgba(255, 255, 255, 0.1)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
              }}
            >
              ←
            </span>
            <span
              className="px-2 py-1 rounded-md"
              style={{
                background: 'rgba(255, 255, 255, 0.1)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
              }}
            >
              →
            </span>
            <span className="ml-1">导航</span>
          </div>
          <div
            className="flex items-center gap-2 text-[12px]"
            style={{ color: 'rgba(255, 255, 255, 0.4)' }}
          >
            <span
              className="px-2 py-1 rounded-md"
              style={{
                background: 'rgba(255, 255, 255, 0.1)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
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
            transform: scale(1.08);
          }
        }
        @keyframes filmScroll {
          0% {
            transform: translateY(0);
          }
          100% {
            transform: translateY(50px);
          }
        }
        @keyframes scrollDown {
          0% {
            background-position: 0 0;
          }
          100% {
            background-position: 0 200px;
          }
        }
        @keyframes scrollDiagonal {
          0% {
            background-position: 0 0;
          }
          100% {
            background-position: 100px 100px;
          }
        }
      `}</style>
    </div>,
    document.body
  );
}

export default AgentSwitcher;
