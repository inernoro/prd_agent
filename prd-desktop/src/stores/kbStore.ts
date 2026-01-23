import { create } from 'zustand';
import { invoke } from '../lib/tauri';
import type { ApiResponse, KbDocument } from '../types';

interface KbFileInput {
  fileName: string;
  content: number[];
  mimeType: string;
}

interface KbState {
  documents: KbDocument[];
  loading: boolean;
  error: string | null;

  loadDocuments: (groupId: string) => Promise<void>;
  uploadDocuments: (groupId: string, files: File[]) => Promise<boolean>;
  replaceDocument: (groupId: string, documentId: string, file: File) => Promise<boolean>;
  deleteDocument: (groupId: string, documentId: string) => Promise<boolean>;
  clear: () => void;
}

export const useKbStore = create<KbState>()((set) => ({
  documents: [],
  loading: false,
  error: null,

  loadDocuments: async (groupId: string) => {
    set({ loading: true, error: null });
    try {
      const resp = await invoke<ApiResponse<KbDocument[]>>('list_kb_documents', { groupId });
      if (resp.success && resp.data) {
        set({ documents: resp.data, loading: false });
      } else {
        set({ documents: [], loading: false, error: resp.error?.message || '加载失败' });
      }
    } catch (err) {
      set({ documents: [], loading: false, error: String(err) });
    }
  },

  uploadDocuments: async (groupId: string, files: File[]) => {
    set({ loading: true, error: null });
    try {
      const fileInputs: KbFileInput[] = [];
      for (const file of files) {
        const buffer = await file.arrayBuffer();
        fileInputs.push({
          fileName: file.name,
          content: Array.from(new Uint8Array(buffer)),
          mimeType: file.type || getMimeType(file.name),
        });
      }

      const resp = await invoke<ApiResponse<KbDocument[]>>('upload_kb_documents', {
        groupId,
        files: fileInputs,
      });

      if (resp.success && resp.data) {
        set((state) => ({
          documents: [...state.documents, ...resp.data!],
          loading: false,
        }));
        return true;
      } else {
        set({ loading: false, error: resp.error?.message || '上传失败' });
        return false;
      }
    } catch (err) {
      set({ loading: false, error: String(err) });
      return false;
    }
  },

  replaceDocument: async (groupId: string, documentId: string, file: File) => {
    set({ loading: true, error: null });
    try {
      const buffer = await file.arrayBuffer();
      const fileInput: KbFileInput = {
        fileName: file.name,
        content: Array.from(new Uint8Array(buffer)),
        mimeType: file.type || getMimeType(file.name),
      };

      const resp = await invoke<ApiResponse<KbDocument>>('replace_kb_document', {
        groupId,
        documentId,
        file: fileInput,
      });

      if (resp.success && resp.data) {
        set((state) => ({
          documents: state.documents.map((d) =>
            d.documentId === documentId ? resp.data! : d
          ),
          loading: false,
        }));
        return true;
      } else {
        set({ loading: false, error: resp.error?.message || '替换失败' });
        return false;
      }
    } catch (err) {
      set({ loading: false, error: String(err) });
      return false;
    }
  },

  deleteDocument: async (groupId: string, documentId: string) => {
    set({ loading: true, error: null });
    try {
      const resp = await invoke<ApiResponse<unknown>>('delete_kb_document', {
        groupId,
        documentId,
      });

      if (resp.success) {
        set((state) => ({
          documents: state.documents.filter((d) => d.documentId !== documentId),
          loading: false,
        }));
        return true;
      } else {
        set({ loading: false, error: resp.error?.message || '删除失败' });
        return false;
      }
    } catch (err) {
      set({ loading: false, error: String(err) });
      return false;
    }
  },

  clear: () => set({ documents: [], loading: false, error: null }),
}));

function getMimeType(fileName: string): string {
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'md') return 'text/markdown';
  return 'application/octet-stream';
}
