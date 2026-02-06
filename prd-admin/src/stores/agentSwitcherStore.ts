/**
 * Agent Switcher Store
 *
 * 管理 Agent 快捷切换浮层的状态和最近访问记录
 * - 全局快捷键 Cmd/Ctrl + K 触发
 * - 最近访问记录本地持久化
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** Agent 定义 */
export interface AgentDefinition {
  key: string;
  appKey: string;
  name: string;
  icon: string;
  color: {
    bg: string;
    border: string;
    iconBg: string;
    text: string;
  };
  route: string;
  statLabel: string;
}

/** 最近访问记录 */
export interface RecentVisit {
  agentKey: string;
  agentName: string;
  title: string;
  path: string;
  timestamp: number;
}

/** Agent 列表定义 */
export const AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    key: 'prd-agent',
    appKey: 'prd-agent',
    name: 'PRD Agent',
    icon: 'MessagesSquare',
    color: {
      bg: 'rgba(59, 130, 246, 0.08)',
      border: 'rgba(59, 130, 246, 0.2)',
      iconBg: 'rgba(59, 130, 246, 0.15)',
      text: '#60A5FA',
    },
    route: '/prd-agent',
    statLabel: '会话',
  },
  {
    key: 'visual-agent',
    appKey: 'visual-agent',
    name: '视觉 Agent',
    icon: 'Image',
    color: {
      bg: 'rgba(139, 92, 246, 0.08)',
      border: 'rgba(139, 92, 246, 0.2)',
      iconBg: 'rgba(139, 92, 246, 0.15)',
      text: '#A78BFA',
    },
    route: '/visual-agent',
    statLabel: '画布',
  },
  {
    key: 'literary-agent',
    appKey: 'literary-agent',
    name: '文学 Agent',
    icon: 'PenLine',
    color: {
      bg: 'rgba(34, 197, 94, 0.08)',
      border: 'rgba(34, 197, 94, 0.2)',
      iconBg: 'rgba(34, 197, 94, 0.15)',
      text: '#4ADE80',
    },
    route: '/literary-agent',
    statLabel: '项目',
  },
  {
    key: 'defect-agent',
    appKey: 'defect-agent',
    name: '缺陷 Agent',
    icon: 'Bug',
    color: {
      bg: 'rgba(249, 115, 22, 0.08)',
      border: 'rgba(249, 115, 22, 0.2)',
      iconBg: 'rgba(249, 115, 22, 0.15)',
      text: '#FB923C',
    },
    route: '/defect-agent',
    statLabel: '缺陷',
  },
];

/** Store 状态类型 */
interface AgentSwitcherState {
  // 浮层状态
  isOpen: boolean;
  selectedIndex: number;
  searchQuery: string;

  // 最近访问
  recentVisits: RecentVisit[];

  // Actions
  open: () => void;
  close: () => void;
  toggle: () => void;
  setSelectedIndex: (index: number) => void;
  setSearchQuery: (query: string) => void;
  moveSelection: (direction: 'up' | 'down' | 'left' | 'right') => void;
  addRecentVisit: (visit: Omit<RecentVisit, 'timestamp'>) => void;
  clearRecentVisits: () => void;
}

const MAX_RECENT_VISITS = 10;

export const useAgentSwitcherStore = create<AgentSwitcherState>()(
  persist(
    (set, get) => ({
      // Initial state
      isOpen: false,
      selectedIndex: 0,
      searchQuery: '',
      recentVisits: [],

      // Actions
      open: () => set({ isOpen: true, selectedIndex: 0, searchQuery: '' }),

      close: () => set({ isOpen: false, searchQuery: '' }),

      toggle: () => {
        const { isOpen } = get();
        if (isOpen) {
          set({ isOpen: false, searchQuery: '' });
        } else {
          set({ isOpen: true, selectedIndex: 0, searchQuery: '' });
        }
      },

      setSelectedIndex: (index) => set({ selectedIndex: index }),

      setSearchQuery: (query) => set({ searchQuery: query }),

      moveSelection: (direction) => {
        const { selectedIndex } = get();
        const totalItems = AGENT_DEFINITIONS.length;
        const cols = 4; // 网格列数

        let newIndex = selectedIndex;

        switch (direction) {
          case 'up':
            newIndex = selectedIndex - cols;
            if (newIndex < 0) newIndex = selectedIndex;
            break;
          case 'down':
            newIndex = selectedIndex + cols;
            if (newIndex >= totalItems) newIndex = selectedIndex;
            break;
          case 'left':
            newIndex = selectedIndex - 1;
            if (newIndex < 0) newIndex = totalItems - 1;
            break;
          case 'right':
            newIndex = selectedIndex + 1;
            if (newIndex >= totalItems) newIndex = 0;
            break;
        }

        set({ selectedIndex: newIndex });
      },

      addRecentVisit: (visit) => {
        const { recentVisits } = get();
        const newVisit: RecentVisit = {
          ...visit,
          timestamp: Date.now(),
        };

        // 移除相同路径的旧记录
        const filtered = recentVisits.filter((v) => v.path !== visit.path);

        // 添加到开头，限制最大数量
        const updated = [newVisit, ...filtered].slice(0, MAX_RECENT_VISITS);

        set({ recentVisits: updated });
      },

      clearRecentVisits: () => set({ recentVisits: [] }),
    }),
    {
      name: 'prd-admin-agent-switcher',
      // 只持久化最近访问记录
      partialize: (state) => ({ recentVisits: state.recentVisits }),
    }
  )
);

/** 工具函数：获取相对时间描述 */
export function getRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (hours < 24) return `${hours} 小时前`;
  if (days < 7) return `${days} 天前`;

  return new Date(timestamp).toLocaleDateString('zh-CN');
}

/** 工具函数：根据 appKey 获取 Agent 定义 */
export function getAgentByKey(key: string): AgentDefinition | undefined {
  return AGENT_DEFINITIONS.find((a) => a.key === key || a.appKey === key);
}
