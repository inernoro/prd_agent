/**
 * Agent Switcher 浮层组件 v10.0
 *
 * 融合设计：
 * - Apple 风格动画曲线 (先快后慢，有呼吸感)
 * - GlowingCard 彩虹流光边框 (选中状态)
 * - 更紧凑的入场距离，更短的动画时长
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

/** Agent 功能描述 */
const AGENT_DESCRIPTIONS: Record<string, string> = {
  'prd-agent': '智能解读PRD文档，快速提取需求要点',
  'visual-agent': 'AI驱动的视觉创作，一键生成精美图像',
  'literary-agent': '文学创作助手，为文章配图赋予灵魂',
  'defect-agent': '缺陷管理专家，高效追踪问题闭环',
};

/** 入场方向配置 - 更紧凑的距离 */
const ENTRY_DIRECTIONS = [
  { x: -60, y: -40, rotate: -5 },   // 左上
  { x: 60, y: -40, rotate: 5 },     // 右上
  { x: -60, y: 40, rotate: 5 },     // 左下
  { x: 60, y: 40, rotate: -5 },     // 右下
];

/** Agent 卡片组件 */
function AgentCard({
  agent,
  index,
  isSelected,
  onClick,
  onMouseEnter,
  isClosing,
}: {
  agent: AgentDefinition;
  index: number;
  isSelected: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
  isClosing: boolean;
}) {
  const iconUrl = ICON_URLS[agent.key];
  const description = AGENT_DESCRIPTIONS[agent.key];
  const direction = ENTRY_DIRECTIONS[index];

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className="group relative outline-none focus:outline-none"
      style={{
        // Apple 风格动画: 0.45s + cubic-bezier(0.22, 1, 0.36, 1) = 快速启动，平滑到位
        animation: isClosing
          ? `cardExit 0.25s cubic-bezier(0.55, 0, 1, 0.45) ${index * 30}ms both`
          : `cardEnter 0.45s cubic-bezier(0.22, 1, 0.36, 1) ${80 + index * 60}ms both`,
        ['--entry-x' as string]: `${direction.x}px`,
        ['--entry-y' as string]: `${direction.y}px`,
        ['--entry-rotate' as string]: `${direction.rotate}deg`,
      }}
    >
      {/* 彩虹流光边框层 - 仅选中时显示 */}
      <div
        className="absolute -inset-[2px] rounded-[30px] opacity-0 transition-opacity duration-300"
        style={{
          opacity: isSelected ? 1 : 0,
          background: `conic-gradient(
            from var(--glow-angle, 0deg),
            ${agent.color.text},
            #a855f7,
            #3b82f6,
            #10b981,
            #f59e0b,
            ${agent.color.text}
          )`,
          animation: isSelected ? 'glowRotate 3s linear infinite' : 'none',
          filter: 'blur(4px)',
        }}
      />

      {/* 主卡片 */}
      <div
        className="relative w-[200px] h-[260px] rounded-[28px] overflow-hidden transition-all duration-400 ease-out cursor-pointer"
        style={{
          background: 'linear-gradient(145deg, rgba(25, 28, 40, 0.98) 0%, rgba(15, 17, 25, 0.99) 100%)',
          boxShadow: isSelected
            ? `0 25px 50px -12px rgba(0, 0, 0, 0.7), 0 0 60px -15px ${agent.color.text}40`
            : '0 20px 40px -12px rgba(0, 0, 0, 0.5)',
          transform: isSelected
            ? 'translateY(-8px) scale(1.02)'
            : 'translateY(0) scale(1)',
        }}
      >
        {/* 顶部渐变光效 */}
        <div
          className="absolute top-0 left-0 right-0 h-32 pointer-events-none transition-opacity duration-400"
          style={{
            background: isSelected
              ? `linear-gradient(180deg, ${agent.color.text}20 0%, transparent 100%)`
              : 'linear-gradient(180deg, rgba(255,255,255,0.02) 0%, transparent 100%)',
          }}
        />

        {/* 图标区域 */}
        <div className="relative pt-8 pb-4 flex justify-center">
          <div
            className="relative w-[100px] h-[100px] transition-all duration-400"
            style={{
              // 选中时图标有轻微的浮动呼吸效果
              transform: isSelected ? 'scale(1.08) translateY(-2px)' : 'scale(1)',
              filter: isSelected
                ? `drop-shadow(0 0 25px ${agent.color.text}70)`
                : 'drop-shadow(0 4px 8px rgba(0,0,0,0.3))',
              animation: isSelected ? 'iconBreathe 2s ease-in-out infinite' : 'none',
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
          {/* 名称 */}
          <h3
            className="text-[18px] font-semibold text-center mb-2 transition-all duration-300"
            style={{
              color: isSelected ? '#fff' : 'rgba(255,255,255,0.85)',
            }}
          >
            {agent.name}
          </h3>

          {/* 描述 */}
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
      }, 280);
    },
    [navigate, close, addRecentVisit]
  );

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
        animation: isClosing
          ? 'bgFadeOut 0.25s cubic-bezier(0.55, 0, 1, 0.45) both'
          : 'bgFadeIn 0.35s cubic-bezier(0.22, 1, 0.36, 1) both',
      }}
    >
      {/* Linear 风格深黑背景 */}
      <div
        className="absolute inset-0"
        style={{
          background: 'linear-gradient(180deg, #0a0a0f 0%, #0f0f18 50%, #0a0a12 100%)',
        }}
      />

      {/* 微妙的网格背景 */}
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

      {/* 中央光晕 - 更柔和 */}
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
              onClick={() => navigateToAgent(agent)}
              onMouseEnter={() => setSelectedIndex(index)}
              isClosing={isClosing}
            />
          ))}
        </div>

        {/* 底部提示 */}
        <div
          className="mt-12 flex justify-center gap-8"
          style={{
            animation: isClosing ? 'none' : 'hintFadeIn 0.5s cubic-bezier(0.22, 1, 0.36, 1) 0.35s both',
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

      {/* 动画样式 - Apple 风格曲线 */}
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
        /* Apple 风格入场: 快速启动 → 平滑减速 → 精准到位 */
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
        /* 彩虹流光旋转 */
        @keyframes glowRotate {
          from {
            --glow-angle: 0deg;
          }
          to {
            --glow-angle: 360deg;
          }
        }
        /* 图标呼吸效果 */
        @keyframes iconBreathe {
          0%, 100% {
            transform: scale(1.08) translateY(-2px);
          }
          50% {
            transform: scale(1.1) translateY(-4px);
          }
        }
        /* CSS 变量声明 for 流光角度 */
        @property --glow-angle {
          syntax: "<angle>";
          inherits: false;
          initial-value: 0deg;
        }
      `}</style>
    </div>,
    document.body
  );
}

export default AgentSwitcher;
