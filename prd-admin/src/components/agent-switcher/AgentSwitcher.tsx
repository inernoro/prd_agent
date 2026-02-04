/**
 * Agent Switcher 浮层组件 v5.0
 *
 * Apple 极简风格：
 * - 统一深色卡片，图标为唯一颜色
 * - 精致微妙的光效
 * - 克制的设计语言
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

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className="group relative outline-none focus:outline-none"
      style={{
        animation: `cardFloat 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) ${delay}ms both`,
      }}
    >
      {/* 主卡片 */}
      <div
        className="relative w-[140px] h-[160px] rounded-[24px] flex flex-col items-center justify-center gap-4 transition-all duration-300 ease-out"
        style={{
          background: isSelected
            ? 'rgba(255, 255, 255, 0.08)'
            : 'rgba(255, 255, 255, 0.03)',
          border: isSelected
            ? '1px solid rgba(255, 255, 255, 0.15)'
            : '1px solid rgba(255, 255, 255, 0.06)',
          boxShadow: isSelected
            ? `0 0 0 1px rgba(255,255,255,0.1), 0 20px 40px -10px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.1)`
            : '0 4px 20px -5px rgba(0,0,0,0.3)',
          transform: isSelected ? 'translateY(-4px) scale(1.02)' : 'translateY(0) scale(1)',
        }}
      >
        {/* 选中时的顶部光条 */}
        {isSelected && (
          <div
            className="absolute top-0 left-1/2 -translate-x-1/2 w-[60%] h-[2px] rounded-full"
            style={{
              background: `linear-gradient(90deg, transparent, ${agent.color.text}, transparent)`,
              boxShadow: `0 0 20px 2px ${agent.color.text}60`,
            }}
          />
        )}

        {/* 图标容器 */}
        <div
          className="relative w-[72px] h-[72px] transition-all duration-300 ease-out"
          style={{
            transform: isSelected ? 'scale(1.1)' : 'scale(1)',
            filter: isSelected ? `drop-shadow(0 8px 24px ${agent.color.text}50)` : 'none',
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
            color: isSelected ? '#fff' : 'rgba(255,255,255,0.5)',
          }}
        >
          {agent.name}
        </span>

        {/* 快捷键角标 */}
        <div
          className="absolute top-3 right-3 w-6 h-6 rounded-lg flex items-center justify-center text-[11px] font-semibold transition-all duration-300"
          style={{
            background: isSelected ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.05)',
            color: isSelected ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.3)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
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
      {/* 纯净深色背景 */}
      <div
        className="absolute inset-0"
        style={{
          background: 'rgba(0, 0, 0, 0.85)',
          backdropFilter: 'blur(30px) saturate(180%)',
          WebkitBackdropFilter: 'blur(30px) saturate(180%)',
        }}
      />

      {/* 中央光晕 */}
      <div
        className="absolute pointer-events-none"
        style={{
          width: '800px',
          height: '400px',
          background: 'radial-gradient(ellipse at center, rgba(255,255,255,0.03) 0%, transparent 70%)',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
        }}
      />

      {/* 内容区域 - 无面板边框，极简 */}
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
            className="text-[28px] font-light tracking-wide"
            style={{ color: 'rgba(255, 255, 255, 0.9)' }}
          >
            选择 Agent
          </h2>
          <p
            className="mt-3 text-[13px] font-light"
            style={{ color: 'rgba(255, 255, 255, 0.35)' }}
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
              delay={isClosing ? 0 : 100 + index * 60}
            />
          ))}
        </div>

        {/* 底部提示 */}
        <div className="mt-10 flex justify-center gap-6">
          <div
            className="flex items-center gap-2 text-[12px]"
            style={{ color: 'rgba(255, 255, 255, 0.3)' }}
          >
            <span
              className="px-2 py-1 rounded-md"
              style={{
                background: 'rgba(255, 255, 255, 0.06)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
              }}
            >
              ←
            </span>
            <span
              className="px-2 py-1 rounded-md"
              style={{
                background: 'rgba(255, 255, 255, 0.06)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
              }}
            >
              →
            </span>
            <span className="ml-1">导航</span>
          </div>
          <div
            className="flex items-center gap-2 text-[12px]"
            style={{ color: 'rgba(255, 255, 255, 0.3)' }}
          >
            <span
              className="px-2 py-1 rounded-md"
              style={{
                background: 'rgba(255, 255, 255, 0.06)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
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
            transform: scale(0.96);
          }
          to {
            opacity: 1;
            transform: scale(1);
          }
        }
        @keyframes contentOut {
          from {
            opacity: 1;
            transform: scale(1);
          }
          to {
            opacity: 0;
            transform: scale(0.98);
          }
        }
        @keyframes cardFloat {
          from {
            opacity: 0;
            transform: translateY(20px);
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
