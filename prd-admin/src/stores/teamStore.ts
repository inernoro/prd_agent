import { create } from 'zustand';
import {
  listMyTeams,
  getTeam,
  type Team,
  type TeamListItem,
  type TeamMember,
  type TeamRole,
  type WebHostingRole,
} from '@/services/real/teams';

// 记住每个模块上次选中的团队 / 作用域（禁用 localStorage，统一 sessionStorage）
const SCOPE_KEY = 'team-scope-selection';

type ScopeSelection = Record<string, { scope: 'mine' | 'team'; teamId: string | null }>;

function readScopeSelection(): ScopeSelection {
  try {
    const raw = sessionStorage.getItem(SCOPE_KEY);
    return raw ? (JSON.parse(raw) as ScopeSelection) : {};
  } catch {
    return {};
  }
}

function writeScopeSelection(sel: ScopeSelection) {
  try {
    sessionStorage.setItem(SCOPE_KEY, JSON.stringify(sel));
  } catch {
    // ignore
  }
}

interface TeamState {
  teams: TeamListItem[];
  loading: boolean;
  loaded: boolean;
  // 当前管理面板打开的团队详情
  currentTeam: Team | null;
  currentMembers: TeamMember[];
  currentMyRole: TeamRole | null;
  // 网页托管有效角色（userId → owner/editor/viewer）+ 我的有效角色
  currentWebHostingRoles: Record<string, WebHostingRole>;
  currentMyWebHostingRole: WebHostingRole | null;

  loadTeams: (force?: boolean) => Promise<void>;
  /** 本地乐观改名（双击重命名即时生效，API 失败由调用方回滚） */
  renameTeamLocal: (teamId: string, name: string) => void;
  loadTeamDetail: (teamId: string) => Promise<void>;
  clearDetail: () => void;

  // 每个模块（"web-hosting" / "document-store"）的我的/团队作用域选择
  getScope: (moduleKey: string) => { scope: 'mine' | 'team'; teamId: string | null };
  setScope: (moduleKey: string, scope: 'mine' | 'team', teamId: string | null) => void;
}

export const useTeamStore = create<TeamState>((set, get) => ({
  teams: [],
  loading: false,
  loaded: false,
  currentTeam: null,
  currentMembers: [],
  currentMyRole: null,
  currentWebHostingRoles: {},
  currentMyWebHostingRole: null,

  loadTeams: async (force = false) => {
    if (get().loading) return;
    if (get().loaded && !force) return;
    set({ loading: true });
    const res = await listMyTeams();
    if (res.success) {
      set({ teams: res.data.items, loaded: true });
    }
    set({ loading: false });
  },

  renameTeamLocal: (teamId: string, name: string) =>
    set((s) => ({
      teams: s.teams.map((t) => (t.team.id === teamId ? { ...t, team: { ...t.team, name } } : t)),
    })),

  loadTeamDetail: async (teamId: string) => {
    const res = await getTeam(teamId);
    if (res.success) {
      set({
        currentTeam: res.data.team,
        currentMembers: res.data.members,
        currentMyRole: res.data.myRole,
        currentWebHostingRoles: res.data.webHostingRoles ?? {},
        currentMyWebHostingRole: res.data.myWebHostingRole ?? null,
      });
    }
  },

  clearDetail: () =>
    set({
      currentTeam: null,
      currentMembers: [],
      currentMyRole: null,
      currentWebHostingRoles: {},
      currentMyWebHostingRole: null,
    }),

  getScope: (moduleKey: string) => {
    const sel = readScopeSelection();
    return sel[moduleKey] ?? { scope: 'mine', teamId: null };
  },

  setScope: (moduleKey: string, scope: 'mine' | 'team', teamId: string | null) => {
    const sel = readScopeSelection();
    sel[moduleKey] = { scope, teamId };
    writeScopeSelection(sel);
    // 触发订阅者重渲染（用一个递增 tick 没必要——组件本地 state 控制即可）
    set({});
  },
}));
