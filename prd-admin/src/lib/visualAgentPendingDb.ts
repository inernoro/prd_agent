const DB_NAME = 'prd-admin-visual-agent';
const DB_VERSION = 1;
const STORE_NAME = 'pendingUploads';

type PendingKind = 'blob' | 'url';

export type VisualAgentPendingUpload = {
  id: string; // `${userId}:${workspaceId}:${itemKey}`
  kind: PendingKind;
  blob?: Blob;
  url?: string;
  prompt?: string;
  width?: number;
  height?: number;
  createdAt: number;
  updatedAt: number;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return await new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function makeId(userId: string, workspaceId: string, itemKey: string) {
  return `${(userId || 'anonymous').trim()}:${(workspaceId || '').trim()}:${(itemKey || '').trim()}`;
}

export async function putVisualAgentPendingBlob(args: {
  userId: string;
  workspaceId: string;
  itemKey: string;
  blob: Blob;
  prompt?: string;
  width?: number;
  height?: number;
}): Promise<void> {
  const now = Date.now();
  const rec: VisualAgentPendingUpload = {
    id: makeId(args.userId, args.workspaceId, args.itemKey),
    kind: 'blob',
    blob: args.blob,
    prompt: args.prompt,
    width: args.width,
    height: args.height,
    createdAt: now,
    updatedAt: now,
  };
  await withStore('readwrite', (store) => store.put(rec));
}

export async function putVisualAgentPendingUrl(args: {
  userId: string;
  workspaceId: string;
  itemKey: string;
  url: string;
  prompt?: string;
  width?: number;
  height?: number;
}): Promise<void> {
  const now = Date.now();
  const rec: VisualAgentPendingUpload = {
    id: makeId(args.userId, args.workspaceId, args.itemKey),
    kind: 'url',
    url: args.url,
    prompt: args.prompt,
    width: args.width,
    height: args.height,
    createdAt: now,
    updatedAt: now,
  };
  await withStore('readwrite', (store) => store.put(rec));
}

export async function getVisualAgentPendingUpload(userId: string, workspaceId: string, itemKey: string): Promise<VisualAgentPendingUpload | null> {
  const id = makeId(userId, workspaceId, itemKey);
  const rec = await withStore<VisualAgentPendingUpload | undefined>('readonly', (store) => store.get(id));
  return rec ?? null;
}

export async function deleteVisualAgentPendingUpload(userId: string, workspaceId: string, itemKey: string): Promise<void> {
  const id = makeId(userId, workspaceId, itemKey);
  await withStore('readwrite', (store) => store.delete(id));
}

export async function listVisualAgentPendingUploadsForWorkspace(userId: string, workspaceId: string): Promise<VisualAgentPendingUpload[]> {
  const prefix = `${(userId || 'anonymous').trim()}:${(workspaceId || '').trim()}:`;
  const db = await openDb();
  return await new Promise<VisualAgentPendingUpload[]>((resolve, reject) => {
    const out: VisualAgentPendingUpload[] = [];
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result as IDBCursorWithValue | null;
      if (!cursor) return;
      const v = cursor.value as VisualAgentPendingUpload;
      const id = String((v as any)?.id ?? '');
      if (id.startsWith(prefix)) out.push(v);
      cursor.continue();
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB cursor failed'));
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}
