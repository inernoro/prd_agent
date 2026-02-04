/**
 * Agent Switcher Provider
 *
 * 全局 Provider 组件，负责：
 * - 监听全局快捷键 Cmd/Ctrl + K
 * - 渲染 AgentSwitcher 浮层
 */

import { useEffect, type ReactNode } from 'react';
import { useAgentSwitcherStore } from '@/stores/agentSwitcherStore';
import { AgentSwitcher } from './AgentSwitcher';

interface AgentSwitcherProviderProps {
  children: ReactNode;
}

export function AgentSwitcherProvider({ children }: AgentSwitcherProviderProps) {
  const { toggle, isOpen } = useAgentSwitcherStore();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + K 切换浮层
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        e.stopPropagation();
        toggle();
        return;
      }
    };

    // 使用 capture 确保优先级
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [toggle]);

  // 打开时禁止页面滚动
  useEffect(() => {
    if (isOpen) {
      const originalOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = originalOverflow;
      };
    }
  }, [isOpen]);

  return (
    <>
      {children}
      <AgentSwitcher />
    </>
  );
}

export default AgentSwitcherProvider;
