/**
 * Agent Switcher Store
 *
 * 管理 Agent 快捷切换浮层（命令面板）的状态：
 * - 全局快捷键 Cmd/Ctrl + K 触发
 * - 最近访问 / 使用次数 / 置顶：**云端同步**（UserPreferences.AgentSwitcherPreferences）
 *   sessionStorage 仅作本地缓存，避免首屏闪烁；真正权威在后端
 * - 换分支 / 换浏览器 / 换设备 同一账号收藏保持一致
 *
 * 同步策略：
 * - 启动时 `loadFromServer()` 拉取云端 → 合并本地（服务端优先；若服务端空但本地有，
 *   push 上去免丢失老数据）
 * - 每次 mutation（togglePin / addRecentVisit / clear / reset）debounce 800ms PUT 回后端
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  getUserPreferences,
  updateAgentSwitcherPreferences,
} from '@/services';
import { registerLogoutReset } from '@/stores/authStore';
import { migrateLegacyNavId } from '@/lib/launcherCatalog';

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
  /**
   * 路由 RequirePermission 实际要求的权限 key（必须 1:1 对齐目标 Route 的 perm）。
   * 禁止用 `${appKey}.use` 自动推导 —— arena 的 appKey="arena" 但路由要 arena-agent.use,
   * 见 `buildToolboxItems` 同样的反模式注释。
   */
  permission: string;
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
// 注：PRD 解读智能体 Web 端已下线，不在此处注册（命令面板/导航自定义不再展示）
// permission 必须与目标路由 RequirePermission 1:1 对齐，禁止用 `${appKey}.use` 推导。
export const AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    key: 'visual-agent',
    appKey: 'visual-agent',
    name: '视觉创作智能体',
    icon: 'Image',
    color: {
      bg: 'rgba(139, 92, 246, 0.08)',
      border: 'rgba(139, 92, 246, 0.2)',
      iconBg: 'rgba(139, 92, 246, 0.15)',
      text: '#A78BFA',
    },
    route: '/visual-agent',
    statLabel: '画布',
    permission: 'visual-agent.use',
  },
  {
    key: 'literary-agent',
    appKey: 'literary-agent',
    name: '文学创作智能体',
    icon: 'PenLine',
    color: {
      bg: 'rgba(34, 197, 94, 0.08)',
      border: 'rgba(34, 197, 94, 0.2)',
      iconBg: 'rgba(34, 197, 94, 0.15)',
      text: '#4ADE80',
    },
    route: '/literary-agent',
    statLabel: '项目',
    permission: 'literary-agent.use',
  },
  {
    key: 'defect-agent',
    appKey: 'defect-agent',
    name: '缺陷管理智能体',
    icon: 'Bug',
    color: {
      bg: 'rgba(249, 115, 22, 0.08)',
      border: 'rgba(249, 115, 22, 0.2)',
      iconBg: 'rgba(249, 115, 22, 0.15)',
      text: '#FB923C',
    },
    route: '/defect-agent',
    statLabel: '缺陷',
    permission: 'defect-agent.use',
  },
  {
    key: 'video-agent',
    appKey: 'video-agent',
    name: '视频创作智能体',
    icon: 'Video',
    color: {
      bg: 'rgba(236, 72, 153, 0.08)',
      border: 'rgba(236, 72, 153, 0.2)',
      iconBg: 'rgba(236, 72, 153, 0.15)',
      text: '#EC4899',
    },
    route: '/video-agent',
    statLabel: '视频',
    permission: 'video-agent.use',
  },
];

/** Store 状态类型 */
interface AgentSwitcherState {
  // 浮层状态
  isOpen: boolean;
  /** 当前选中项的 id（命令面板语义，替代原 selectedIndex） */
  selectedId: string | null;
  searchQuery: string;

  // 最近访问 / 使用统计 / 置顶（均持久化到 sessionStorage + 云端）
  recentVisits: RecentVisit[];
  usageCounts: Record<string, number>;
  pinnedIds: string[];

  // 云端同步状态
  serverLoaded: boolean;
  serverLoading: boolean;

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

  /** 从后端拉取并 merge 本地（首屏调用一次；登出 → 登入需再次调用） */
  loadFromServer: () => Promise<void>;
  /** 立即把当前三项写回后端（一般不需要手动调，mutation 会自动 debounce PUT） */
  flushToServer: () => Promise<void>;
  /** 重置加载标记（登出时调用，使下次登入重新拉取） */
  resetServerSync: () => void;
}

// 模块级 debounce 定时器（跨组件共享；一次只排队一个 PUT）
let pendingSyncTimer: ReturnType<typeof setTimeout> | null = null;
const SYNC_DEBOUNCE_MS = 800;

const MAX_RECENT_VISITS = 20;

export const useAgentSwitcherStore = create<AgentSwitcherState>()(
  persist(
    (set, get) => {
      /** debounce 把当前持久化三项写回后端 */
      const scheduleSync = () => {
        if (!get().serverLoaded) {
          // 未完成首次 load 前不回写，避免用空态覆盖云端
          return;
        }
        if (pendingSyncTimer) clearTimeout(pendingSyncTimer);
        pendingSyncTimer = setTimeout(() => {
          pendingSyncTimer = null;
          void get().flushToServer();
        }, SYNC_DEBOUNCE_MS);
      };

      return {
        // Initial state
        isOpen: false,
        selectedId: null,
        searchQuery: '',
        recentVisits: [],
        usageCounts: {},
        pinnedIds: [],
        serverLoaded: false,
        serverLoading: false,

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
          scheduleSync();
        },

        clearRecentVisits: () => {
          set({ recentVisits: [] });
          scheduleSync();
        },

        togglePin: (id: string) => {
          const { pinnedIds } = get();
          if (pinnedIds.includes(id)) {
            set({ pinnedIds: pinnedIds.filter((p) => p !== id) });
          } else {
            set({ pinnedIds: [id, ...pinnedIds].slice(0, 20) });
          }
          scheduleSync();
        },

        isPinned: (id: string) => get().pinnedIds.includes(id),

        clearPins: () => {
          set({ pinnedIds: [] });
          scheduleSync();
        },

        resetUsage: () => {
          set({ usageCounts: {} });
          scheduleSync();
        },

        resetServerSync: () => {
          if (pendingSyncTimer) {
            clearTimeout(pendingSyncTimer);
            pendingSyncTimer = null;
          }
          set({ serverLoaded: false, serverLoading: false });
        },

        loadFromServer: async () => {
          const state = get();
          if (state.serverLoading || state.serverLoaded) return;
          set({ serverLoading: true });
          try {
            const res = await getUserPreferences();
            if (!res.success) {
              // 拉取失败保持本地缓存，标记为已尝试（避免无限重试打后端）
              set({ serverLoading: false, serverLoaded: true });
              return;
            }
            const remote = res.data?.agentSwitcherPreferences;
            const hasRemote = !!(
              remote && (
                (remote.pinnedIds && remote.pinnedIds.length > 0) ||
                (remote.recentVisits && remote.recentVisits.length > 0) ||
                (remote.usageCounts && Object.keys(remote.usageCounts).length > 0)
              )
            );

            if (hasRemote) {
              // 服务端有数据 → 覆盖本地（真实的跨分支 / 跨浏览器恢复场景）
              set({
                pinnedIds: remote!.pinnedIds ?? [],
                recentVisits: (remote!.recentVisits ?? []) as RecentVisit[],
                usageCounts: remote!.usageCounts ?? {},
                serverLoaded: true,
                serverLoading: false,
              });
            } else {
              // 服务端空 → 保留本地，并把本地 push 上去防止下次丢
              set({ serverLoaded: true, serverLoading: false });
              const { pinnedIds, recentVisits, usageCounts } = get();
              const hasLocal =
                pinnedIds.length > 0 ||
                recentVisits.length > 0 ||
                Object.keys(usageCounts).length > 0;
              if (hasLocal) {
                scheduleSync();
              }
            }
          } catch {
            set({ serverLoading: false, serverLoaded: true });
          }
        },

        flushToServer: async () => {
          const { pinnedIds, recentVisits, usageCounts } = get();
          try {
            await updateAgentSwitcherPreferences({
              pinnedIds,
              recentVisits,
              usageCounts,
            });
          } catch {
            // 静默失败，mutation 下次会再次 schedule
          }
        },
      };
    },
    {
      name: 'prd-admin-agent-switcher',
      version: 4,
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({
        recentVisits: state.recentVisits,
        usageCounts: state.usageCounts,
        pinnedIds: state.pinnedIds,
      }),
      // 版本迁移：
      //   v1 → v2: 补齐 RecentVisit.id 字段
      //   v2 → v3: launcherCatalog ID 从 prefixed 改成 path-derived
      //            ('agent:visual-agent' → 'visual-agent', 'utility:logs' → 'logs' 等)
      //   v3 → v4: 补充 slug remap（'models' → 'mds'，'teams' → 'users'），
      //            因为 v3 时只剥前缀没改 slug，已迁移到 v3 的用户还存着错误 slug
      migrate: (persisted: unknown, version: number) => {
        let state = (persisted ?? {}) as Partial<AgentSwitcherState>;

        if (version < 2) {
          const visits = (state.recentVisits ?? []).map((v: RecentVisit) => ({
            ...v,
            id: v.id ?? v.agentKey ?? v.path,
          }));
          state = {
            ...state,
            recentVisits: visits,
            usageCounts: state.usageCounts ?? {},
            pinnedIds: state.pinnedIds ?? [],
          };
        }

        // v2→v3 和 v3→v4 都跑同一个 migrateLegacyNavId（已经包含 slug remap）；
        // 对 v3 用户来说就是补做 slug remap 一步
        if (version < 4) {
          state = {
            ...state,
            pinnedIds: (state.pinnedIds ?? []).map(migrateLegacyNavId),
            recentVisits: (state.recentVisits ?? []).map((v: RecentVisit) => ({
              ...v,
              id: migrateLegacyNavId(v.id),
            })),
            usageCounts: Object.fromEntries(
              Object.entries(state.usageCounts ?? {}).map(([k, v]) => [migrateLegacyNavId(k), v]),
            ),
          };
        }

        return state as AgentSwitcherState;
      },
    }
  )
);

// 登出时同步清空最近访问/使用/置顶 + 重置 serverLoaded 标志，
// 避免切换账号后下个用户看到旧用户的命令面板数据
registerLogoutReset(() => {
  useAgentSwitcherStore.getState().resetServerSync();
  useAgentSwitcherStore.setState({ recentVisits: [], usageCounts: {}, pinnedIds: [] });
});

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
