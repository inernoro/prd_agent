/**
 * Agent Switcher Store
 *
 * 管理 Agent 快捷切换浮层（命令面板）的状态：
 * - 全局快捷键 Cmd/Ctrl + K 触发
 * - 最近访问 / 使用次数 / 置顶 全部本地持久化（sessionStorage）
 * - 支持 Agent / 工具 / 实用工具 统一收录
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

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
  /** Launcher 条目的稳定 id（Agent key / toolbox id / utility id） */
  id: string;
  /** 兼容旧字段：Agent key，非 Agent 条目为空字符串 */
  agentKey: string;
  /** 条目名 */
  agentName: string;
  /** 副标题，历史上记录页面名，现在默认为条目类型 */
  title: string;
  /** 跳转路径 */
  path: string;
  /** Lucide 图标名（可选，Agent 条目为空时走 appKey 图标） */
  icon?: string;
  /** 访问时间戳 */
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
  {
    key: 'video-agent',
    appKey: 'video-agent',
    name: '视频 Agent',
    icon: 'Video',
    color: {
      bg: 'rgba(236, 72, 153, 0.08)',
      border: 'rgba(236, 72, 153, 0.2)',
      iconBg: 'rgba(236, 72, 153, 0.15)',
      text: '#EC4899',
    },
    route: '/video-agent',
    statLabel: '视频',
  },
];

/** Store 状态类型 */
interface AgentSwitcherState {
  // 浮层状态
  isOpen: boolean;
  /** 当前选中项的 id（命令面板语义，替代原 selectedIndex） */
  selectedId: string | null;
  searchQuery: string;

  // 最近访问 / 使用统计 / 置顶（均持久化）
  recentVisits: RecentVisit[];
  usageCounts: Record<string, number>;
  pinnedIds: string[];

  // Actions
  open: () => void;
  close: () => void;
  toggle: () => void;
  setSelectedId: (id: string | null) => void;
  setSearchQuery: (query: string) => void;

  addRecentVisit: (visit: Omit<RecentVisit, 'timestamp'> & Partial<Pick<RecentVisit, 'id'>>) => void;
  clearRecentVisits: () => void;

  togglePin: (id: string) => void;
  isPinned: (id: string) => boolean;
  clearPins: () => void;

  resetUsage: () => void;
}

const MAX_RECENT_VISITS = 20;

export const useAgentSwitcherStore = create<AgentSwitcherState>()(
  persist(
    (set, get) => ({
      // Initial state
      isOpen: false,
      selectedId: null,
      searchQuery: '',
      recentVisits: [],
      usageCounts: {},
      pinnedIds: [],

      // Actions
      open: () => set({ isOpen: true, selectedId: null, searchQuery: '' }),

      close: () => set({ isOpen: false, searchQuery: '' }),

      toggle: () => {
        const { isOpen } = get();
        if (isOpen) {
          set({ isOpen: false, searchQuery: '' });
        } else {
          set({ isOpen: true, selectedId: null, searchQuery: '' });
        }
      },

      setSelectedId: (id) => set({ selectedId: id }),

      setSearchQuery: (query) => set({ searchQuery: query }),

      addRecentVisit: (visit) => {
        const id = visit.id ?? visit.agentKey ?? visit.path;
        const { recentVisits, usageCounts } = get();
        const newVisit: RecentVisit = {
          id,
          agentKey: visit.agentKey,
          agentName: visit.agentName,
          title: visit.title,
          path: visit.path,
          icon: visit.icon,
          timestamp: Date.now(),
        };

        // 移除相同 id 的旧记录
        const filtered = recentVisits.filter((v) => v.id !== id);
        const updated = [newVisit, ...filtered].slice(0, MAX_RECENT_VISITS);

        set({
          recentVisits: updated,
          usageCounts: { ...usageCounts, [id]: (usageCounts[id] ?? 0) + 1 },
        });
      },

      clearRecentVisits: () => set({ recentVisits: [] }),

      togglePin: (id: string) => {
        const { pinnedIds } = get();
        if (pinnedIds.includes(id)) {
          set({ pinnedIds: pinnedIds.filter((p) => p !== id) });
        } else {
          set({ pinnedIds: [id, ...pinnedIds].slice(0, 20) });
        }
      },

      isPinned: (id: string) => get().pinnedIds.includes(id),

      clearPins: () => set({ pinnedIds: [] }),

      resetUsage: () => set({ usageCounts: {} }),
    }),
    {
      name: 'prd-admin-agent-switcher',
      version: 2,
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({
        recentVisits: state.recentVisits,
        usageCounts: state.usageCounts,
        pinnedIds: state.pinnedIds,
      }),
      // v1 → v2 迁移：补齐 id 字段，兼容老数据结构
      migrate: (persisted: unknown, version: number) => {
        const state = (persisted ?? {}) as Partial<AgentSwitcherState>;
        if (version < 2) {
          const visits = (state.recentVisits ?? []).map((v: RecentVisit) => ({
            ...v,
            id: v.id ?? v.agentKey ?? v.path,
          }));
          return {
            ...state,
            recentVisits: visits,
            usageCounts: state.usageCounts ?? {},
            pinnedIds: state.pinnedIds ?? [],
          } as AgentSwitcherState;
        }
        return state as AgentSwitcherState;
      },
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
