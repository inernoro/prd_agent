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
  /** 汇总信息（listSessions 时计算） */
  bytes: number;
  chunkCount: number;
};

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
    const metas: { id: string; mime: string; startedAt: number; storeId?: string }[] = await new Promise((resolve) => {
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
