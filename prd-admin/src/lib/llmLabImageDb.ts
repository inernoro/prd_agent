const DB_NAME = 'prd-admin-llm-lab';
const DB_VERSION = 1;
const STORE_NAME = 'images';

type ImageRecord = {
  id: string; // `${userId}:${itemKey}`
  blob: Blob;
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

function makeId(userId: string, itemKey: string) {
  return `${(userId || 'anonymous').trim()}:${(itemKey || '').trim()}`;
}

export async function putLlmLabImageBlob(userId: string, itemKey: string, blob: Blob): Promise<void> {
  const rec: ImageRecord = { id: makeId(userId, itemKey), blob, updatedAt: Date.now() };
  await withStore('readwrite', (store) => store.put(rec));
}

export async function getLlmLabImageBlob(userId: string, itemKey: string): Promise<Blob | null> {
  const id = makeId(userId, itemKey);
  const rec = await withStore<ImageRecord | undefined>('readonly', (store) => store.get(id));
  if (!rec) return null;
  return rec.blob ?? null;
}

export async function deleteLlmLabImageBlob(userId: string, itemKey: string): Promise<void> {
  const id = makeId(userId, itemKey);
  await withStore('readwrite', (store) => store.delete(id));
}

export async function clearLlmLabImagesForUser(userId: string): Promise<void> {
  const prefix = `${(userId || 'anonymous').trim()}:`;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result as IDBCursorWithValue | null;
      if (!cursor) return;
      const id = String((cursor.value as any)?.id ?? '');
      if (id.startsWith(prefix)) {
        cursor.delete();
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB cursor failed'));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}


