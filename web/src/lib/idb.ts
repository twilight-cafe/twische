/**
 * IndexedDB 的最小封装。
 *
 * 为什么不用 localStorage：日程记录会长期增长，localStorage 的 5MB 上限
 * 迟早会被撞到，而且它是同步 API，写入时会卡住主线程。
 * 为什么不用 idb 之类的库：需求只有"读写两张表"，自己写 60 行比多一个依赖划算。
 *
 * 注意：写入前一律经 toPlain 深拷贝。IndexedDB 只能接受可结构化克隆的数据，
 * 而 Vue 的响应式代理不可克隆 —— 直接 put 会抛 DataCloneError。详见 lib/plain.ts。
 */
import { toPlain } from './plain';

const DB_NAME = 'twische';
const DB_VERSION = 1;

export const STORE_RECORDS = 'records';
export const STORE_META = 'meta';

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_RECORDS)) {
        const store = db.createObjectStore(STORE_RECORDS, { keyPath: 'id' });
        // 索引用于按类型/脏标记扫描，避免每次同步都全量遍历
        store.createIndex('by_kind', 'kind', { unique: false });
        store.createIndex('by_dirty', 'dirty', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
    req.onblocked = () => reject(new Error('IndexedDB 被其它标签页阻塞，请关闭其它 Twische 页面'));
  });

  // 打开失败时不要缓存失败的 promise，否则后续调用永远拿到同一个错误
  dbPromise.catch(() => {
    dbPromise = null;
  });

  return dbPromise;
}

function tx<T>(storeName: string, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        const req = fn(t.objectStore(storeName));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.onabort = () => reject(t.error || new Error('事务被中止'));
      }),
  );
}

export function getAll<T>(storeName: string): Promise<T[]> {
  return tx<T[]>(storeName, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
}

export function getOne<T>(storeName: string, key: string): Promise<T | undefined> {
  return tx<T | undefined>(storeName, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
}

/** 批量写入。用一个事务包住，避免逐条提交造成大量小事务。 */
export function putMany(storeName: string, items: unknown[]): Promise<void> {
  if (items.length === 0) return Promise.resolve();
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const t = db.transaction(storeName, 'readwrite');
        const store = t.objectStore(storeName);
        for (const item of items) store.put(toPlain(item));
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('事务被中止'));
      }),
  );
}

export function deleteMany(storeName: string, keys: string[]): Promise<void> {
  if (keys.length === 0) return Promise.resolve();
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const t = db.transaction(storeName, 'readwrite');
        const store = t.objectStore(storeName);
        for (const k of keys) store.delete(k);
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('事务被中止'));
      }),
  );
}

export async function clearAll(): Promise<void> {
  await deleteMany(STORE_RECORDS, (await getAll<{ id: string }>(STORE_RECORDS)).map((r) => r.id));
  const metas = await getAll<{ key: string }>(STORE_META);
  await deleteMany(STORE_META, metas.map((m) => m.key));
}
