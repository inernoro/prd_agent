import { create } from 'zustand';
import * as svc from '@/services/real/transcriptAgent';
import type {
  TranscriptWorkspace,
  TranscriptItem,
  TranscriptRun,
  TranscriptTemplate,
} from '@/services/contracts/transcriptAgent';

interface TranscriptState {
  workspaces: TranscriptWorkspace[];
  currentWorkspace: TranscriptWorkspace | null;
  items: TranscriptItem[];
  runs: TranscriptRun[];
  templates: TranscriptTemplate[];
  loading: boolean;
  error: string;

  fetchWorkspaces: () => Promise<void>;
  selectWorkspace: (id: string) => Promise<void>;
  createWorkspace: (title: string) => Promise<TranscriptWorkspace | null>;
  deleteWorkspace: (id: string) => Promise<void>;
  uploadFile: (file: File) => Promise<void>;
  deleteItem: (itemId: string) => Promise<void>;
  fetchTemplates: () => Promise<void>;
  createCopywrite: (itemId: string, templateId: string) => Promise<TranscriptRun | null>;
  pollRun: (runId: string) => Promise<TranscriptRun | null>;
  refreshItems: () => Promise<void>;
}

export const useTranscriptStore = create<TranscriptState>((set, get) => ({
  workspaces: [],
  currentWorkspace: null,
  items: [],
  runs: [],
  templates: [],
  loading: false,
  error: '',

  fetchWorkspaces: async () => {
    set({ loading: true, error: '' });
    const res = await svc.listWorkspaces();
    if (res.ok) set({ workspaces: res.data! });
    else set({ error: res.error ?? '加载失败' });
    set({ loading: false });
  },

  selectWorkspace: async (id: string) => {
    set({ loading: true, error: '' });
    const [wsRes, itemsRes, runsRes] = await Promise.all([
      svc.getWorkspace(id),
      svc.listItems(id),
      svc.listRuns(id),
    ]);
    if (wsRes.ok) {
      set({
        currentWorkspace: wsRes.data!,
        items: itemsRes.ok ? itemsRes.data! : [],
        runs: runsRes.ok ? runsRes.data! : [],
      });
    } else {
      set({ error: wsRes.error ?? '加载工作区失败' });
    }
    set({ loading: false });
  },

  createWorkspace: async (title: string) => {
    const res = await svc.createWorkspace(title);
    if (res.ok && res.data) {
      set(s => ({ workspaces: [res.data!, ...s.workspaces] }));
      return res.data;
    }
    set({ error: res.error ?? '创建失败' });
    return null;
  },

  deleteWorkspace: async (id: string) => {
    const res = await svc.deleteWorkspace(id);
    if (res.ok) {
      set(s => ({
        workspaces: s.workspaces.filter(w => w.id !== id),
        currentWorkspace: s.currentWorkspace?.id === id ? null : s.currentWorkspace,
        items: s.currentWorkspace?.id === id ? [] : s.items,
      }));
    }
  },

  uploadFile: async (file: File) => {
    const ws = get().currentWorkspace;
    if (!ws) return;
    set({ loading: true });
    const res = await svc.uploadItem(ws.id, file);
    if (res.ok && res.data) {
      set(s => ({ items: [res.data!.item, ...s.items] }));
    } else {
      set({ error: res.error ?? '上传失败' });
    }
    set({ loading: false });
  },

  deleteItem: async (itemId: string) => {
    const res = await svc.deleteItem(itemId);
    if (res.ok) {
      set(s => ({ items: s.items.filter(i => i.id !== itemId) }));
    }
  },

  fetchTemplates: async () => {
    const res = await svc.listTemplates();
    if (res.ok) set({ templates: res.data! });
  },

  createCopywrite: async (itemId: string, templateId: string) => {
    const res = await svc.createCopywriteRun(itemId, templateId);
    if (res.ok && res.data) {
      set(s => ({ runs: [res.data!, ...s.runs] }));
      return res.data;
    }
    set({ error: res.error ?? '文案生成失败' });
    return null;
  },

  pollRun: async (runId: string) => {
    const res = await svc.getRun(runId);
    if (res.ok && res.data) {
      set(s => ({
        runs: s.runs.map(r => r.id === runId ? res.data! : r),
      }));
      return res.data;
    }
    return null;
  },

  refreshItems: async () => {
    const ws = get().currentWorkspace;
    if (!ws) return;
    const res = await svc.listItems(ws.id);
    if (res.ok) set({ items: res.data! });
  },
}));
