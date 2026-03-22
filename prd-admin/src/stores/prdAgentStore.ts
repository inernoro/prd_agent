import { create } from 'zustand';

/**
 * PRD Agent 共享状态 —— 桥接 AiChatPage 的内部状态与 PrdAgentSidebar。
 *
 * AiChatPage 仍然是 session/message 的唯一所有者，
 * 但通过 syncSessions / syncActiveSessionId 把关键字段发布到此 store，
 * Sidebar 则通过此 store 读取并渲染，避免重构 AiChatPage 的 1900+ 行逻辑。
 */

export type PrdAgentMode = 'chat' | 'preview';

export interface PrdAgentSessionInfo {
  sessionId: string;
  documentId: string;
  documentTitle: string;
  documents?: Array<{ documentId: string; documentTitle: string; documentType?: string }>;
  title: string;
  createdAt: number;
  updatedAt: number;
  archivedAtUtc?: string | null;
}

interface PrdAgentState {
  /** 当前模式：chat / preview */
  mode: PrdAgentMode;
  /** 会话列表（由 AiChatPage 同步） */
  sessions: PrdAgentSessionInfo[];
  /** 当前活跃会话 ID */
  activeSessionId: string;
  /** 当前角色 */
  currentRole: 'PM' | 'DEV' | 'QA';
  /** 侧边栏是否折叠 */
  sidebarCollapsed: boolean;

  // —— actions ——
  setMode: (mode: PrdAgentMode) => void;
  syncSessions: (sessions: PrdAgentSessionInfo[]) => void;
  syncActiveSessionId: (id: string) => void;
  syncCurrentRole: (role: 'PM' | 'DEV' | 'QA') => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
}

export const usePrdAgentStore = create<PrdAgentState>((set) => ({
  mode: 'chat',
  sessions: [],
  activeSessionId: '',
  currentRole: 'PM',
  sidebarCollapsed: false,

  setMode: (mode) => set({ mode }),
  syncSessions: (sessions) => set({ sessions }),
  syncActiveSessionId: (id) => set({ activeSessionId: id }),
  syncCurrentRole: (role) => set({ currentRole: role }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
}));
