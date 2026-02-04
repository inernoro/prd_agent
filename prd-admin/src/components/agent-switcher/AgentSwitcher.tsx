/**
 * Agent Switcher 浮层组件
 *
 * macOS Control Center 风格的 Agent 快捷切换面板
 * - 全局快捷键 Cmd/Ctrl + K 唤起
 * - 支持键盘导航
 * - 显示最近访问记录
 */

import { useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import {
  MessagesSquare,
  Image,
  PenLine,
  Bug,
  Search,
  Command,
  ArrowUp,
  ArrowDown,
  CornerDownLeft,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  useAgentSwitcherStore,
  AGENT_DEFINITIONS,
  getRelativeTime,
  getAgentByKey,
  type AgentDefinition,
} from '@/stores/agentSwitcherStore';

/** 图标映射 */
const ICON_MAP: Record<string, LucideIcon> = {
  MessagesSquare,
  Image,
  PenLine,
  Bug,
};

/** Agent 快捷项 */
function AgentQuickItem({
  agent,
  index,
  isSelected,
  onClick,
}: {
  agent: AgentDefinition;
  index: number;
  isSelected: boolean;
  onClick: () => void;
}) {
  const Icon = ICON_MAP[agent.icon] || MessagesSquare;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group relative flex flex-col items-center gap-2 p-4 rounded-[18px]',
        'transition-all duration-200 ease-out',
        'outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/50'
      )}
      style={{
        background: isSelected ? agent.color.bg : 'rgba(255, 255, 255, 0.03)',
        border: `1px solid ${isSelected ? agent.color.border : 'rgba(255, 255, 255, 0.06)'}`,
        transform: isSelected ? 'scale(1.02)' : 'scale(1)',
      }}
      data-index={index}
    >
      {/* 图标容器 */}
      <div
        className="w-12 h-12 rounded-[14px] flex items-center justify-center transition-all duration-200"
        style={{
          background: agent.color.iconBg,
          boxShadow: isSelected ? `0 4px 16px ${agent.color.bg}` : 'none',
        }}
      >
        <Icon size={24} style={{ color: agent.color.text }} />
      </div>

      {/* 名称 */}
      <div
        className="text-[13px] font-medium transition-colors duration-200"
        style={{ color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)' }}
      >
        {agent.name}
      </div>

      {/* 快捷键提示 */}
      <div
        className="absolute top-2 right-2 w-5 h-5 rounded-md flex items-center justify-center text-[10px] font-bold opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ background: 'rgba(255, 255, 255, 0.1)', color: 'var(--text-muted)' }}
      >
        {index + 1}
      </div>
    </button>
  );
}

/** 最近访问项 */
function RecentVisitItem({
  agentKey,
  agentName,
  title,
  path: _path,
  timestamp,
  onClick,
}: {
  agentKey: string;
  agentName: string;
  title: string;
  path: string;
  timestamp: number;
  onClick: () => void;
}) {
  void _path; // 保留用于未来扩展
  const agent = getAgentByKey(agentKey);
  const Icon = agent ? ICON_MAP[agent.icon] || MessagesSquare : MessagesSquare;
  const color = agent?.color.text || 'var(--text-muted)';

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-3 px-3 py-2.5 rounded-[12px]',
        'transition-all duration-150 ease-out',
        'hover:bg-white/5 active:bg-white/8',
        'outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/50'
      )}
    >
      <div
        className="w-8 h-8 rounded-[10px] flex items-center justify-center shrink-0"
        style={{ background: agent?.color.iconBg || 'rgba(255,255,255,0.05)' }}
      >
        <Icon size={16} style={{ color }} />
      </div>

      <div className="flex-1 min-w-0 text-left">
        <div className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
          {agentName}
          <span className="mx-1.5 opacity-40">/</span>
          <span style={{ color: 'var(--text-secondary)' }}>{title}</span>
        </div>
      </div>

      <div className="text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>
        {getRelativeTime(timestamp)}
      </div>
    </button>
  );
}

/** 主浮层组件 */
export function AgentSwitcher() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const {
    isOpen,
    selectedIndex,
    searchQuery,
    recentVisits,
    close,
    setSearchQuery,
    moveSelection,
    addRecentVisit,
  } = useAgentSwitcherStore();

  // 打开时聚焦输入框
  useEffect(() => {
    if (isOpen && inputRef.current) {
      // 延迟聚焦，确保动画开始后再聚焦
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

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

  // 导航到最近访问
  const navigateToRecent = useCallback(
    (path: string) => {
      close();
      navigate(path);
    },
    [navigate, close]
  );

  // 键盘事件处理
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // 阻止默认行为的按键
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape'].includes(e.key)) {
        e.preventDefault();
      }

      switch (e.key) {
        case 'Escape':
          close();
          break;

        case 'ArrowUp':
          moveSelection('up');
          break;

        case 'ArrowDown':
          moveSelection('down');
          break;

        case 'ArrowLeft':
          moveSelection('left');
          break;

        case 'ArrowRight':
          moveSelection('right');
          break;

        case 'Enter': {
          const agent = AGENT_DEFINITIONS[selectedIndex];
          if (agent) {
            navigateToAgent(agent);
          }
          break;
        }

        // 数字键快速跳转
        case '1':
        case '2':
        case '3':
        case '4': {
          const index = parseInt(e.key, 10) - 1;
          const agent = AGENT_DEFINITIONS[index];
          if (agent) {
            navigateToAgent(agent);
          }
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
      if (e.target === e.currentTarget) {
        close();
      }
    },
    [close]
  );

  // 过滤搜索结果
  const filteredAgents = searchQuery
    ? AGENT_DEFINITIONS.filter(
        (a) =>
          a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          a.key.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : AGENT_DEFINITIONS;

  if (!isOpen) return null;

  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center pt-[12vh]"
      onClick={handleBackdropClick}
      style={{
        background: 'rgba(0, 0, 0, 0.5)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
      }}
    >
      {/* 主面板 */}
      <div
        ref={containerRef}
        className="w-[560px] max-h-[480px] overflow-hidden rounded-[24px] flex flex-col"
        style={{
          background:
            'linear-gradient(180deg, rgba(28, 28, 32, 0.95) 0%, rgba(22, 22, 26, 0.98) 100%)',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          boxShadow:
            '0 24px 80px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05) inset, 0 1px 0 rgba(255, 255, 255, 0.1) inset',
          backdropFilter: 'blur(40px) saturate(180%)',
          WebkitBackdropFilter: 'blur(40px) saturate(180%)',
          animation: 'agentSwitcherIn 200ms ease-out',
        }}
        role="dialog"
        aria-modal="true"
        aria-label="Agent 快捷切换"
      >
        {/* 搜索栏 */}
        <div className="px-4 pt-4 pb-3">
          <div
            className="flex items-center gap-3 px-4 py-3 rounded-[14px]"
            style={{
              background: 'rgba(255, 255, 255, 0.05)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
            }}
          >
            <Search size={18} style={{ color: 'var(--text-muted)' }} />
            <input
              ref={inputRef}
              type="text"
              placeholder="搜索 Agent 或快速操作..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="flex-1 bg-transparent text-[14px] outline-none placeholder:text-[var(--text-muted)]"
              style={{ color: 'var(--text-primary)' }}
              autoComplete="off"
              spellCheck={false}
            />
            <div
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px]"
              style={{ background: 'rgba(255, 255, 255, 0.08)', color: 'var(--text-muted)' }}
            >
              {isMac ? <Command size={11} /> : 'Ctrl'}
              <span>K</span>
            </div>
          </div>
        </div>

        {/* Agent 网格 */}
        <div className="px-4 pb-3">
          <div className="grid grid-cols-4 gap-2">
            {filteredAgents.map((agent, index) => (
              <AgentQuickItem
                key={agent.key}
                agent={agent}
                index={index}
                isSelected={selectedIndex === index}
                onClick={() => navigateToAgent(agent)}
              />
            ))}
          </div>
        </div>

        {/* 最近访问 */}
        {recentVisits.length > 0 && (
          <div className="flex-1 min-h-0 px-4 pb-4 overflow-y-auto">
            <div
              className="flex items-center gap-2 mb-2 text-[11px] font-medium uppercase tracking-wider"
              style={{ color: 'var(--text-muted)' }}
            >
              <div className="flex-1 h-px" style={{ background: 'rgba(255, 255, 255, 0.08)' }} />
              <span>最近访问</span>
              <div className="flex-1 h-px" style={{ background: 'rgba(255, 255, 255, 0.08)' }} />
            </div>

            <div className="space-y-0.5">
              {recentVisits.slice(0, 5).map((visit, index) => (
                <RecentVisitItem
                  key={`${visit.path}-${index}`}
                  {...visit}
                  onClick={() => navigateToRecent(visit.path)}
                />
              ))}
            </div>
          </div>
        )}

        {/* 底部快捷键提示 */}
        <div
          className="px-4 py-3 flex items-center justify-center gap-6 text-[11px]"
          style={{
            borderTop: '1px solid rgba(255, 255, 255, 0.06)',
            color: 'var(--text-muted)',
          }}
        >
          <div className="flex items-center gap-1.5">
            <span className="text-[var(--text-muted)]">ESC</span>
            <span>关闭</span>
          </div>
          <div className="flex items-center gap-1.5">
            <ArrowUp size={12} />
            <ArrowDown size={12} />
            <span>选择</span>
          </div>
          <div className="flex items-center gap-1.5">
            <CornerDownLeft size={12} />
            <span>打开</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="font-mono">1-4</span>
            <span>快速跳转</span>
          </div>
        </div>
      </div>

      {/* 动画样式 */}
      <style>{`
        @keyframes agentSwitcherIn {
          from {
            opacity: 0;
            transform: scale(0.96) translateY(-8px);
          }
          to {
            opacity: 1;
            transform: scale(1) translateY(0);
          }
        }
      `}</style>
    </div>,
    document.body
  );
}

export default AgentSwitcher;
