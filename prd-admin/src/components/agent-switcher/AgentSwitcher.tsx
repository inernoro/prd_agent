/**
 * Agent Switcher 浮层组件 v4.0
 *
 * Raycast 风格设计：
 * - 深色渐变背景
 * - 毛玻璃面板
 * - 卡片独立渐变
 * - 流畅动效
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

/** Agent 卡片渐变配置 */
const CARD_GRADIENTS: Record<string, { from: string; to: string }> = {
  'prd-agent': { from: '#1e3a5f', to: '#0a1628' },
  'visual-agent': { from: '#3d1f5c', to: '#150a24' },
  'literary-agent': { from: '#1a4a3a', to: '#0a1f18' },
  'defect-agent': { from: '#5c3d1f', to: '#241508' },
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
  const gradient = CARD_GRADIENTS[agent.key];

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className="group relative outline-none focus:outline-none"
      style={{
        animation: `cardSlideIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms both`,
      }}
    >
      {/* 选中光晕 */}
      <div
        className="absolute -inset-[2px] rounded-[20px] transition-opacity duration-300"
        style={{
          opacity: isSelected ? 1 : 0,
          background: `linear-gradient(135deg, ${agent.color.text}80, ${agent.color.text}20)`,
          filter: 'blur(1px)',
        }}
      />

      {/* 主卡片 */}
      <div
        className="relative w-[120px] h-[130px] rounded-[18px] p-4 flex flex-col items-center justify-center gap-3 transition-all duration-200"
        style={{
          background: `linear-gradient(145deg, ${gradient.from} 0%, ${gradient.to} 100%)`,
          border: isSelected
            ? `1.5px solid ${agent.color.text}90`
            : '1.5px solid rgba(255, 255, 255, 0.08)',
          boxShadow: isSelected
            ? `0 8px 32px -4px ${agent.color.text}40, inset 0 1px 0 rgba(255,255,255,0.1)`
            : '0 4px 20px -4px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05)',
          transform: isSelected ? 'translateY(-2px)' : 'translateY(0)',
        }}
      >
        {/* 图标 */}
        <div
          className="w-[56px] h-[56px] transition-transform duration-200"
          style={{
            transform: isSelected ? 'scale(1.05)' : 'scale(1)',
            filter: isSelected ? `drop-shadow(0 4px 12px ${agent.color.text}60)` : 'none',
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
          className="text-[13px] font-medium transition-colors duration-200"
          style={{
            color: isSelected ? '#fff' : 'rgba(255,255,255,0.7)',
          }}
        >
          {agent.name}
        </span>

        {/* 快捷键 */}
        <div
          className="absolute top-2 right-2 w-5 h-5 rounded-md flex items-center justify-center text-[10px] font-semibold"
          style={{
            background: 'rgba(255, 255, 255, 0.1)',
            color: isSelected ? agent.color.text : 'rgba(255,255,255,0.4)',
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
        animation: isClosing ? 'fadeOut 0.2s ease-out both' : 'fadeIn 0.25s ease-out both',
      }}
    >
      {/* 深色渐变背景 */}
      <div
        className="absolute inset-0"
        style={{
          background: 'linear-gradient(180deg, rgba(8, 12, 24, 0.95) 0%, rgba(4, 6, 14, 0.98) 100%)',
        }}
      />

      {/* 微妙的光晕 */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse 50% 30% at 50% 30%, rgba(100, 140, 200, 0.08) 0%, transparent 70%)',
        }}
      />

      {/* 毛玻璃面板 */}
      <div
        className="relative rounded-[24px] overflow-hidden"
        style={{
          animation: isClosing ? 'panelOut 0.2s ease-in both' : 'panelIn 0.35s cubic-bezier(0.16, 1, 0.3, 1) both',
          background: 'linear-gradient(180deg, rgba(30, 35, 50, 0.6) 0%, rgba(20, 24, 36, 0.7) 100%)',
          backdropFilter: 'blur(40px) saturate(150%)',
          WebkitBackdropFilter: 'blur(40px) saturate(150%)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          boxShadow: '0 32px 64px -12px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.05)',
        }}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-8 pt-8 pb-6">
          {/* 标题 */}
          <div className="text-center mb-6">
            <h2
              className="text-[20px] font-semibold tracking-tight"
              style={{ color: 'rgba(255, 255, 255, 0.95)' }}
            >
              选择 Agent
            </h2>
            <p
              className="mt-2 text-[12px]"
              style={{ color: 'rgba(255, 255, 255, 0.4)' }}
            >
              按 1-4 快速跳转 · ESC 关闭
            </p>
          </div>

          {/* Agent 卡片网格 */}
          <div className="flex gap-3 justify-center">
            {AGENT_DEFINITIONS.map((agent, index) => (
              <AgentCard
                key={agent.key}
                agent={agent}
                index={index}
                isSelected={selectedIndex === index}
                onClick={() => navigateToAgent(agent)}
                onMouseEnter={() => setSelectedIndex(index)}
                delay={isClosing ? 0 : 80 + index * 50}
              />
            ))}
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
        @keyframes panelIn {
          from {
            opacity: 0;
            transform: scale(0.95) translateY(10px);
          }
          to {
            opacity: 1;
            transform: scale(1) translateY(0);
          }
        }
        @keyframes panelOut {
          from {
            opacity: 1;
            transform: scale(1) translateY(0);
          }
          to {
            opacity: 0;
            transform: scale(0.98) translateY(-5px);
          }
        }
        @keyframes cardSlideIn {
          from {
            opacity: 0;
            transform: translateY(12px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </div>,
    document.body
  );
}

export default AgentSwitcher;
