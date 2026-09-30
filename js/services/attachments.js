/* =========================================================
   attachments.js — документы анализов (PDF / фото), только на устройстве.
   • Файл хранится в IndexedDB (база lexlife-files, хранилище attachments),
     не в localStorage и не в сети.
   • В записи health_tests — только метаданные:
       attachments: [{ attachmentId, name, type, size, addedAt }]
   • Тип файла определяется по сигнатуре содержимого (не по имени).
   • Хранилище файлов подменяемое: IdbAttachmentStore (браузер) /
     MemoryAttachmentStore (тесты node, песочницы).
   ========================================================= */

export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
export const ATTACHMENT_TYPES = {
  'application/pdf': { label: 'PDF', ext: 'pdf', kind: 'pdf' },
  'image/jpeg': { label: 'JPEG', ext: 'jpg', kind: 'image' },
  'image/png': { label: 'PNG', ext: 'png', kind: 'image' },
  'image/heic': { label: 'HEIC', ext: 'heic', kind: 'image' },
  'image/heif': { label: 'HEIF', ext: 'heif', kind: 'image' },
};
/* Для <input type="file" accept>: iOS «Файлы» и «Фото» */
export const ATTACHMENT_ACCEPT = '.pdf,.jpg,.jpeg,.png,.heic,.heif,application/pdf,image/jpeg,image/png,image/heic,image/heif';
/* Не старше этого возраста «висячие» файлы не удаляются: вложение могло только что
   записаться в другой вкладке, а ссылка на него в анализе — ещё нет. */
export const ORPHAN_GRACE_MS = 10 * 60 * 1000;

export class AttachmentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AttachmentError';
    this.code = code;
  }
}

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'heif']);

/* Тип по первым байтам файла → MIME из ATTACHMENT_TYPES | null */
export function sniffBytes(b) {
  if (!b || b.length < 4) return null;
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf'; // %PDF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 12 && String.fromCharCode(b[4], b[5], b[6], b[7]) === 'ftyp') {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (HEIF_BRANDS.has(brand)) return brand === 'mif1' || brand === 'msf1' || brand === 'heif' ? 'image/heif' : 'image/heic';
  }
  return null;
}
export async function sniffType(blob) {
  return sniffBytes(new Uint8Array(await blob.slice(0, 16).arrayBuffer()));
}

/* Имя файла для показа/хранения: без путей и управляющих символов, до 200 символов */
export function cleanFileName(name, type) {
  let n = String(name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!n) n = `document.${(ATTACHMENT_TYPES[type] || {}).ext || 'bin'}`;
  return n.length > 200 ? n.slice(0, 200) : n;
}

/* Размер для людей: 820 КБ · 1,4 МБ */
export function formatBytes(n) {
  if (!(n >= 0)) return '';
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} КБ`;
  return `${(n / 1024 / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ`;
}

/* Проверка выбранного файла → { ok: true, type } | { ok: false, code, message } */
export async function checkAttachmentFile(file) {
  if (!file || typeof file.size !== 'number') return { ok: false, code: 'NO_FILE', message: 'Файл не выбран.' };
  if (file.size === 0) return { ok: false, code: 'EMPTY', message: 'Файл пустой.' };
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return { ok: false, code: 'TOO_LARGE', message: `Файл слишком большой (${formatBytes(file.size)}). Можно прикрепить документ до 15 МБ.` };
  }
  let type = null;
  try { type = await sniffType(file); } catch { /* не читается */ }
  if (!type) {
    return { ok: false, code: 'UNSUPPORTED', message: 'Этот тип файла не поддерживается. Прикрепите PDF или фото в формате JPG, PNG или HEIC.' };
  }
  return { ok: true, type };
}

/* ---------------- Хранилища файлов ----------------
   Единый интерфейс: put(record), get(id) → record|null, delete(id), keys() → [id]
   record: { id, testId, name, type, size, addedAt, data: ArrayBuffer } */

export class MemoryAttachmentStore {
  constructor() { this.map = new Map(); }
  async put(rec) { this.map.set(rec.id, { ...rec, data: rec.data.slice(0) }); }
  async get(id) { const r = this.map.get(id); return r ? { ...r, data: r.data.slice(0) } : null; }
  async delete(id) { this.map.delete(id); }
  async keys() { return [...this.map.keys()]; }
  async list() { return [...this.map.values()].map(({ data, ...meta }) => meta); }
}

const DB_NAME = 'lexlife-files';
const DB_VERSION = 1;
const STORE = 'attachments';

/* IndexedDB: данные храним как ArrayBuffer (надёжнее Blob в старых WebKit) */
export class IdbAttachmentStore {
  constructor(dbName = DB_NAME) {
    this.dbName = dbName;
    this._db = null;
  }
  static available() {
    try { return typeof indexedDB !== 'undefined' && indexedDB !== null; } catch { return false; }
  }
  _open() {
    if (this._db) return this._db;
    this._db = new Promise((resolve, reject) => {
      if (!IdbAttachmentStore.available()) {
        reject(new AttachmentError('NO_IDB', 'Хранилище документов недоступно в этом браузере (например, в приватном режиме).'));
        return;
      }
      const req = indexedDB.open(this.dbName, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); this._db = null; };
        resolve(db);
      };
      req.onerror = () => reject(new AttachmentError('NO_IDB', 'Не удалось открыть хранилище документов.'));
      req.onblocked = () => reject(new AttachmentError('NO_IDB', 'Хранилище документов занято другой вкладкой LexLife. Закройте её и повторите.'));
    });
    this._db.catch(() => { this._db = null; });
    return this._db;
  }
  async _tx(mode, fn) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      let result;
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      const req = fn(store);
      if (req) req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => {
        const err = tx.error || (req && req.error);
        reject(err && err.name === 'QuotaExceededError'
          ? new AttachmentError('NO_SPACE', 'Недостаточно места на устройстве для документа.')
          : new AttachmentError('IDB_FAILED', 'Не удалось записать или прочитать документ на устройстве.'));
      };
    });
  }
  async put(rec) { await this._tx('readwrite', (s) => s.put(rec)); }
  async get(id) { return (await this._tx('readonly', (s) => s.get(id))) || null; }
  async delete(id) { await this._tx('readwrite', (s) => s.delete(id)); }
  async keys() { return (await this._tx('readonly', (s) => s.getAllKeys())) || []; }
  /* Метаданные без содержимого (для очистки) — курсор, чтобы не читать все файлы в память */
  async list() {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const out = [];
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        const { data, ...meta } = c.value;
        out.push(meta);
        c.continue();
      };
      tx.oncomplete = () => resolve(out);
      tx.onerror = tx.onabort = () => reject(new AttachmentError('IDB_FAILED', 'Не удалось прочитать хранилище документов.'));
    });
  }
}

/* ---------------- Сервис вложений ---------------- */

const newAttachmentId = () => `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
export const attachmentOf = (test) => (test && Array.isArray(test.attachments) ? test.attachments.find((a) => a && a.attachmentId) : null) || null;
const idsOf = (test) => (test && Array.isArray(test.attachments) ? test.attachments.map((a) => a && a.attachmentId).filter(Boolean) : []);

export class AttachmentService {
  constructor(storage, store) {
    this.storage = storage;
    this.store = store;
  }

  /* Прикрепить файл к анализу (заменяет прежний документ). Порядок: файл → ссылка в
     анализе → удаление старого файла; при ошибке записи ссылки новый файл удаляется. */
  async attachToTest(testId, file, { now = new Date() } = {}) {
    const check = await checkAttachmentFile(file);
    if (!check.ok) throw new AttachmentError(check.code, check.message);
    const test = await this.storage.getTest(testId);
    if (!test) throw new AttachmentError('NO_TEST', 'Анализ не найден.');
    const data = await file.arrayBuffer();
    const meta = {
      attachmentId: newAttachmentId(),
      name: cleanFileName(file.name, check.type),
      type: check.type,
      size: data.byteLength,
      addedAt: now.toISOString(),
    };
    await this.store.put({ id: meta.attachmentId, testId, name: meta.name, type: meta.type, size: meta.size, addedAt: meta.addedAt, data });
    let updated;
    try {
      updated = await this.storage.updateTest(testId, { attachments: [meta] });
    } catch (err) {
      await this.store.delete(meta.attachmentId).catch(() => {});
      throw err;
    }
    if (!updated) {
      await this.store.delete(meta.attachmentId).catch(() => {});
      throw new AttachmentError('NO_TEST', 'Анализ не найден.');
    }
    for (const old of idsOf(test)) if (old !== meta.attachmentId) await this.store.delete(old).catch(() => {});
    this._persist();
    return meta;
  }

  /* Удалить только документ: анализ остаётся. → true, если документ был */
  async removeFromTest(testId) {
    const test = await this.storage.getTest(testId);
    if (!test) return false;
    const ids = idsOf(test);
    if (!ids.length) return false;
    await this.storage.updateTest(testId, { attachments: [] });
    for (const id of ids) await this.store.delete(id).catch(() => {});
    return true;
  }

  /* Удалить анализ вместе с его документом → удалённая запись | null */
  async deleteTest(testId) {
    const removed = await this.storage.removeTest(testId);
    if (!removed) return null;
    for (const id of idsOf(removed)) await this.store.delete(id).catch(() => {});
    return removed;
  }

  /* Файл документа → File | null (нет на этом устройстве) */
  async getFile(meta) {
    if (!meta || !meta.attachmentId) return null;
    const rec = await this.store.get(meta.attachmentId);
    if (!rec || !rec.data) return null;
    const type = ATTACHMENT_TYPES[rec.type] ? rec.type : meta.type;
    return new File([rec.data], meta.name || rec.name || 'document', { type: ATTACHMENT_TYPES[type] ? type : 'application/octet-stream' });
  }

  /* Идентификаторы документов, на которые ссылаются анализы */
  static referencedIds(tests) {
    const set = new Set();
    (tests || []).forEach((t) => idsOf(t).forEach((id) => set.add(id)));
    return set;
  }

  /* Очистка «висячих» файлов (ни один анализ на них не ссылается). Безопасно:
     анализы читаются строго (повреждены/нет/идёт восстановление → ничего не удаляется),
     свежие файлы (моложе graceMs) не трогаются. → { removed, skipped } */
  async cleanupOrphans({ now = new Date(), graceMs = ORPHAN_GRACE_MS } = {}) {
    const tests = await this.storage.readTestsStrict();
    if (!tests) return { removed: 0, skipped: true };
    const keep = AttachmentService.referencedIds(tests);
    const records = await this.store.list();
    let removed = 0;
    for (const r of records) {
      if (keep.has(r.id)) continue;
      const age = now - Date.parse(r.addedAt || '');
      if (graceMs > 0 && !(age >= graceMs)) continue; // свежий или без даты — не трогаем
      await this.store.delete(r.id);
      removed += 1;
    }
    return { removed, skipped: false };
  }

  /* Попросить браузер не вытеснять данные сайта (iOS/Safari — по возможности) */
  _persist() {
    try {
      if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    } catch { /* не критично */ }
  }
}
