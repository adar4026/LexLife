/* =========================================================
   zip.js — минимальный ZIP без внешних библиотек (полная резервная копия).
   Запись: метод STORE (без сжатия — PDF/JPEG/PNG/HEIC уже сжаты), UTF-8 имена,
   CRC-32. Чтение: по центральному каталогу через Blob.slice (архив не читается
   в память целиком), проверка CRC и размеров; DEFLATE — только если браузер
   умеет DecompressionStream('deflate-raw'). ZIP64 и шифрование не поддерживаются.
   ========================================================= */

export class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipError';
  }
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const MAX_ENTRIES = 5000;
const MAX_U32 = 0xffffffff;

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c >>> 0;
  }
  return CRC_TABLE;
}
export function crc32(bytes) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/* Имя записи: относительный путь без «..», обратных слэшей и управляющих символов */
export function isSafeEntryName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 200
    && !name.startsWith('/') && !name.includes('\\') && !/[\u0000-\u001f]/.test(name)
    && name.split('/').every((p) => p !== '' && p !== '.' && p !== '..');
}

/* entries: [{ name, data: Uint8Array }] → Blob (application/zip) */
export function createZip(entries, { date = new Date() } = {}) {
  const enc = new TextEncoder();
  const { time, date: dosDate } = dosDateTime(date);
  const parts = [];
  const central = [];
  let offset = 0;
  const names = new Set();
  for (const e of entries) {
    if (!isSafeEntryName(e.name)) throw new ZipError(`Недопустимое имя файла в архиве: ${e.name}`);
    if (names.has(e.name)) throw new ZipError(`Повторяющееся имя файла в архиве: ${e.name}`);
    names.add(e.name);
    const data = e.data instanceof Uint8Array ? e.data : new Uint8Array(e.data);
    if (data.length >= MAX_U32 || offset >= MAX_U32) throw new ZipError('Резервная копия слишком большая (больше 4 ГБ).');
    const nameBytes = enc.encode(e.name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, SIG_LOCAL, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 имена
    local.setUint16(8, 0, true); // STORE
    local.setUint16(10, time, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, SIG_CENTRAL, true);
    cd.setUint16(4, 20, true); // version made by
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, SIG_EOCD, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(eocd.buffer)], { type: 'application/zip' });
}

const bytesOf = async (blob, start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer());

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== 'function') throw new ZipError('Архив сжат, а этот браузер не умеет его распаковать.');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* Blob → { names: [...], has(name), size(name), read(name) → Uint8Array, readText(name) } */
export async function readZip(blob) {
  if (!blob || typeof blob.slice !== 'function') throw new ZipError('Файл не является ZIP-архивом.');
  const size = blob.size;
  if (size < 22) throw new ZipError('Файл не является ZIP-архивом.');
  const tailLen = Math.min(size, 22 + 0xffff);
  const tail = await bytesOf(blob, size - tailLen, size);
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocdAt = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === SIG_EOCD) { eocdAt = i; break; }
  }
  if (eocdAt < 0) throw new ZipError('Файл не является ZIP-архивом или повреждён.');
  const count = tv.getUint16(eocdAt + 10, true);
  const cdSize = tv.getUint32(eocdAt + 12, true);
  const cdOffset = tv.getUint32(eocdAt + 16, true);
  if (count === 0xffff || cdOffset === MAX_U32) throw new ZipError('Архивы ZIP64 не поддерживаются.');
  if (count > MAX_ENTRIES) throw new ZipError('В архиве слишком много файлов.');
  if (cdOffset + cdSize > size) throw new ZipError('ZIP-архив повреждён.');

  const cd = await bytesOf(blob, cdOffset, cdOffset + cdSize);
  const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const dec = new TextDecoder('utf-8', { fatal: false });
  const entries = new Map();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cv.getUint32(p, true) !== SIG_CENTRAL) throw new ZipError('ZIP-архив повреждён.');
    const flags = cv.getUint16(p + 8, true);
    const method = cv.getUint16(p + 10, true);
    const crc = cv.getUint32(p + 16, true);
    const compSize = cv.getUint32(p + 20, true);
    const rawSize = cv.getUint32(p + 24, true);
    const nameLen = cv.getUint16(p + 28, true);
    const extraLen = cv.getUint16(p + 30, true);
    const commentLen = cv.getUint16(p + 32, true);
    const localOffset = cv.getUint32(p + 42, true);
    const name = dec.decode(cd.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // каталог
    if (flags & 0x1) throw new ZipError('Зашифрованные архивы не поддерживаются.');
    if (!isSafeEntryName(name)) throw new ZipError('В архиве есть файл с недопустимым именем.');
    if (entries.has(name)) throw new ZipError('В архиве повторяются имена файлов.');
    if (method !== 0 && method !== 8) throw new ZipError('Неподдерживаемый метод сжатия в архиве.');
    entries.set(name, { name, method, crc, compSize, rawSize, localOffset });
  }

  async function read(name) {
    const e = entries.get(name);
    if (!e) throw new ZipError(`В архиве нет файла ${name}.`);
    const lh = await bytesOf(blob, e.localOffset, e.localOffset + 30);
    const lv = new DataView(lh.buffer, lh.byteOffset, lh.byteLength);
    if (lh.length < 30 || lv.getUint32(0, true) !== SIG_LOCAL) throw new ZipError('ZIP-архив повреждён.');
    const start = e.localOffset + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
    if (start + e.compSize > size) throw new ZipError('ZIP-архив повреждён.');
    let data = await bytesOf(blob, start, start + e.compSize);
    if (e.method === 8) data = await inflateRaw(data);
    if (data.length !== e.rawSize || crc32(data) !== e.crc) throw new ZipError(`Файл ${name} в архиве повреждён (контрольная сумма не совпадает).`);
    return data;
  }

  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    size: (name) => (entries.get(name) || {}).rawSize,
    read,
    readText: async (name) => new TextDecoder('utf-8').decode(await read(name)),
  };
}
