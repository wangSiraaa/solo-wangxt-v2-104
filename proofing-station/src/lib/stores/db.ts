/**
 * IndexedDB 持久化：全部数据仅存于本机浏览器，无任何网络上传。
 *
 * 三个对象仓库：
 *  - profiles  ICC 配置（内置库 / 图像嵌入 / 用户导入），含摘要与 sha256
 *  - projects  工程元数据（设置、来源假设、图像信息）
 *  - blobs     大体积像素与原始文件字节（Uint8Array），按 key 存取
 */
import type { IccProfile, ProjectRecord } from '../color/types';

const DB_NAME = 'soft-proofing-station';
const DB_VERSION = 1;
const STORE_PROFILES = 'profiles';
const STORE_PROJECTS = 'projects';
const STORE_BLOBS = 'blobs';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PROFILES)) {
        const s = db.createObjectStore(STORE_PROFILES, { keyPath: 'id' });
        s.createIndex('sha256', 'sha256', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

// —— 配置 ——

export async function putProfile(profile: IccProfile): Promise<void> {
  // IndexedDB 结构化克隆可直接存 Uint8Array
  await tx(STORE_PROFILES, 'readwrite', (s) => s.put(profile));
}

export async function getProfile(id: string): Promise<IccProfile | undefined> {
  return tx(STORE_PROFILES, 'readonly', (s) => s.get(id));
}

export async function getAllProfiles(): Promise<IccProfile[]> {
  return tx(STORE_PROFILES, 'readonly', (s) => s.getAll());
}

export async function deleteProfile(id: string): Promise<void> {
  await tx(STORE_PROFILES, 'readwrite', (s) => s.delete(id));
}

export async function findProfileBySha(sha: string): Promise<IccProfile | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_PROFILES, 'readonly');
    const idx = t.objectStore(STORE_PROFILES).index('sha256');
    const req = idx.get(sha);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// —— 工程 ——

export async function putProject(project: ProjectRecord): Promise<void> {
  await tx(STORE_PROJECTS, 'readwrite', (s) => s.put(project));
}

export async function getAllProjects(): Promise<ProjectRecord[]> {
  return tx(STORE_PROJECTS, 'readonly', (s) => s.getAll());
}

export async function deleteProject(id: string): Promise<void> {
  await tx(STORE_PROJECTS, 'readwrite', (s) => s.delete(id));
}

// —— 大二进制 ——

export async function putBlob(key: string, data: Uint8Array | Uint8ClampedArray): Promise<void> {
  await tx(STORE_BLOBS, 'readwrite', (s) => s.put(data, key));
}

export async function getBlob(key: string): Promise<Uint8Array | undefined> {
  return tx(STORE_BLOBS, 'readonly', (s) => s.get(key));
}

export async function deleteBlob(key: string): Promise<void> {
  await tx(STORE_BLOBS, 'readwrite', (s) => s.delete(key));
}
