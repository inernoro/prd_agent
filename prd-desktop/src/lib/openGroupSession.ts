/**
 * 统一的打开群组会话逻辑（单一数据源）。
 *
 * 所有需要打开群组会话的地方（GroupList、Sidebar、App deep link）
 * 必须调用此函数，禁止各自维护重复逻辑。
 */
import { invoke } from './tauri';
import type { ApiResponse, Document, DocumentMeta, Session, UserRole } from '../types';
import { useSessionStore } from '../stores/sessionStore';

export interface OpenGroupSessionResult {
  session: Session;
  primaryDoc: Document;
  allDocs: Document[];
}

/**
 * 打开群组会话并获取所有关联文档。
 * 返回 null 表示打开失败（接口失败或文档不存在）。
 */
export async function openGroupSession(
  groupId: string,
  userRole: UserRole,
): Promise<OpenGroupSessionResult | null> {
  const openResp = await invoke<ApiResponse<{
    sessionId: string;
    groupId: string;
    documentId: string;
    documentIds?: string[];
    documentMetas?: DocumentMeta[];
    currentRole: string;
  }>>('open_group_session', { groupId, userRole });

  if (!openResp.success || !openResp.data) return null;

  const docResp = await invoke<ApiResponse<Document>>('get_document', {
    documentId: openResp.data.documentId,
  });
  if (!docResp.success || !docResp.data) return null;

  // 获取所有文档元信息（多文档支持）
  const allDocIds = openResp.data.documentIds ?? [openResp.data.documentId];
  const metas = openResp.data.documentMetas ?? [];
  const metaMap = new Map(metas.map(m => [m.documentId, m.documentType]));
  // 主文档带上类型
  docResp.data.documentType = metaMap.get(docResp.data.id) ?? 'product';
  const allDocs: Document[] = [docResp.data];
  for (const did of allDocIds) {
    if (did === openResp.data.documentId) continue; // 主文档已获取
    try {
      const r = await invoke<ApiResponse<Document>>('get_document', { documentId: did });
      if (r.success && r.data) {
        r.data.documentType = metaMap.get(did) ?? 'reference';
        allDocs.push(r.data);
      }
    } catch { /* skip */ }
  }

  const session: Session = {
    sessionId: openResp.data.sessionId,
    groupId: openResp.data.groupId,
    documentId: openResp.data.documentId,
    documentIds: allDocIds,
    currentRole: (openResp.data.currentRole as UserRole) || userRole,
    mode: 'QA',
  };

  return { session, primaryDoc: docResp.data, allDocs };
}

/**
 * 打开群组会话并直接写入 sessionStore。
 * 封装了 openGroupSession + setSession 的完整流程。
 */
export async function openGroupSessionAndSetStore(
  groupId: string,
  userRole: UserRole,
): Promise<boolean> {
  const result = await openGroupSession(groupId, userRole);
  if (!result) return false;
  useSessionStore.getState().setSession(result.session, result.primaryDoc, result.allDocs);
  return true;
}
