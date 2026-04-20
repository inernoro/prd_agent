import { useCallback, useState } from 'react';
import { invoke } from '../lib/tauri';
import { useSessionStore } from '../stores/sessionStore';
import type { ApiResponse, Document } from '../types';

interface UploadSessionResponse {
  sessionId: string;
  documentId: string;
  documentIds: string[];
  documentMetas?: Array<{ documentId: string; documentType: string }>;
}

interface RemoveSessionResponse {
  documentIds: string[];
  documentMetas?: Array<{ documentId: string; documentType: string }>;
}

async function refreshDocuments(
  documentIds: string[],
  metas: Array<{ documentId: string; documentType: string }> | undefined,
): Promise<Document[]> {
  const metaMap = new Map((metas ?? []).map((m) => [m.documentId, m.documentType]));
  const out: Document[] = [];
  for (const did of documentIds) {
    const r = await invoke<ApiResponse<Document>>('get_document', { documentId: did });
    if (r.success && r.data) {
      r.data.documentType = (metaMap.get(did) ?? r.data.documentType) as Document['documentType'];
      out.push(r.data);
    }
  }
  return out;
}

export interface UseDocumentActionsResult {
  /** 正在执行文档类动作（上传/删除等），可用于禁用相关按钮 */
  busy: boolean;
  /** 最近一次错误，供上层显示 */
  error: string;
  /** 清空错误 */
  clearError: () => void;
  /**
   * 替换文件：走 Tauri 文件选择器，upload_file_to_session 追加 → 若新文件内容 hash 与旧不同则 remove 旧
   * @returns 替换是否完成（用户取消返回 false）
   */
  replaceDocumentFile: (args: { docId: string; documentType?: string }) => Promise<boolean>;
  /** 从会话删除一份资料文档；不会动主文档（调用方自行判断） */
  removeDocument: (docId: string) => Promise<boolean>;
}

/**
 * 文档动作的共享实现：原来 Sidebar 与 KnowledgeBasePage 各有一份几乎一样的逻辑，
 * Bugbot 指出易分叉（如 `filter(id => id !== docId)` 的边界 bug 两份都踩了），故抽出。
 */
export function useDocumentActions(): UseDocumentActionsResult {
  const { sessionId, setDocuments } = useSessionStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const replaceDocumentFile = useCallback(async ({ docId, documentType }: { docId: string; documentType?: string }) => {
    if (!sessionId) return false;
    let done = false;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ multiple: false, title: '选择替换后的文件' });
      if (!selected || Array.isArray(selected)) return false;
      setBusy(true);
      setError('');
      const up = await invoke<ApiResponse<UploadSessionResponse>>('upload_file_to_session', {
        sessionId,
        filePath: selected,
        documentType: documentType || null,
      });
      if (!up.success || !up.data) {
        setError(up.error?.message || '替换失败');
        return false;
      }
      // 仅当新旧 documentId 不同（即内容 hash 不同）时，才需要删除旧文件
      const newDocId = up.data.documentId;
      const sameContent = !newDocId || newDocId === docId;
      // 以服务端权威响应为最终列表；内容相同则直接用 upload 的返回
      let finalIds = up.data.documentIds || [];
      let finalMetas = up.data.documentMetas;
      if (!sameContent) {
        const rm = await invoke<ApiResponse<RemoveSessionResponse>>('remove_document_from_session', {
          sessionId,
          documentId: docId,
        });
        if (!rm.success || !rm.data) {
          setError(rm.error?.message || '替换失败：旧文件移除失败');
          return false;
        }
        finalIds = rm.data.documentIds || [];
        finalMetas = rm.data.documentMetas;
      }
      const fresh = await refreshDocuments(finalIds, finalMetas);
      if (fresh.length > 0) setDocuments(fresh);
      done = true;
    } catch (err) {
      setError('替换失败：' + String(err));
    } finally {
      setBusy(false);
    }
    return done;
  }, [sessionId, setDocuments]);

  const removeDocument = useCallback(async (docId: string) => {
    if (!sessionId) return false;
    try {
      setBusy(true);
      setError('');
      const resp = await invoke<ApiResponse<RemoveSessionResponse>>('remove_document_from_session', {
        sessionId,
        documentId: docId,
      });
      if (!resp.success || !resp.data) {
        setError(resp.error?.message || '删除失败');
        return false;
      }
      const fresh = await refreshDocuments(resp.data.documentIds, resp.data.documentMetas);
      setDocuments(fresh);
      return true;
    } catch (err) {
      setError('删除失败：' + String(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, [sessionId, setDocuments]);

  return {
    busy,
    error,
    clearError: () => setError(''),
    replaceDocumentFile,
    removeDocument,
  };
}
