/* =========================================================
   本地上传的音频存 IndexedDB
   localStorage 只有 5MB 且只能存字符串，装不下整首 mp3，
   所以音频 Blob 走 IndexedDB，元信息仍留在 localStorage。
   ========================================================= */

const DB_NAME = 'spectra-uploads';
const DB_VER = 1;
const STORE = 'audio';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('这个浏览器不支持 IndexedDB'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
    req.onblocked = () => reject(new Error('IndexedDB 被其它标签页占用'));
  });
  return dbPromise;
}

function run(mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        let tx;
        try {
          tx = db.transaction(STORE, mode);
        } catch (e) {
          reject(e);
          return;
        }
        const store = tx.objectStore(STORE);
        let req = null;
        try {
          req = fn(store);
        } catch (e) {
          reject(e);
          return;
        }
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject(tx.error || new Error('IndexedDB 写入失败'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务被中止'));
      })
  );
}

/** 存一首上传的音频 */
export function saveAudio(key, blob, meta = {}) {
  return run('readwrite', (store) =>
    store.put({ key, blob, size: blob.size || 0, at: Date.now(), ...meta })
  );
}

/** 取一首（返回 { key, blob, ... } 或 undefined） */
export function getAudio(key) {
  return run('readonly', (store) => store.get(key));
}

export function deleteAudio(key) {
  return run('readwrite', (store) => store.delete(key));
}

export function listAudio() {
  return run('readonly', (store) => store.getAll());
}

/** 清掉不在 keep 列表里的音频（用于清理孤儿数据） */
export async function pruneAudio(keepKeys) {
  const all = await listAudio();
  const keep = new Set(keepKeys);
  const dead = all.filter((r) => !keep.has(r.key)).map((r) => r.key);
  for (const k of dead) {
    try {
      await deleteAudio(k);
    } catch {
      /* 忽略 */
    }
  }
  return dead.length;
}

/** 已用空间（字节） */
export async function usedBytes() {
  try {
    const all = await listAudio();
    return all.reduce((s, r) => s + (r.size || (r.blob && r.blob.size) || 0), 0);
  } catch {
    return 0;
  }
}
