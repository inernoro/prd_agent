import { create } from 'zustand';
import {
  listReportTeams,
  getReportTeam,
  listReportTemplates,
  listWeeklyReports,
  listReportUsers,
  getTeamDashboard,
} from '@/services';
import type {
  ReportTeam,
  ReportTeamMember,
  ReportTemplate,
  WeeklyReport,
  ReportUser,
  TeamDashboardData,
} from '@/services/contracts/reportAgent';

type TabKey = 'my-reports' | 'daily-log' | 'team-dashboard' | 'templates' | 'teams' | 'data-sources' | 'trends';

interface ReportAgentState {
  // Data
  teams: ReportTeam[];
  currentTeam: ReportTeam | null;
  currentTeamMembers: ReportTeamMember[];
  templates: ReportTemplate[];
  reports: WeeklyReport[];
  users: ReportUser[];
  dashboard: TeamDashboardData | null;

  // UI State
  loading: boolean;
  error: string;
  activeTab: TabKey;
  selectedReportId: string | null;
  showReportEditor: boolean;
  showTemplateDialog: boolean;
  showTeamDialog: boolean;

  // Actions
  loadTeams: () => Promise<void>;
  loadTeamDetail: (id: string) => Promise<void>;
  loadTemplates: () => Promise<void>;
  loadReports: (params?: { scope?: 'my' | 'team'; teamId?: string; weekYear?: number; weekNumber?: number }) => Promise<void>;
  loadUsers: () => Promise<void>;
  loadDashboard: (teamId: string, weekYear?: number, weekNumber?: number) => Promise<void>;
  loadAll: () => Promise<void>;

  // UI Actions
  setActiveTab: (tab: TabKey) => void;
  setSelectedReportId: (id: string | null) => void;
  setShowReportEditor: (show: boolean) => void;
  setShowTemplateDialog: (show: boolean) => void;
  setShowTeamDialog: (show: boolean) => void;

  // List helpers
  updateReportInList: (report: WeeklyReport) => void;
  addReportToList: (report: WeeklyReport) => void;
  removeReportFromList: (id: string) => void;

  reset: () => void;
}

const initialState = {
  teams: [] as ReportTeam[],
  currentTeam: null as ReportTeam | null,
  currentTeamMembers: [] as ReportTeamMember[],
  templates: [] as ReportTemplate[],
  reports: [] as WeeklyReport[],
  users: [] as ReportUser[],
  dashboard: null as TeamDashboardData | null,
  loading: false,
  error: '',
  activeTab: 'my-reports' as TabKey,
  selectedReportId: null as string | null,
  showReportEditor: false,
  showTemplateDialog: false,
  showTeamDialog: false,
};

export const useReportAgentStore = create<ReportAgentState>((set, get) => ({
  ...initialState,

  loadTeams: async () => {
    try {
      const res = await listReportTeams();
      if (res.success && res.data) {
        set({ teams: res.data.items });
      }
    } catch (e) {
      set({ error: String(e) });
    }
  },

  loadTeamDetail: async (id: string) => {
    try {
      const res = await getReportTeam({ id });
      if (res.success && res.data) {
        set({
          currentTeam: res.data.team,
          currentTeamMembers: res.data.members,
        });
      }
    } catch (e) {
      set({ error: String(e) });
    }
  },

  loadTemplates: async () => {
    try {
      const res = await listReportTemplates();
      if (res.success && res.data) {
        set({ templates: res.data.items });
      }
    } catch (e) {
      set({ error: String(e) });
    }
  },

  loadReports: async (params) => {
    set({ loading: true, error: '' });
    try {
      const res = await listWeeklyReports(params);
      if (res.success && res.data) {
        set({ reports: res.data.items, loading: false });
      } else {
        set({ error: res.error?.message || '加载失败', loading: false });
      }
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  loadUsers: async () => {
    try {
      const res = await listReportUsers();
      if (res.success && res.data) {
        set({ users: res.data.items });
      }
    } catch (e) {
      set({ error: String(e) });
    }
  },

  loadDashboard: async (teamId: string, weekYear?: number, weekNumber?: number) => {
    set({ loading: true, error: '' });
    try {
      const res = await getTeamDashboard({ teamId, weekYear, weekNumber });
      if (res.success && res.data) {
        set({ dashboard: res.data, loading: false });
      } else {
        set({ error: res.error?.message || '加载失败', loading: false });
      }
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  loadAll: async () => {
    set({ loading: true, error: '' });
    try {
      await Promise.all([
        get().loadTeams(),
        get().loadTemplates(),
        get().loadReports(),
      ]);
      set({ loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  setActiveTab: (tab) => set({ activeTab: tab }),
  setSelectedReportId: (id) => set({ selectedReportId: id }),
  setShowReportEditor: (show) => set({ showReportEditor: show }),
  setShowTemplateDialog: (show) => set({ showTemplateDialog: show }),
  setShowTeamDialog: (show) => set({ showTeamDialog: show }),

  updateReportInList: (report) => {
    set((state) => ({
      reports: state.reports.map((r) => (r.id === report.id ? report : r)),
    }));
  },

  addReportToList: (report) => {
    set((state) => ({
      reports: [report, ...state.reports],
    }));
  },

  removeReportFromList: (id) => {
    set((state) => ({
      reports: state.reports.filter((r) => r.id !== id),
    }));
  },

  reset: () => set(initialState),
}));
