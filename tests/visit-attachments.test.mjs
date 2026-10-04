/* =========================================================
   tests/visit-attachments.test.mjs — документы медицинских записей («Врачи и визиты»):
   несколько PDF/фото на запись, удаление одного документа без удаления записи,
   полная резервная копия (ZIP) → чистый профиль → восстановление со связями файл ↔ запись,
   совместимость со старыми копиями, очистка «висячих» файлов.
   Без браузера: MemoryDriver + MemoryAttachmentStore. Только синтетические файлы и данные.

   Запуск:  node tests/visit-attachments.test.mjs
   ========================================================= */

import assert from 'node:assert/strict';
import { StorageService, MemoryDriver, parseBackup } from '../js/services/storage.js';
import { AttachmentService, VisitAttachmentService, MemoryAttachmentStore, AttachmentError, visitDocsOf, MAX_FILES_PER_PICK } from '../js/services/attachments.js';
import { createFullBackup, prepareFullRestore, applyFullRestore, countDocsLostOnRestore } from '../js/services/fullBackup.js';
import { createZip, readZip } from '../js/services/zip.js';
import { parseMedicalHistory, buildHistoryImportPlan, applyHistoryImportPlan, recordIdFor } from '../js/services/historyImport.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const bytes = (head, total = 3000, seed = 7) => {
  const b = new Uint8Array(total);
  b.set(head);
  for (let i = head.length; i < total; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
};
const PDF = bytes([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const JPG1 = bytes([0xff, 0xd8, 0xff, 0xe0], 2500, 11);
const JPG2 = bytes([0xff, 0xd8, 0xff, 0xe1], 2600, 13);
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 2700, 17);
const HEIC = bytes([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63], 2800, 19);
const file = (b, name, type) => new File([b], name, { type });
const OLD = new Date('2020-01-01T00:00:00Z');

async function profile() {
  const storage = new StorageService(new MemoryDriver());
  await storage.init();
  const store = new MemoryAttachmentStore();
  const visitStore = new MemoryAttachmentStore();
  return { storage, store, visitStore, tests: new AttachmentService(storage, store), visits: new VisitAttachmentService(storage, visitStore) };
}
const sameBytes = async (f, expected) => assert.deepEqual(new Uint8Array(await f.arrayBuffer()), expected);

test('1–4: запись, один PDF, несколько фото, PDF + фото к одной записи (добавляются, не заменяются)', async () => {
  const p = await profile();
  const v = await p.storage.addVisit({ date: '2026-02-14', title: 'Синтетический визит', kind: 'visit' });
  const r1 = await p.visits.attachToVisit(v.id, [file(PDF, 'заключение.pdf', 'application/pdf')], { now: OLD });
  assert.equal(r1.added.length, 1);
  const r2 = await p.visits.attachToVisit(v.id, [file(JPG1, 'IMG_1.jpg', 'image/jpeg'), file(PNG, 'scan.png', 'image/png'), file(HEIC, 'IMG_2.HEIC', 'image/heic')]);
  assert.equal(r2.added.length, 3);
  const docs = visitDocsOf(await p.storage.getVisit(v.id));
  assert.deepEqual(docs.map((a) => a.type), ['application/pdf', 'image/jpeg', 'image/png', 'image/heic']);
  assert.deepEqual(docs.map((a) => a.name), ['заключение.pdf', 'IMG_1.jpg', 'scan.png', 'IMG_2.HEIC']);
  assert.ok(docs.every((a) => a.size > 0 && a.addedAt && a.attachmentId));
  /* в записи — только метаданные, файлы — в отдельном хранилище визитов */
  assert.ok(!JSON.stringify(await p.storage.getVisits()).includes('base64'));
  assert.equal((await p.visitStore.keys()).length, 4);
  assert.equal((await p.store.keys()).length, 0, 'база документов анализов не затронута');
  const rec = await p.visitStore.get(docs[0].attachmentId);
  assert.equal(rec.visitId, v.id);
});

test('проверка файлов: неподходящие пропускаются с причиной, остальные добавляются; лимит за раз', async () => {
  const p = await profile();
  const v = await p.storage.addVisit({ date: '2026-02-14', doctor: 'Dr. Synthetic' });
  const res = await p.visits.attachToVisit(v.id, [file(new TextEncoder().encode('hello'), 'note.txt', 'text/plain'), file(JPG2, 'a.jpg', 'image/jpeg'), file(new Uint8Array(0), 'empty.pdf', 'application/pdf')]);
  assert.equal(res.added.length, 1);
  assert.equal(res.errors.length, 2);
  await assert.rejects(p.visits.attachToVisit(v.id, Array.from({ length: MAX_FILES_PER_PICK + 1 }, () => file(JPG1, 'x.jpg', 'image/jpeg'))), /до 20/);
  await assert.rejects(p.visits.attachToVisit('nope', [file(PDF, 'a.pdf', 'application/pdf')]), (e) => e instanceof AttachmentError);
  assert.equal((await p.visitStore.keys()).length, 1, 'ничего лишнего не записано');
});

test('5: открыть — тот же файл байт-в-байт, тип и имя сохранены', async () => {
  const p = await profile();
  const v = await p.storage.addVisit({ date: '2026-02-14', doctor: 'Dr. Synthetic' });
  const { added } = await p.visits.attachToVisit(v.id, [file(PDF, 'a.pdf', 'application/pdf'), file(JPG1, 'b.jpg', 'image/jpeg')]);
  const f = await p.visits.getFile(added[1]);
  assert.equal(f.type, 'image/jpeg');
  assert.equal(f.name, 'b.jpg');
  await sameBytes(f, JPG1);
});

test('6: удаление одного документа — запись и остальные документы остаются', async () => {
  const p = await profile();
  const v = await p.storage.addVisit({ date: '2026-02-14', doctor: 'Dr. Synthetic', conclusion: 'текст' });
  const { added } = await p.visits.attachToVisit(v.id, [file(PDF, 'a.pdf', 'application/pdf'), file(JPG1, 'b.jpg', 'image/jpeg'), file(PNG, 'c.png', 'image/png')]);
  assert.equal(await p.visits.removeFromVisit(v.id, added[1].attachmentId), true);
  const after = await p.storage.getVisit(v.id);
  assert.equal(after.conclusion, 'текст');
  assert.deepEqual(visitDocsOf(after).map((a) => a.name), ['a.pdf', 'c.png']);
  assert.equal(await p.visitStore.get(added[1].attachmentId), null);
  assert.equal(await p.visits.removeFromVisit(v.id, added[1].attachmentId), false, 'повторное удаление — ничего не делает');
  /* удаление записи целиком убирает её файлы */
  await p.visits.deleteVisit(v.id);
  assert.equal(await p.storage.getVisit(v.id), null);
  assert.equal((await p.visitStore.keys()).length, 0);
});

test('7–11: полная копия → чистый профиль → восстановление: все файлы, связи файл ↔ запись, без дублей', async () => {
  const a = await profile();
  const v1 = await a.storage.addVisit({ date: '2026-02-14', title: 'Запись 1', kind: 'imaging' });
  const v2 = await a.storage.addVisit({ date: '2026-02-15', doctor: 'Dr. Synthetic' });
  await a.visits.attachToVisit(v1.id, [file(PDF, 'v1.pdf', 'application/pdf'), file(JPG1, 'v1-1.jpg', 'image/jpeg'), file(JPG2, 'v1-2.jpg', 'image/jpeg')]);
  await a.visits.attachToVisit(v2.id, [file(PNG, 'v2.png', 'image/png')]);
  const t = await a.storage.addTest({ date: '2026-02-14', chol: 190 });
  await a.tests.attachToTest(t.id, file(PDF, 'analysis.pdf', 'application/pdf'));

  const full = await createFullBackup(a.storage, a.store, { visitStore: a.visitStore });
  assert.ok(full.verified);
  assert.equal(full.attachments, 1);
  assert.equal(full.visitAttachments, 4);

  const b = await profile(); // «очищенный» тестовый профиль — новый, пустой
  const prepared = await prepareFullRestore(b.storage, full.blob);
  assert.equal(prepared.visitAttachments.length, 4);
  const res = await applyFullRestore(b.storage, b.tests, prepared, { visitService: b.visits });
  assert.equal(res.restoredVisitAttachments, 4);
  assert.deepEqual(await b.storage.getVisits(), await a.storage.getVisits());
  for (const v of await a.storage.getVisits()) {
    for (const meta of visitDocsOf(v)) {
      const rec = await b.visitStore.get(meta.attachmentId);
      assert.equal(rec.visitId, v.id, 'связь файл ↔ запись восстановлена');
      await sameBytes(await b.visits.getFile(meta), new Uint8Array(await (await a.visits.getFile(meta)).arrayBuffer()));
    }
  }
  assert.equal((await b.visitStore.keys()).length, 4);
  assert.equal((await b.store.keys()).length, 1);
  /* повторное восстановление той же копии — без дублей */
  await applyFullRestore(b.storage, b.tests, await prepareFullRestore(b.storage, full.blob), { visitService: b.visits });
  assert.equal((await b.visitStore.keys()).length, 4);
  assert.equal((await b.storage.getVisits()).length, 2);
  assert.equal(visitDocsOf(await b.storage.getVisit(v1.id)).length, 3);
});

test('совместимость: старая полная копия (без visitAttachments) восстанавливается как раньше', async () => {
  const a = await profile();
  const t = await a.storage.addTest({ date: '2026-02-14', chol: 190 });
  await a.tests.attachToTest(t.id, file(PDF, 'analysis.pdf', 'application/pdf'));
  const oldFull = await createFullBackup(a.storage, a.store); // как вызывала прежняя версия
  const zip = await readZip(oldFull.blob);
  const manifest = JSON.parse(await zip.readText('lexlife-full-backup.json'));
  delete manifest.visitAttachments; // точь-в-точь формат прежних копий
  const entries = [{ name: 'lexlife-full-backup.json', data: new TextEncoder().encode(JSON.stringify(manifest)) }];
  for (const n of zip.names) if (n !== 'lexlife-full-backup.json') entries.push({ name: n, data: await zip.read(n) });
  const b = await profile();
  const prepared = await prepareFullRestore(b.storage, createZip(entries));
  assert.deepEqual(prepared.visitAttachments, []);
  await applyFullRestore(b.storage, b.tests, prepared, { visitService: b.visits });
  assert.equal((await b.store.keys()).length, 1);
  /* и прежний вызов без visitService тоже работает */
  const c = await profile();
  await applyFullRestore(c.storage, c.tests, await prepareFullRestore(c.storage, createZip(entries)));
  assert.equal((await c.store.keys()).length, 1);
});

test('обычная JSON-копия: метаданные документов проходят проверку и восстанавливаются; потеря файлов считается', async () => {
  const a = await profile();
  const v = await a.storage.addVisit({ date: '2026-02-14', doctor: 'Dr. Synthetic' });
  await a.visits.attachToVisit(v.id, [file(PDF, 'a.pdf', 'application/pdf')]);
  const { json, verified } = await a.storage.createBackup();
  assert.ok(verified);
  const b = await profile();
  const prepared = await b.storage.prepareRestore(parseBackup(json));
  await b.storage.restoreBackup(prepared);
  assert.equal(visitDocsOf(await b.storage.getVisit(v.id)).length, 1);
  assert.equal(await b.visits.getFile(visitDocsOf(await b.storage.getVisit(v.id))[0]), null, 'файла в JSON-копии нет — честно «не найден»');
  /* на профиле с файлом: копия без этой записи → 1 документ будет потерян */
  const empty = await profile();
  const emptyPrepared = await a.storage.prepareRestore(parseBackup((await empty.storage.createBackup()).json));
  assert.equal(await countDocsLostOnRestore(a.storage, emptyPrepared), 1);
});

test('очистка: «висячие» файлы визитов удаляются только в своей базе; база анализов не трогает файлы визитов', async () => {
  const p = await profile();
  const v = await p.storage.addVisit({ date: '2026-02-14', doctor: 'Dr. Synthetic' });
  await p.visits.attachToVisit(v.id, [file(PDF, 'a.pdf', 'application/pdf')], { now: OLD });
  await p.visitStore.put({ id: 'att_orphan', visitId: 'gone', name: 'x.pdf', type: 'application/pdf', size: PDF.length, addedAt: OLD.toISOString(), data: PDF.buffer.slice(0) });
  /* очистка документов анализов (как в старых версиях) видит только свою базу */
  assert.equal((await p.tests.cleanupOrphans()).removed, 0);
  assert.equal((await p.visitStore.keys()).length, 2);
  const res = await p.visits.cleanupOrphans();
  assert.equal(res.removed, 1);
  assert.deepEqual(await p.visitStore.keys(), [visitDocsOf(await p.storage.getVisit(v.id))[0].attachmentId]);
});

test('импорт истории создаёт записи без вложений; файл добавляется к старой записи позже, без пересоздания', async () => {
  const p = await profile();
  const pkg = { app: 'lexlife', kind: 'lexlife-medical-history', formatVersion: 1, packageId: 'synthetic-pkg-2',
    events: [{ importId: 'syn:2026-01-10:visit', date: '2026-01-10', kind: 'visit', title: 'Синтетика' }] };
  const parsed = parseMedicalHistory(JSON.stringify(pkg), { today: new Date(2026, 1, 20) });
  await applyHistoryImportPlan(p.storage, buildHistoryImportPlan(parsed, { visits: [], meds: [], tests: [] }));
  const id = recordIdFor('syn:2026-01-10:visit');
  assert.deepEqual((await p.storage.getVisit(id)).attachments, []);
  await p.visits.attachToVisit(id, [file(PDF, 'оригинал.pdf', 'application/pdf')]);
  const v = await p.storage.getVisit(id);
  assert.equal(v.importId, 'syn:2026-01-10:visit');
  assert.equal(visitDocsOf(v).length, 1);
  /* повторный импорт истории не трогает запись с документом */
  const again = buildHistoryImportPlan(parsed, { visits: await p.storage.getVisits(), meds: [], tests: [] });
  await applyHistoryImportPlan(p.storage, again);
  assert.equal(visitDocsOf(await p.storage.getVisit(id)).length, 1);
  assert.equal((await p.storage.getVisits()).length, 1);
});

/* ---------- запуск ---------- */
let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`  ✓ ${t.name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ FAIL ${t.name}\n    ${err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n    ') : err}`);
  }
}
console.log(`${tests.length - failed} passed, ${failed} failed (${tests.length} total)`);
process.exit(failed ? 1 : 0);
