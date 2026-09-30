/* =========================================================
   tests/attachments.test.mjs — документы анализов (PDF/фото), полная
   резервная копия (ZIP), импорт подготовленного анализа.
   Без браузера и сети: StorageService на MemoryDriver, файлы — MemoryAttachmentStore.
   Только синтетические данные — никаких реальных медицинских данных.

   Запуск:  node tests/attachments.test.mjs
   ========================================================= */

import assert from 'node:assert/strict';
import { StorageService, MemoryDriver, parseBackup, BackupError, BACKUP_FORMAT_VERSION, CURRENT_SCHEMA_VERSION } from '../js/services/storage.js';
import {
  AttachmentService, MemoryAttachmentStore, AttachmentError, checkAttachmentFile, sniffBytes,
  MAX_ATTACHMENT_BYTES, ORPHAN_GRACE_MS, attachmentOf, formatBytes,
} from '../js/services/attachments.js';
import { createFullBackup, prepareFullRestore, applyFullRestore, isZipFile, fullBackupFileName, countDocsLostOnRestore } from '../js/services/fullBackup.js';
import { createZip, readZip, ZipError, crc32 } from '../js/services/zip.js';
import { parsePreparedTest, importPreparedTest, PreparedImportError, parseRange } from '../js/services/preparedImport.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ---------- синтетические файлы ---------- */
const bytes = (head, total = 2048) => {
  const b = new Uint8Array(total);
  b.set(head);
  for (let i = head.length; i < total; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
};
const PDF = bytes([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // %PDF-1.7
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPG = bytes([0xff, 0xd8, 0xff, 0xe0]);
const HEIC = bytes([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]); // ....ftypheic
const pdfFile = (name = 'Анализ крови.pdf') => new File([PDF], name, { type: 'application/pdf' });
const pngFile = () => new File([PNG], 'photo.png', { type: 'image/png' });

async function setup() {
  const storage = new StorageService(new MemoryDriver());
  await storage.init();
  const store = new MemoryAttachmentStore();
  const service = new AttachmentService(storage, store);
  return { storage, store, service };
}
const OLD = new Date('2020-01-01T00:00:00Z'); // «давно» — вне периода защиты свежих файлов
const later = (d, ms) => new Date(d.getTime() + ms);
const sameBytes = async (file, expected) => assert.deepEqual(new Uint8Array(await file.arrayBuffer()), expected);

function syntheticResults(n) {
  return Array.from({ length: n }, (_, i) => ({
    group: i % 3 === 0 ? 'Группа A' : i % 3 === 1 ? 'Группа B' : 'Группа C',
    name: `Показатель ${i + 1}`,
    value: Math.round((i * 1.37 + 0.5) * 100) / 100,
    unit: i % 2 ? 'mg/dL' : '%',
    ref: i % 4 === 0 ? `${i}.00–${i + 10}.00` : `описание диапазона ${i}`,
  }));
}
function preparedJson(over = {}) {
  return JSON.stringify({
    app: 'lexlife',
    kind: 'lexlife-prepared-test',
    formatVersion: 1,
    importId: 'synthetic-test-0001',
    test: {
      date: '2025-03-15',
      note: 'синтетическая запись',
      chol: 180, ldl: 100, hdl: 55,
      labRanges: { chol: '< 200', ldl: '0.00–116.00' },
      customResults: syntheticResults(40),
    },
    ...over,
  });
}

/* ================= ZIP ================= */

test('zip: запись и чтение (UTF-8 имена, бинарные данные, CRC)', async () => {
  const blob = createZip([{ name: 'a/б.txt', data: new TextEncoder().encode('привет') }, { name: 'x.pdf', data: PDF }]);
  const z = await readZip(blob);
  assert.deepEqual(z.names.sort(), ['a/б.txt', 'x.pdf']);
  assert.equal(await z.readText('a/б.txt'), 'привет');
  assert.deepEqual(await z.read('x.pdf'), PDF);
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('zip: повреждённые данные обнаруживаются по CRC, опасные имена отклоняются', async () => {
  const blob = createZip([{ name: 'x.pdf', data: PDF }]);
  const buf = new Uint8Array(await blob.arrayBuffer());
  buf[30 + 'x.pdf'.length + 100] ^= 0xff; // байт внутри данных
  const z = await readZip(new Blob([buf]));
  await assert.rejects(z.read('x.pdf'), ZipError);
  assert.throws(() => createZip([{ name: '../evil', data: PDF }]), ZipError);
  assert.throws(() => createZip([{ name: '/abs', data: PDF }]), ZipError);
  await assert.rejects(readZip(new Blob([new Uint8Array(100)])), ZipError);
});

/* ================= Проверка файла ================= */

test('тип файла определяется по содержимому: PDF, JPEG, PNG, HEIC', async () => {
  assert.equal(sniffBytes(PDF), 'application/pdf');
  assert.equal(sniffBytes(JPG), 'image/jpeg');
  assert.equal(sniffBytes(PNG), 'image/png');
  assert.equal(sniffBytes(HEIC), 'image/heic');
  assert.equal((await checkAttachmentFile(new File([HEIC], 'IMG_0001.HEIC'))).type, 'image/heic');
  /* расширение .pdf не делает текстовый файл PDF-документом */
  const fake = await checkAttachmentFile(new File(['hello world'], 'fake.pdf', { type: 'application/pdf' }));
  assert.equal(fake.ok, false);
  assert.equal(fake.code, 'UNSUPPORTED');
});

test('лимит 15 МБ и неподдерживаемый/пустой файл — понятная ошибка, анализ не меняется', async () => {
  const { storage, store, service } = await setup();
  const t = await storage.addTest({ date: '2025-01-10', chol: 190 });
  const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
  big.set(PDF.subarray(0, 8));
  const tooBig = await checkAttachmentFile(new File([big], 'big.pdf'));
  assert.equal(tooBig.code, 'TOO_LARGE');
  assert.match(tooBig.message, /15 МБ/);
  const exact = new Uint8Array(MAX_ATTACHMENT_BYTES);
  exact.set(PDF.subarray(0, 8));
  assert.equal((await checkAttachmentFile(new File([exact], 'ok.pdf'))).ok, true);
  await assert.rejects(service.attachToTest(t.id, new File([big], 'big.pdf')), (e) => e instanceof AttachmentError && e.code === 'TOO_LARGE');
  await assert.rejects(service.attachToTest(t.id, new File(['GIF89a......'], 'x.gif')), (e) => e.code === 'UNSUPPORTED');
  await assert.rejects(service.attachToTest(t.id, new File([], 'empty.pdf')), (e) => e.code === 'EMPTY');
  assert.deepEqual((await storage.getTest(t.id)).attachments, []);
  assert.equal((await store.keys()).length, 0);
});

/* ================= Прикрепление / открытие / удаление ================= */

test('прикрепление PDF: файл в хранилище документов, в анализе только метаданные', async () => {
  const { storage, store, service } = await setup();
  const t = await storage.addTest({ date: '2025-01-10', chol: 190, note: 'n' });
  const now = new Date('2025-02-01T10:00:00Z');
  const meta = await service.attachToTest(t.id, pdfFile(), { now });
  assert.deepEqual(Object.keys(meta).sort(), ['addedAt', 'attachmentId', 'name', 'size', 'type']);
  assert.equal(meta.name, 'Анализ крови.pdf');
  assert.equal(meta.type, 'application/pdf');
  assert.equal(meta.size, PDF.length);
  assert.equal(meta.addedAt, now.toISOString());
  const saved = await storage.getTest(t.id);
  assert.deepEqual(saved.attachments, [meta]);
  assert.equal(saved.chol, 190);
  /* в localStorage (health_tests) нет содержимого файла */
  const raw = await storage.driver.get('health_tests');
  assert.ok(!raw.includes('base64') && raw.length < 1000);
  assert.deepEqual(await store.keys(), [meta.attachmentId]);
  assert.equal(formatBytes(meta.size), '2 КБ');
});

test('прикрепление изображения (PNG/JPEG/HEIC) и замена документа удаляет прежний файл', async () => {
  const { storage, store, service } = await setup();
  const t = await storage.addTest({ date: '2025-01-10' });
  const m1 = await service.attachToTest(t.id, pngFile());
  assert.equal(m1.type, 'image/png');
  const m2 = await service.attachToTest(t.id, new File([JPG], 'scan.jpeg'));
  assert.equal(m2.type, 'image/jpeg');
  assert.deepEqual(await store.keys(), [m2.attachmentId]);
  const m3 = await service.attachToTest(t.id, new File([HEIC], 'IMG.heic'));
  assert.equal(m3.type, 'image/heic');
  assert.deepEqual((await storage.getTest(t.id)).attachments, [m3]);
  assert.deepEqual(await store.keys(), [m3.attachmentId]);
});

test('открытие вложения возвращает исходный файл; удаление только вложения оставляет анализ', async () => {
  const { storage, store, service } = await setup();
  const t = await storage.addTest({ date: '2025-01-10', ldl: 101 });
  const meta = await service.attachToTest(t.id, pdfFile());
  const file = await service.getFile(attachmentOf(await storage.getTest(t.id)));
  assert.equal(file.name, 'Анализ крови.pdf');
  assert.equal(file.type, 'application/pdf');
  await sameBytes(file, PDF);
  assert.equal(await service.removeFromTest(t.id), true);
  const after = await storage.getTest(t.id);
  assert.ok(after, 'анализ остался');
  assert.equal(after.ldl, 101);
  assert.deepEqual(after.attachments, []);
  assert.equal((await store.keys()).length, 0);
  /* вложение не найдено → null (UI показывает понятное сообщение) */
  assert.equal(await service.getFile(meta), null);
  assert.equal(await service.removeFromTest(t.id), false);
});

test('удаление анализа удаляет связанный файл, другие анализы и их файлы не затрагиваются', async () => {
  const { storage, store, service } = await setup();
  const a = await storage.addTest({ date: '2025-01-10' });
  const b = await storage.addTest({ date: '2025-02-10' });
  const ma = await service.attachToTest(a.id, pdfFile());
  const mb = await service.attachToTest(b.id, pngFile());
  const removed = await service.deleteTest(a.id);
  assert.equal(removed.id, a.id);
  assert.equal(await storage.getTest(a.id), null);
  assert.deepEqual(await store.keys(), [mb.attachmentId]);
  assert.equal(await service.getFile(ma), null);
  assert.ok(await service.getFile(mb));
  assert.equal(await service.deleteTest('нет-такого'), null);
});

test('ручное добавление и редактирование анализа: очищенное поле удаляется, остальное сохраняется', async () => {
  const { storage, service } = await setup();
  const t = await storage.addTest({ date: '2025-01-10', chol: 190, ldl: 110, note: 'x', customResults: [{ name: 'A', value: 1, unit: '', ref: '' }] });
  await service.attachToTest(t.id, pdfFile());
  const upd = await storage.updateTest(t.id, { date: '2025-01-11', chol: 200, ldl: undefined, note: 'y', id: 'hack' });
  assert.equal(upd.id, t.id);
  assert.equal(upd.chol, 200);
  assert.ok(!('ldl' in upd));
  assert.equal(upd.customResults.length, 1);
  assert.equal(upd.attachments.length, 1);
  assert.equal(await storage.updateTest('нет', { chol: 1 }), null);
});

/* ================= Очистка «висячих» файлов ================= */

test('очистка висячих файлов: удаляет только старые непривязанные, свежие и привязанные остаются', async () => {
  const { storage, store, service } = await setup();
  const t = await storage.addTest({ date: '2025-01-10' });
  const meta = await service.attachToTest(t.id, pdfFile(), { now: OLD });
  const put = (id, addedAt) => store.put({ id, testId: 'x', name: 'o.pdf', type: 'application/pdf', size: 4, addedAt, data: PDF.slice(0, 16).buffer });
  await put('orphan_old', OLD.toISOString());
  const now = later(OLD, 24 * 3600e3);
  await put('orphan_fresh', later(now, -60e3).toISOString());
  await put('orphan_nodate', undefined);
  const res = await service.cleanupOrphans({ now });
  assert.equal(res.removed, 1);
  assert.deepEqual((await store.keys()).sort(), [meta.attachmentId, 'orphan_fresh', 'orphan_nodate'].sort());
  /* через период защиты свежий висячий файл удаляется */
  const res2 = await service.cleanupOrphans({ now: later(now, ORPHAN_GRACE_MS) });
  assert.equal(res2.removed, 1);
  assert.deepEqual((await store.keys()).sort(), [meta.attachmentId, 'orphan_nodate'].sort());
});

test('очистка не удаляет ничего, если анализы повреждены/отсутствуют или идёт восстановление', async () => {
  const { storage, store, service } = await setup();
  await store.put({ id: 'orphan', name: 'o.pdf', type: 'application/pdf', size: 4, addedAt: OLD.toISOString(), data: PDF.slice(0, 16).buffer });
  await storage.driver.set('health_tests', '{не json');
  assert.equal((await service.cleanupOrphans({ now: new Date() })).skipped, true);
  await storage.driver.remove('health_tests');
  assert.equal((await service.cleanupOrphans({ now: new Date() })).skipped, true);
  await storage.driver.set('health_tests', '[]');
  await storage.driver.set('lexlife_restore_rollback', '{"state":"pending"}');
  assert.equal((await service.cleanupOrphans({ now: new Date() })).skipped, true);
  assert.deepEqual(await store.keys(), ['orphan']);
  await storage.driver.remove('lexlife_restore_rollback');
  assert.equal((await service.cleanupOrphans({ now: new Date() })).removed, 1);
});

/* ================= Обычная резервная копия ================= */

test('обычный backup: формат прежний (v2, схема 8), метаданные вложений и показатели сохраняются, без файлов', async () => {
  const { storage, service } = await setup();
  const t = await storage.addTest({ date: '2025-01-10', chol: 190, customResults: syntheticResults(5), labRanges: { chol: '< 200' } });
  const meta = await service.attachToTest(t.id, pdfFile());
  const b = await storage.createBackup();
  assert.equal(b.verified, true);
  const raw = JSON.parse(b.json);
  assert.equal(raw.backupFormatVersion, BACKUP_FORMAT_VERSION);
  assert.equal(raw.backupFormatVersion, 2);
  assert.equal(raw.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(raw.schemaVersion, 8);
  assert.deepEqual(raw.blobs, {});
  assert.ok(!b.json.includes('JVBER'), 'нет base64 содержимого PDF');
  const saved = raw.data.health_tests[0];
  assert.deepEqual(saved.attachments, [meta]);
  assert.equal(saved.customResults.length, 5);

  /* восстановление на «другом устройстве» (без файлов): запись есть, документ не найден */
  const other = await setup();
  await other.storage.restoreBackup(await other.storage.prepareRestore(parseBackup(b.json)));
  const restored = (await other.storage.getTests())[0];
  assert.deepEqual(restored.attachments, [meta]);
  assert.equal(await other.service.getFile(attachmentOf(restored)), null);
});

test('восстановление старого backup (формат 1, схема 7, анализы без вложений) — без ошибок', async () => {
  const { storage, store, service } = await setup();
  const cur = await storage.addTest({ date: '2025-05-01' });
  await service.attachToTest(cur.id, pdfFile(), { now: OLD });
  const old = {
    app: 'moe-zdorovie',
    schemaVersion: 7,
    exportedAt: '2026-01-01T10:00:00.000Z',
    data: {
      health_tests: [{ id: 't1', date: '2025-12-01', chol: 200, note: '' }, { id: 't2', date: '2025-06-01', ldl: 120, attachments: [] }],
      health_meds: [{ id: 'm1', name: 'Синтетик', icon: '💊', active: true }],
    },
  };
  const prepared = await storage.prepareRestore(parseBackup(JSON.stringify(old)));
  assert.equal(prepared.summary.tests, 2);
  assert.equal(await countDocsLostOnRestore(storage, prepared), 1);
  await storage.restoreBackup(prepared);
  const list = await storage.getTests();
  assert.deepEqual(list.map((t) => t.id), ['t1', 't2']);
  /* при следующем запуске файл прежнего анализа удаляется как висячий */
  assert.equal((await service.cleanupOrphans({ now: new Date() })).removed, 1);
  assert.equal((await store.keys()).length, 0);
});

/* ================= Полная резервная копия ================= */

test('полный backup с документами: ZIP с манифестом, backup.json и файлами; восстановление на чистом устройстве', async () => {
  const src = await setup();
  const a = await src.storage.addTest({ date: '2025-01-10', chol: 190, customResults: syntheticResults(40) });
  const b = await src.storage.addTest({ date: '2025-02-10', ldl: 99 });
  await src.storage.addTest({ date: '2025-03-10', hdl: 60 }); // без документа
  const ma = await src.service.attachToTest(a.id, pdfFile());
  const mb = await src.service.attachToTest(b.id, new File([HEIC], 'IMG_1.HEIC'));
  await src.storage.addWaterEntry(300, '2025-02-01', '09:00');
  const full = await createFullBackup(src.storage, src.store);
  assert.equal(full.verified, true);
  assert.equal(full.attachments, 2);
  assert.equal(full.missing, 0);
  assert.match(full.fileName, /^LexLife-full-backup-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/);
  assert.equal(fullBackupFileName(new Date(2026, 0, 2, 3, 4)), 'LexLife-full-backup-2026-01-02-0304.zip');
  assert.equal(await isZipFile(full.blob), true);
  assert.equal(await isZipFile(new File(['{}'], 'x.json')), false);

  const zip = await readZip(full.blob);
  assert.ok(zip.has('lexlife-full-backup.json') && zip.has('backup.json'));
  assert.ok(zip.has(`attachments/${ma.attachmentId}.pdf`) && zip.has(`attachments/${mb.attachmentId}.heic`));
  /* backup.json внутри — обычная копия, её можно восстановить и без документов */
  const inner = JSON.parse(await zip.readText('backup.json'));
  assert.equal(inner.backupFormatVersion, 2);

  const dst = await setup();
  const prepared = await prepareFullRestore(dst.storage, full.blob);
  assert.equal(prepared.attachments.length, 2);
  assert.equal(prepared.summary, undefined);
  assert.equal(prepared.prepared.summary.tests, 3);
  const res = await applyFullRestore(dst.storage, dst.service, prepared);
  assert.equal(res.restoredAttachments, 2);
  const restored = await dst.storage.getTests();
  assert.equal(restored.length, 3);
  const ra = restored.find((t) => t.id === a.id);
  assert.deepEqual(ra.customResults, (await src.storage.getTest(a.id)).customResults);
  await sameBytes(await dst.service.getFile(attachmentOf(ra)), PDF);
  await sameBytes(await dst.service.getFile(attachmentOf(restored.find((t) => t.id === b.id))), HEIC);
  assert.equal((await dst.storage.getWaterDay('2025-02-01')).total, 300);
});

test('полное восстановление заменяет документы: файлы, не привязанные к анализам из копии, удаляются', async () => {
  const src = await setup();
  const a = await src.storage.addTest({ date: '2025-01-10' });
  await src.service.attachToTest(a.id, pdfFile());
  const full = await createFullBackup(src.storage, src.store);

  const dst = await setup();
  const own = await dst.storage.addTest({ date: '2024-12-01' });
  const ownMeta = await dst.service.attachToTest(own.id, pngFile());
  const prepared = await prepareFullRestore(dst.storage, full.blob);
  assert.equal(await countDocsLostOnRestore(dst.storage, prepared.prepared), 1);
  const res = await applyFullRestore(dst.storage, dst.service, prepared);
  assert.equal(res.removedAttachments, 1);
  assert.equal(await dst.service.getFile(ownMeta), null);
  assert.deepEqual((await dst.storage.getTests()).map((t) => t.id), [a.id]);
});

test('повреждённая полная копия: восстановление отменяется, данные и документы не меняются', async () => {
  const src = await setup();
  const a = await src.storage.addTest({ date: '2025-01-10' });
  const ma = await src.service.attachToTest(a.id, pdfFile());
  const full = await createFullBackup(src.storage, src.store);
  /* портим байт содержимого PDF внутри архива → CRC не совпадёт при чтении */
  const buf = new Uint8Array(await full.blob.arrayBuffer());
  const name = new TextEncoder().encode(`attachments/${ma.attachmentId}.pdf`);
  let at = -1;
  for (let i = 0; i < buf.length - name.length && at < 0; i++) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 3 && buf[i + 3] === 4 && name.every((c, k) => buf[i + 30 + k] === c)) at = i;
  }
  assert.ok(at > 0);
  buf[at + 30 + name.length + 500] ^= 0xff;

  const dst = await setup();
  const own = await dst.storage.addTest({ date: '2024-12-01', chol: 170 });
  const ownMeta = await dst.service.attachToTest(own.id, pngFile());
  const before = await dst.storage.driver.get('health_tests');
  const prepared = await prepareFullRestore(dst.storage, new Blob([buf]));
  await assert.rejects(applyFullRestore(dst.storage, dst.service, prepared), (e) => e instanceof BackupError && /не изменены/.test(e.message));
  assert.equal(await dst.storage.driver.get('health_tests'), before);
  assert.deepEqual(await dst.store.keys(), [ownMeta.attachmentId]);

  /* не архив LexLife / не ZIP */
  await assert.rejects(prepareFullRestore(dst.storage, createZip([{ name: 'x.txt', data: PDF }])), (e) => e.code === 'NOT_LEXLIFE');
  await assert.rejects(prepareFullRestore(dst.storage, new Blob(['not a zip at all, definitely'])), (e) => e.code === 'CORRUPT');
});

test('полная копия отмечает отсутствующие на устройстве файлы и всё равно восстанавливает данные', async () => {
  const src = await setup();
  const a = await src.storage.addTest({ date: '2025-01-10' });
  const ma = await src.service.attachToTest(a.id, pdfFile());
  await src.store.delete(ma.attachmentId); // файл потерян
  const full = await createFullBackup(src.storage, src.store);
  assert.equal(full.missing, 1);
  assert.equal(full.attachments, 0);
  assert.equal(full.verified, true);
  const dst = await setup();
  const p = await prepareFullRestore(dst.storage, full.blob);
  assert.equal(p.missingInArchive, 1);
  await applyFullRestore(dst.storage, dst.service, p);
  assert.equal((await dst.storage.getTests()).length, 1);
});

/* ================= Импорт подготовленного анализа ================= */

test('локальный JSON-импорт: проверка, предпросмотр, добавление к существующим данным', async () => {
  const { storage } = await setup();
  const manual = await storage.addTest({ date: '2024-11-01', chol: 210 });
  await storage.addWaterEntry(250, '2025-01-01', '08:00');
  await storage.addMed({ name: 'Синтетик' });
  await storage.setMetricValue('weight', 70.5, '2025-01-01');
  await storage.driver.set('app_theme', 'light');
  const snapshot = {};
  for (const k of ['metrics_log', 'health_meds', 'health_metrics', 'app_profile', 'notifications', 'app_theme', 'hydration_cfg']) snapshot[k] = await storage.driver.get(k);

  const parsed = parsePreparedTest(preparedJson(), { today: new Date('2026-01-01') });
  assert.equal(parsed.summary.date, '2025-03-15');
  assert.deepEqual(parsed.summary.main, ['chol', 'ldl', 'hdl']);
  assert.equal(parsed.summary.customCount, 40);
  assert.deepEqual(parsed.summary.groups.map((g) => g.name), ['Группа A', 'Группа B', 'Группа C']);
  const res = await importPreparedTest(storage, parsed);
  assert.equal(res.added, true);
  const list = await storage.getTests();
  assert.equal(list.length, 2);
  assert.ok(list.find((t) => t.id === manual.id && t.chol === 210), 'существующий анализ не изменён');
  const e = res.entry;
  assert.equal(e.importId, 'synthetic-test-0001');
  assert.equal(e.chol, 180);
  assert.deepEqual(e.labRanges, { chol: '< 200', ldl: '0.00–116.00' });
  assert.deepEqual(e.attachments, []);
  for (const k of Object.keys(snapshot)) assert.equal(await storage.driver.get(k), snapshot[k], `${k} не изменился`);
  /* запись проходит проверку резервной копии */
  assert.equal((await storage.createBackup()).verified, true);
});

test('защита от повторного импорта: повторный файл и двойное нажатие не создают дубль', async () => {
  const { storage } = await setup();
  const parsed = parsePreparedTest(preparedJson(), { today: new Date('2026-01-01') });
  const [r1, r2] = await Promise.all([importPreparedTest(storage, parsed), importPreparedTest(storage, parsed)]);
  assert.equal([r1, r2].filter((r) => r.added).length, 1);
  const r3 = await importPreparedTest(storage, parsePreparedTest(preparedJson(), { today: new Date('2026-01-01') }));
  assert.equal(r3.added, false);
  assert.equal(r3.existing.importId, 'synthetic-test-0001');
  assert.equal((await storage.getTests()).length, 1);
  /* другая запись (другой importId) добавляется */
  const r4 = await importPreparedTest(storage, parsePreparedTest(preparedJson({ importId: 'synthetic-test-0002' }), { today: new Date('2026-01-01') }));
  assert.equal(r4.added, true);
  assert.equal((await storage.getTests()).length, 2);
});

test('сохраняются все пользовательские показатели: название, значение, единица, диапазон (и после backup)', async () => {
  const { storage } = await setup();
  const input = syntheticResults(40);
  const parsed = parsePreparedTest(preparedJson(), { today: new Date('2026-01-01') });
  const { entry } = await importPreparedTest(storage, parsed);
  assert.equal(entry.customResults.length, input.length);
  input.forEach((r, i) => {
    const s = entry.customResults[i];
    assert.equal(s.name, r.name);
    assert.equal(s.value, r.value);
    assert.equal(s.unit, r.unit);
    assert.equal(s.ref, r.ref);
    assert.equal(s.group, r.group);
    if (i % 4 === 0) { assert.equal(s.refLow, i); assert.equal(s.refHigh, i + 10); } else assert.ok(!('refLow' in s));
  });
  const other = await setup();
  const b = await storage.createBackup();
  await other.storage.restoreBackup(await other.storage.prepareRestore(parseBackup(b.json)));
  assert.deepEqual((await other.storage.getTests())[0].customResults, entry.customResults);
  assert.deepEqual(parseRange('0.00–7.00'), { refLow: 0, refHigh: 7 });
  assert.deepEqual(parseRange('для мужчин 30–400'), {});
});

test('JSON-импорт отклоняет некорректные файлы с понятным сообщением', () => {
  const today = { today: new Date('2026-01-01') };
  const bad = (json, re) => assert.throws(() => parsePreparedTest(json, today), (e) => e instanceof PreparedImportError && re.test(e.message));
  bad('', /пуст/);
  bad('{oops', /не корректный JSON/);
  bad(JSON.stringify({ app: 'lexlife', backupFormatVersion: 2, data: {} }), /резервная копия/);
  bad(JSON.stringify({ app: 'other' }), /не является/);
  bad(preparedJson({ formatVersion: 9 }), /более новой версии/);
  bad(preparedJson({ importId: 'x' }), /идентификатора импорта/);
  bad(preparedJson({ test: { date: '2025-02-30', chol: 1 } }), /дата/i);
  bad(preparedJson({ test: { date: '2026-06-01', chol: 1 } }), /будущем/);
  bad(preparedJson({ test: { date: '2025-02-01', chol: '190' } }), /числом/);
  bad(preparedJson({ test: { date: '2025-02-01', patient: 'X', chol: 1 } }), /Неизвестные поля/);
  bad(preparedJson({ test: { date: '2025-02-01' } }), /ни одного показателя/);
  bad(preparedJson({ test: { date: '2025-02-01', customResults: [{ name: 'A', value: 'много' }] } }), /числом/);
  bad(preparedJson({ test: { date: '2025-02-01', customResults: [{ name: 'A', value: 1 }, { name: 'A', value: 2 }] } }), /повторяется/);
  bad(preparedJson({ test: { date: '2025-02-01', customResults: [{ name: 'A', value: 1, dob: '1970' }] } }), /неизвестные поля/);
  bad('{"__proto__":{"x":1},"app":"lexlife"}', /не является/);
});

/* ---------- запуск ---------- */
let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`✓ ${t.name}`);
  } catch (err) {
    failed += 1;
    console.error(`✗ ${t.name}\n  ${err && err.stack}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
