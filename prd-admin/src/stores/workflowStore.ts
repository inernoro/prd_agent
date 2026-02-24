import { create } from 'zustand';
import {
  listWorkflows,
  getWorkflow,
  listExecutions,
  getExecution,
  listShareLinks,
} from '@/services';
import type {
  Workflow,
  WorkflowExecution,
  ShareLink,
} from '@/services/contracts/workflowAgent';

type ViewMode = 'list' | 'detail' | 'execution-list' | 'execution-detail' | 'shares';

interface WorkflowState {
  // Data
  workflows: Workflow[];
  total: number;
  selectedWorkflow: Workflow | null;
  executions: WorkflowExecution[];
  executionsTotal: number;
  selectedExecution: WorkflowExecution | null;
  shares: ShareLink[];

  // UI
  loading: boolean;
  error: string;
  viewMode: ViewMode;
  tagFilter: string;

  // Actions
  loadWorkflows: (tag?: string) => Promise<void>;
  loadWorkflow: (id: string) => Promise<void>;
  loadExecutions: (workflowId?: string, status?: string) => Promise<void>;
  loadExecution: (id: string) => Promise<void>;
  loadShares: () => Promise<void>;

  setViewMode: (mode: ViewMode) => void;
  setSelectedWorkflow: (wf: Workflow | null) => void;
  setSelectedExecution: (exec: WorkflowExecution | null) => void;
  setTagFilter: (tag: string) => void;

  // Local state updates
  addWorkflow: (wf: Workflow) => void;
  updateWorkflowInList: (wf: Workflow) => void;
  removeWorkflow: (id: string) => void;
  addExecution: (exec: WorkflowExecution) => void;

  reset: () => void;
}

const initialState = {
  workflows: [] as Workflow[],
  total: 0,
  selectedWorkflow: null as Workflow | null,
  executions: [] as WorkflowExecution[],
  executionsTotal: 0,
  selectedExecution: null as WorkflowExecution | null,
  shares: [] as ShareLink[],
  loading: false,
  error: '',
  viewMode: 'list' as ViewMode,
  tagFilter: '',
};

export const useWorkflowStore = create<WorkflowState>((set, get) => ({
  ...initialState,

  loadWorkflows: async (tag) => {
    set({ loading: true, error: '' });
    try {
      const res = await listWorkflows({ tag: tag || get().tagFilter || undefined, pageSize: 100 });
      if (res.success && res.data) {
        set({ workflows: res.data.items, total: res.data.total });
      } else {
        set({ error: res.error?.message || '加载失败' });
      }
    } catch (e: unknown) {
      set({ error: e instanceof Error ? e.message : '加载失败' });
    } finally {
      set({ loading: false });
    }
  },

  loadWorkflow: async (id) => {
    set({ loading: true, error: '' });
    try {
      const res = await getWorkflow(id);
      if (res.success && res.data) {
        set({ selectedWorkflow: res.data.workflow });
      }
    } catch (e: unknown) {
      set({ error: e instanceof Error ? e.message : '加载失败' });
    } finally {
      set({ loading: false });
    }
  },

  loadExecutions: async (workflowId, status) => {
    set({ loading: true, error: '' });
    try {
      const res = await listExecutions({ workflowId, status, pageSize: 50 });
      if (res.success && res.data) {
        set({ executions: res.data.items, executionsTotal: res.data.total });
      }
    } catch (e: unknown) {
      set({ error: e instanceof Error ? e.message : '加载失败' });
    } finally {
      set({ loading: false });
    }
  },

  loadExecution: async (id) => {
    set({ loading: true, error: '' });
    try {
      const res = await getExecution(id);
      if (res.success && res.data) {
        set({ selectedExecution: res.data.execution });
      }
    } catch (e: unknown) {
      set({ error: e instanceof Error ? e.message : '加载失败' });
    } finally {
      set({ loading: false });
    }
  },

  loadShares: async () => {
    try {
      const res = await listShareLinks();
      if (res.success && res.data) {
        set({ shares: res.data.items });
      }
    } catch { /* ignore */ }
  },

  setViewMode: (mode) => set({ viewMode: mode }),
  setSelectedWorkflow: (wf) => set({ selectedWorkflow: wf }),
  setSelectedExecution: (exec) => set({ selectedExecution: exec }),
  setTagFilter: (tag) => set({ tagFilter: tag }),

  addWorkflow: (wf) => set((s) => ({ workflows: [wf, ...s.workflows], total: s.total + 1 })),
  updateWorkflowInList: (wf) => set((s) => ({
    workflows: s.workflows.map((w) => (w.id === wf.id ? wf : w)),
    selectedWorkflow: s.selectedWorkflow?.id === wf.id ? wf : s.selectedWorkflow,
  })),
  removeWorkflow: (id) => set((s) => ({
    workflows: s.workflows.filter((w) => w.id !== id),
    total: s.total - 1,
    selectedWorkflow: s.selectedWorkflow?.id === id ? null : s.selectedWorkflow,
  })),
  addExecution: (exec) => set((s) => ({
    executions: [exec, ...s.executions],
    executionsTotal: s.executionsTotal + 1,
  })),

  reset: () => set(initialState),
}));
