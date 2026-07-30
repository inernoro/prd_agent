/**
 * 录音数据保险箱（IndexedDB，best-effort）——录音期间每个音频分片实时落库，
 * 只有「上传成功」才清除。页面崩溃 / 忘记关闭 / 网络断开 / 标签页被杀，
 * 已录内容都能在下次进入知识库时恢复并继续转录，不丢数据。
 *
 * 结构：
 *   meta   store：{ id, mime, startedAt }        —— 一次录音一条
 *   chunks store：{ key 自增, sessionId, blob }   —— 分片逐条追加（避免整条记录反复重写）
 *
 * 所有 API 静默容错：IndexedDB 不可用（隐私模式等）时录音功能照常，只是没有保险。
 */

const DB_NAME = 'map-recording-vault';
const DB_VERSION = 1;
const META_STORE = 'meta';
const CHUNK_STORE = 'chunks';

export type VaultSessionMeta = {
  id: string;
  mime: string;
  startedAt: number;
  /** 录音发生时所在的知识库（恢复时只在同库提示，避免笔记落错库） */
  storeId?: string;
  /** 服务端已接管完成流程；恢复时必须先查询该会话，禁止直接重传整文件。 */
  serverUploadSessionId?: string;
  /** 汇总信息（listSessions 时计算） */
  bytes: number;
  chunkCount: number;
};

type StoredVaultSessionMeta = Omit<VaultSessionMeta, 'bytes' | 'chunkCount'>;

type VaultServerStatus =
  | { success: true; data: { status: 'uploading' | 'completing' | 'completed' | 'cancelled' } }
  | { success: false; error: { code: string } }
  | null;

type VaultServerCompletion =
  | {
      success: true;
      data?: {
        archivePending?: boolean;
        deferredTranscriptionRunId?: string | null;
      };
    }
  | { success: false; error: { code: string } }
  | null;

export type VaultServerRecoveryDecision = 'completed' | 'keep-protected' | 'recover-local';

/**
 * 已进入服务端完成流程的会话需要重放幂等完成请求。completed 用于取回已落库条目，
 * uploading 覆盖“绑定已持久化、首个完成请求尚未认领”的崩溃窗口，completing
 * 用于在旧完成租约失效后重新领取，completed 用于取回已落库条目。
 */
export function shouldRetryVaultServerCompletion(status: VaultServerStatus): boolean {
  return status?.success === true
    && (status.data.status === 'uploading'
      || status.data.status === 'completing'
      || status.data.status === 'completed');
}

/**
 * 服务端接管后的恢复决策 SSOT。只有服务端明确未持有可恢复结果时才允许整文件重传；
 * 网络未知与瞬时服务错误始终保留本地保险文件和服务端会话绑定。
 */
export function decideVaultServerRecovery(
  status: VaultServerStatus,
  completion: VaultServerCompletion = null,
): VaultServerRecoveryDecision {
  if (!status) return 'keep-protected';
  if (!status.success) {
    return ['NOT_FOUND', 'SESSION_NOT_FOUND', 'SESSION_EXPIRED'].includes(status.error.code)
      ? 'recover-local'
      : 'keep-protected';
  }
  // 完成请求是幂等的：即使调用前读取到的是 completing，成功响应也必须优先收敛终态。
  if (completion?.success && shouldRetryVaultServerCompletion(status)) return 'completed';
  if (status.data.status === 'cancelled') return 'recover-local';
  if (completion?.success === false && [
    'NOT_FOUND',
    'SESSION_NOT_FOUND',
    'SESSION_EXPIRED',
  ].includes(completion.error.code)) {
    return 'recover-local';
  }
  // completed 且条目已被明确删除时，后端以 INVALID_FORMAT 表示该终态不可复用。
  // uploading / completing 的同码可能只是另一完成请求刚刚抢到租约，必须继续保护。
  if (status.data.status === 'completed'
      && completion?.success === false
      && completion.error.code === 'INVALID_FORMAT') {
    return 'recover-local';
  }
  return 'keep-protected';
}

/** 服务端恢复成功后，归档中的延迟转写仍需接回页面现有后台观察器。 */
export function deferredRunIdForRecoveredVaultCompletion(
  completion: VaultServerCompletion,
): string | null {
  if (!completion?.success) return null;
  return completion.data?.deferredTranscriptionRunId?.trim() || null;
}

export type UploadedRecordingFollowUp =
  | { kind: 'watch-deferred-run'; runId: string }
  | { kind: 'wait-for-archive' }
  | { kind: 'open-transcription' };

/**
 * 录音完成响应的后续动作 SSOT。服务端返回固定延迟任务时，该任务已经拥有完整音频
 * 转写责任，不论对象归档是否仍 pending，前端都只能观察它，不能再创建第二个任务。
 */
export function decideUploadedRecordingFollowUp(
  archivePending: boolean,
  liveTranscriptReady: boolean,
  deferredTranscriptionRunId?: string | null,
): UploadedRecordingFollowUp {
  const runId = deferredTranscriptionRunId?.trim();
  if (runId) return { kind: 'watch-deferred-run', runId };
  if (archivePending && !liveTranscriptReady) return { kind: 'wait-for-archive' };
  return { kind: 'open-transcription' };
}

/** 多段保险箱录音可能同时恢复；观察队列必须保留全部任务并对重入去重。 */
export function enqueueBackgroundTranscriptionRun(
  current: string[],
  runId: string,
): string[] {
  const normalized = runId.trim();
  if (!normalized || current.includes(normalized)) return current;
  return [...current, normalized];
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(CHUNK_STORE)) {
          const chunks = db.createObjectStore(CHUNK_STORE, { autoIncrement: true });
          chunks.createIndex('sessionId', 'sessionId', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function txDone(tx: IDBTransaction): Promise<boolean> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

/** 开始一次录音会话：登记 meta。返回是否成功（失败也不影响录音本身）。 */
export async function vaultStartSession(id: string, mime: string, storeId?: string): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  try {
    const tx = db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).put({ id, mime, startedAt: Date.now(), storeId });
    const ok = await txDone(tx);
    db.close();
    return ok;
  } catch {
    db.close();
    return false;
  }
}

/** 录音中切换目标知识库时同步更新保险箱归属，崩溃恢复不会回到旧库。 */
export async function vaultUpdateSessionStore(id: string, storeId: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(META_STORE, 'readwrite');
    const store = tx.objectStore(META_STORE);
    const current = await new Promise<StoredVaultSessionMeta | null>((resolve) => {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
    if (current) store.put({ ...current, storeId });
    await txDone(tx);
  } catch { /* best-effort */ }
  db.close();
}

/**
 * 记录服务端已经接管完成流程。该标记让页面恢复时先查询同一个幂等会话，
 * 避免弱网下把本地保险文件再次上传成第二条录音。
 */
export async function vaultMarkServerCompletion(id: string, serverUploadSessionId: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(META_STORE, 'readwrite');
    const store = tx.objectStore(META_STORE);
    const current = await new Promise<StoredVaultSessionMeta | null>((resolve) => {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
    if (current) store.put({ ...current, serverUploadSessionId });
    await txDone(tx);
  } catch { /* best-effort */ }
  db.close();
}

/** 服务端明确未接管时解除保护，之后才允许走本地整文件恢复。 */
export async function vaultClearServerCompletion(id: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(META_STORE, 'readwrite');
    const store = tx.objectStore(META_STORE);
    const current = await new Promise<StoredVaultSessionMeta | null>((resolve) => {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
    if (current) {
      const next = { ...current };
      delete next.serverUploadSessionId;
      store.put(next);
    }
    await txDone(tx);
  } catch { /* best-effort */ }
  db.close();
}

/** 追加一个音频分片（逐条插入，不重写既有数据） */
export async function vaultAppendChunk(sessionId: string, blob: Blob): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(CHUNK_STORE, 'readwrite');
    tx.objectStore(CHUNK_STORE).add({ sessionId, blob });
    await txDone(tx);
  } catch { /* best-effort */ }
  db.close();
}

/** 列出所有滞留的录音会话（按开始时间倒序） */
export async function vaultListSessions(): Promise<VaultSessionMeta[]> {
  const db = await openDb();
  if (!db) return [];
  try {
    const tx = db.transaction([META_STORE, CHUNK_STORE], 'readonly');
    const metas: StoredVaultSessionMeta[] = await new Promise((resolve) => {
      const req = tx.objectStore(META_STORE).getAll();
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => resolve([]);
    });
    const result: VaultSessionMeta[] = [];
    for (const m of metas) {
      const chunks: { blob: Blob }[] = await new Promise((resolve) => {
        const req = tx.objectStore(CHUNK_STORE).index('sessionId').getAll(m.id);
        req.onsuccess = () => resolve(req.result ?? []);
        req.onerror = () => resolve([]);
      });
      result.push({
        ...m,
        bytes: chunks.reduce((acc, c) => acc + (c.blob?.size ?? 0), 0),
        chunkCount: chunks.length,
      });
    }
    db.close();
    return result.filter(s => s.chunkCount > 0).sort((a, b) => b.startedAt - a.startedAt);
  } catch {
    db.close();
    return [];
  }
}

/** 把某个会话的分片拼回音频 File（供恢复后直接进转录链路） */
export async function vaultLoadSessionFile(id: string): Promise<File | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const tx = db.transaction([META_STORE, CHUNK_STORE], 'readonly');
    const meta: { id: string; mime: string; startedAt: number } | undefined = await new Promise((resolve) => {
      const req = tx.objectStore(META_STORE).get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    });
    // IDB 自增 key 保证 getAll 按插入序返回，分片顺序即录制顺序
    const chunks: { blob: Blob }[] = await new Promise((resolve) => {
      const req = tx.objectStore(CHUNK_STORE).index('sessionId').getAll(id);
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => resolve([]);
    });
    db.close();
    if (!meta || chunks.length === 0) return null;
    const mime = (meta.mime || 'audio/webm').split(';')[0];
    const ext = mime.includes('mp4') ? '.m4a' : mime.includes('ogg') ? '.ogg' : '.webm';
    const d = new Date(meta.startedAt);
    const p = (n: number) => String(n).padStart(2, '0');
    const name = `录音 ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}${ext}`;
    return new File([new Blob(chunks.map(c => c.blob), { type: mime })], name, { type: mime });
  } catch {
    db.close();
    return null;
  }
}

/** 删除会话（上传成功后 / 用户放弃恢复时调用） */
export async function vaultDeleteSession(id: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction([META_STORE, CHUNK_STORE], 'readwrite');
    tx.objectStore(META_STORE).delete(id);
    const idx = tx.objectStore(CHUNK_STORE).index('sessionId');
    const keysReq = idx.getAllKeys(id);
    keysReq.onsuccess = () => {
      for (const key of keysReq.result ?? []) tx.objectStore(CHUNK_STORE).delete(key);
    };
    await txDone(tx);
  } catch { /* best-effort */ }
  db.close();
}
