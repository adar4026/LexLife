/* =========================================================
   fullBackup.js — «Полная резервная копия с документами» (ZIP).
   Формат (подробно — docs/FULL_BACKUP.md):
     lexlife-full-backup.json   манифест: версия формата, список документов
     backup.json                обычная резервная копия LexLife (тот же JSON, что
                                «Создать резервную копию» — его можно извлечь из
                                архива и восстановить даже старой версией LexLife)
     attachments/<id>.<ext>     сами PDF / фото без изменений
   Архив без сжатия (STORE), см. services/zip.js. Ничего не отправляется в сеть.
   ========================================================= */

import { parseBackup, backupFileName, BackupError } from './storage.js';
import { createZip, readZip, ZipError } from './zip.js';
import { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES, AttachmentService, sniffBytes, cleanFileName } from './attachments.js';

export const FULL_BACKUP_KIND = 'lexlife-full-backup';
export const FULL_BACKUP_FORMAT_VERSION = 1;
const MANIFEST = 'lexlife-full-backup.json';
const BACKUP_JSON = 'backup.json';
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

/* LexLife-full-backup-ГГГГ-ММ-ДД-ЧЧММ.zip */
export function fullBackupFileName(date = new Date()) {
  return backupFileName(date).replace('LexLife-backup-', 'LexLife-full-backup-').replace(/\.json$/, '.zip');
}

/* ZIP ли это (по сигнатуре PK\x03\x04 или пустой архив PK\x05\x06) */
export async function isZipFile(file) {
  const b = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return b.length === 4 && b[0] === 0x50 && b[1] === 0x4b && ((b[2] === 3 && b[3] === 4) || (b[2] === 5 && b[3] === 6));
}

/* Создать полную копию → { blob, fileName, createdAt, attachments, missing, verified } */
export async function createFullBackup(storage, store) {
  const backup = await storage.exportBackup();
  const json = JSON.stringify(backup, null, 2);
  const tests = Array.isArray(backup.data[storage.KEYS.tests]) ? backup.data[storage.KEYS.tests] : [];
  const enc = new TextEncoder();
  const files = [];
  const list = [];
  let missing = 0;
  for (const t of tests) {
    for (const a of Array.isArray(t.attachments) ? t.attachments : []) {
      if (!a || !a.attachmentId || !SAFE_ID.test(a.attachmentId)) continue;
      const rec = await store.get(a.attachmentId);
      const type = rec && ATTACHMENT_TYPES[rec.type] ? rec.type : null;
      if (!rec || !rec.data || !type) { missing += 1; continue; }
      const file = `attachments/${a.attachmentId}.${ATTACHMENT_TYPES[type].ext}`;
      files.push({ name: file, data: new Uint8Array(rec.data) });
      list.push({ attachmentId: a.attachmentId, testId: t.id ?? null, name: a.name || rec.name || '', type, size: rec.data.byteLength, addedAt: a.addedAt || rec.addedAt || null, file });
    }
  }
  const manifest = {
    app: 'lexlife',
    kind: FULL_BACKUP_KIND,
    fullBackupFormatVersion: FULL_BACKUP_FORMAT_VERSION,
    createdAt: backup.createdAt,
    appVersion: backup.appVersion,
    backup: BACKUP_JSON,
    attachments: list,
  };
  const blob = createZip([
    { name: MANIFEST, data: enc.encode(JSON.stringify(manifest, null, 2)) },
    { name: BACKUP_JSON, data: enc.encode(json) },
    ...files,
  ], { date: new Date(backup.createdAt) });

  /* самопроверка: архив читается, копия данных проходит подготовку к восстановлению */
  let verified = true;
  try {
    const check = await prepareFullRestore(storage, blob);
    if (check.attachments.length !== list.length) verified = false;
  } catch { verified = false; }
  return { blob, fileName: fullBackupFileName(new Date(backup.createdAt)), createdAt: backup.createdAt, attachments: list.length, missing, bytes: blob.size, verified };
}

/* Проверка полной копии БЕЗ записи: архив, манифест, данные (через prepareRestore
   с миграциями в песочнице), список документов. → { prepared, attachments, zip, info } */
export async function prepareFullRestore(storage, file) {
  let zip;
  try {
    zip = await readZip(file);
  } catch (err) {
    throw new BackupError('CORRUPT', err instanceof ZipError ? err.message : 'Не удалось прочитать архив резервной копии.');
  }
  if (!zip.has(MANIFEST) || !zip.has(BACKUP_JSON)) throw new BackupError('NOT_LEXLIFE', 'Этот архив не является полной резервной копией LexLife.');

  let manifest;
  try {
    if (zip.size(MANIFEST) > 5 * 1024 * 1024) throw new Error('big');
    manifest = JSON.parse(await zip.readText(MANIFEST));
  } catch (err) {
    throw new BackupError('CORRUPT', err instanceof ZipError ? err.message : 'Полная резервная копия повреждена: не читается описание архива.');
  }
  if (!manifest || typeof manifest !== 'object' || manifest.app !== 'lexlife' || manifest.kind !== FULL_BACKUP_KIND) {
    throw new BackupError('NOT_LEXLIFE', 'Этот архив не является полной резервной копией LexLife.');
  }
  const ver = manifest.fullBackupFormatVersion;
  if (!Number.isInteger(ver) || ver < 1) throw new BackupError('UNSUPPORTED', 'Неизвестный формат полной резервной копии.');
  if (ver > FULL_BACKUP_FORMAT_VERSION) throw new BackupError('NEWER_VERSION', 'Эта резервная копия создана более новой версией LexLife. Обновите приложение перед восстановлением.');

  let text;
  try { text = await zip.readText(BACKUP_JSON); } catch (err) {
    throw new BackupError('CORRUPT', err instanceof ZipError ? err.message : 'Полная резервная копия повреждена.');
  }
  const prepared = await storage.prepareRestore(parseBackup(text));

  const raw = Array.isArray(manifest.attachments) ? manifest.attachments : null;
  if (!raw || raw.length > 5000) throw new BackupError('CORRUPT', 'Полная резервная копия повреждена: некорректный список документов.');
  const seen = new Set();
  const attachments = raw.map((a) => {
    const t = a && ATTACHMENT_TYPES[a.type];
    const ok = a && typeof a === 'object' && typeof a.attachmentId === 'string' && SAFE_ID.test(a.attachmentId) && t
      && a.file === `attachments/${a.attachmentId}.${t.ext}` && Number.isInteger(a.size) && a.size > 0 && a.size <= MAX_ATTACHMENT_BYTES
      && zip.has(a.file) && zip.size(a.file) === a.size && !seen.has(a.attachmentId);
    if (!ok) throw new BackupError('CORRUPT', 'Полная резервная копия повреждена: документ в архиве не совпадает с описанием.');
    seen.add(a.attachmentId);
    return {
      attachmentId: a.attachmentId,
      testId: typeof a.testId === 'string' || typeof a.testId === 'number' ? a.testId : null,
      name: cleanFileName(a.name, a.type),
      type: a.type,
      size: a.size,
      addedAt: typeof a.addedAt === 'string' ? a.addedAt : null,
      file: a.file,
    };
  });
  /* восстанавливаются только документы, на которые ссылаются анализы из копии */
  const referenced = AttachmentService.referencedIds(prepared.data[storage.KEYS.tests]);
  const linked = attachments.filter((a) => referenced.has(a.attachmentId));
  return {
    prepared,
    attachments: linked,
    unlinked: attachments.length - linked.length,
    missingInArchive: [...referenced].filter((id) => !seen.has(id)).length,
    zip,
    info: { ...prepared.info, full: true, createdAt: prepared.info.createdAt || (typeof manifest.createdAt === 'string' ? manifest.createdAt : null) },
  };
}

/* Восстановление полной копии:
   1) документы копии записываются в IndexedDB (прежние пока не удаляются);
      ошибка чтения/записи → добавленные удаляются, данные не меняются;
   2) атомарное восстановление данных (storage.restoreBackup, с откатом);
      ошибка → добавленные документы удаляются;
   3) удаляются документы, не привязанные к восстановленным анализам. */
export async function applyFullRestore(storage, service, full, { now = new Date() } = {}) {
  const store = service.store;
  const before = new Set(await store.keys());
  const added = [];
  const rollbackFiles = async () => { for (const id of added) await store.delete(id).catch(() => {}); };
  try {
    for (const a of full.attachments) {
      const bytes = await full.zip.read(a.file);
      if (sniffBytes(bytes.subarray(0, 16)) == null) throw new BackupError('CORRUPT', `Документ «${a.name}» в копии повреждён. Текущие данные не изменены.`);
      const data = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
      await store.put({ id: a.attachmentId, testId: a.testId, name: a.name, type: a.type, size: a.size, addedAt: a.addedAt || now.toISOString(), data });
      if (!before.has(a.attachmentId)) added.push(a.attachmentId);
    }
  } catch (err) {
    await rollbackFiles();
    if (err instanceof BackupError) throw err;
    const reason = err instanceof ZipError || (err && err.code === 'NO_SPACE') ? err.message : 'Не удалось записать документы на устройство.';
    throw new BackupError('RESTORE_FAILED', `${reason} Текущие данные не изменены.`);
  }
  let summary;
  try {
    summary = await storage.restoreBackup(full.prepared);
  } catch (err) {
    await rollbackFiles();
    throw err;
  }
  let cleanup = { removed: 0 };
  try { cleanup = await service.cleanupOrphans({ now, graceMs: 0 }); } catch { /* повторится при следующем запуске */ }
  return { summary, restoredAttachments: full.attachments.length, removedAttachments: cleanup.removed };
}

/* Сколько документов на устройстве пропадёт после восстановления: те, на которые
   ссылаются текущие анализы, но не ссылаются анализы из копии */
export async function countDocsLostOnRestore(storage, prepared) {
  const current = AttachmentService.referencedIds(await storage.getTests());
  const next = AttachmentService.referencedIds(prepared.data[storage.KEYS.tests]);
  return [...current].filter((id) => !next.has(id)).length;
}
