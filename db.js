// Minimal IndexedDB wrapper for the Petty app.
const DB_NAME = 'pettyDB';
const DB_VERSION = 1;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('days')) {
        db.createObjectStore('days', { keyPath: 'date' });
      }
      if (!db.objectStoreNames.contains('photos')) {
        const store = db.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
        store.createIndex('date', 'date', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(storeName, mode) {
  const db = await openDB();
  return db.transaction(storeName, mode).objectStore(storeName);
}

const DB = {
  async getDay(date) {
    const store = await tx('days', 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.get(date);
      req.onsuccess = () => resolve(req.result || { date, cleanedBy: null, sessions: [] });
      req.onerror = () => reject(req.error);
    });
  },

  async putDay(day) {
    const store = await tx('days', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.put(day);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },

  async getAllDays() {
    const store = await tx('days', 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },

  async addPhoto(date, type, blob) {
    const store = await tx('photos', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.add({ date, type, blob, createdAt: Date.now() });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async getPhotosForDate(date) {
    const store = await tx('photos', 'readonly');
    return new Promise((resolve, reject) => {
      const idx = store.index('date');
      const req = idx.getAll(date);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },

  async deletePhoto(id) {
    const store = await tx('photos', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },

  async getAllPhotos() {
    const store = await tx('photos', 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },
};
