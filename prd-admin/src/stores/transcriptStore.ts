import { create } from 'zustand';
import * as svc from '@/services/real/transcriptAgent';
import { toast } from '@/lib/toast';
import type {
  TranscriptWorkspace,
  TranscriptItem,
  TranscriptRun,
  TranscriptTemplate,
  TranscriptSegment,
} from '@/services/contracts/transcriptAgent';

interface TranscriptState {
  workspaces: TranscriptWorkspace[];
  currentWorkspace: TranscriptWorkspace | null;
  items: TranscriptItem[];
  runs: TranscriptRun[];
  templates: TranscriptTemplate[];
  loading: boolean;
  uploading: boolean;

  fetchWorkspaces: () => Promise<void>;
  selectWorkspace: (id: string) => Promise<void>;
  createWorkspace: (title: string) => Promise<TranscriptWorkspace | null>;
  deleteWorkspace: (id: string) => Promise<void>;
  uploadFile: (file: File) => Promise<void>;
  deleteItem: (itemId: string) => Promise<void>;
  fetchTemplates: () => Promise<void>;
  createCopywrite: (itemId: string, templateId: string) => Promise<TranscriptRun | null>;
  pollRun: (runId: string) => Promise<TranscriptRun | null>;
  deleteRun: (runId: string) => Promise<void>;
  renameItem: (itemId: string, newName: string) => Promise<void>;
  updateSegments: (itemId: string, segments: TranscriptSegment[]) => Promise<void>;
  refreshItems: () => Promise<void>;
}

export const useTranscriptStore = create<TranscriptState>((set, get) => ({
  workspaces: [],
  currentWorkspace: null,
  items: [],
  runs: [],
  templates: [],
  loading: false,
  uploading: false,

  fetchWorkspaces: async () => {
    set({ loading: true });
    const res = await svc.listWorkspaces();
    if (res.success) set({ workspaces: res.data! });
    set({ loading: false });
  },

  selectWorkspace: async (id: string) => {
    set({ loading: true });
    const [wsRes, itemsRes, runsRes] = await Promise.all([
      svc.getWorkspace(id),
      svc.listItems(id),
      svc.listRuns(id),
    ]);
    if (wsRes.success) {
      set({
        currentWorkspace: wsRes.data!,
        items: itemsRes.success ? itemsRes.data! : [],
        runs: runsRes.success ? runsRes.data! : [],
      });
    } else {
      toast.error(wsRes.error?.message ?? '加载失败');
    }
    set({ loading: false });
  },

  createWorkspace: async (title: string) => {
    const res = await svc.createWorkspace(title);
    if (res.success && res.data) {
      set(s => ({ workspaces: [res.data!, ...s.workspaces] }));
      toast.success('工作区已创建');
      return res.data;
    }
    toast.error(res.error?.message ?? '创建失败');
    return null;
  },

  deleteWorkspace: async (id: string) => {
    const res = await svc.deleteWorkspace(id);
    if (res.success) {
      set(s => ({
        workspaces: s.workspaces.filter(w => w.id !== id),
        currentWorkspace: s.currentWorkspace?.id === id ? null : s.currentWorkspace,
        items: s.currentWorkspace?.id === id ? [] : s.items,
      }));
      toast.success('已删除');
    }
  },

  uploadFile: async (file: File) => {
    const ws = get().currentWorkspace;
    if (!ws) return;
    set({ uploading: true });
    toast.success(`正在上传 ${file.name}...`);
    const res = await svc.uploadItem(ws.id, file);
    if (res.success && res.data) {
      set(s => ({ items: [res.data!.item, ...s.items] }));
      toast.success('上传成功，开始转写');
    } else {
      toast.error(res.error?.message ?? '上传失败');
    }
    set({ uploading: false });
  },

  deleteItem: async (itemId: string) => {
    const res = await svc.deleteItem(itemId);
    if (res.success) {
      set(s => ({ items: s.items.filter(i => i.id !== itemId) }));
      toast.success('已删除');
    }
  },

  fetchTemplates: async () => {
    const res = await svc.listTemplates();
    if (res.success) set({ templates: res.data! });
  },

  createCopywrite: async (itemId: string, templateId: string) => {
    const res = await svc.createCopywriteRun(itemId, templateId);
    if (res.success && res.data) {
      set(s => ({ runs: [res.data!, ...s.runs] }));
      return res.data;
    }
    toast.error(res.error?.message ?? '生成失败');
    return null;
  },

  pollRun: async (runId: string) => {
    const res = await svc.getRun(runId);
    if (res.success && res.data) {
      set(s => ({ runs: s.runs.map(r => r.id === runId ? res.data! : r) }));
      return res.data;
    }
    return null;
  },

  deleteRun: async (runId: string) => {
    const res = await svc.deleteRun(runId);
    if (res.success) {
      set(s => ({ runs: s.runs.filter(r => r.id !== runId) }));
    }
  },

  renameItem: async (itemId: string, newName: string) => {
    const res = await svc.renameItem(itemId, newName);
    if (res.success) {
      set(s => ({
        items: s.items.map(i => i.id === itemId ? { ...i, fileName: newName } : i),
      }));
    }
  },

  updateSegments: async (itemId: string, segments: TranscriptSegment[]) => {
    const res = await svc.updateSegments(itemId, segments);
    if (res.success) {
      set(s => ({
        items: s.items.map(i => i.id === itemId ? { ...i, segments } : i),
      }));
    }
  },

  refreshItems: async () => {
    const ws = get().currentWorkspace;
    if (!ws) return;
    const res = await svc.listItems(ws.id);
    if (res.success) set({ items: res.data! });
  },
}));
