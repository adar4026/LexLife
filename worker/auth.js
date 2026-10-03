/* =========================================================
   worker/auth.js — аутентификация устройства без аккаунта.
   device_id — не секрет. Секрет — случайный токен (32 байта),
   выданный при регистрации; в D1 хранится только его SHA-256.
   Запросы: Authorization: Bearer <device_id>.<token>
   ========================================================= */

import { b64uEncode } from './webpush.js';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export async function sha256Hex(text) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const newToken = () => b64uEncode(crypto.getRandomValues(new Uint8Array(32)));

/* Сравнение без раннего выхода (длины хэшей одинаковы) */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function parseAuthorization(header) {
  const m = /^Bearer ([0-9a-f-]{36})\.([A-Za-z0-9_-]+)$/.exec(header || '');
  if (!m || !UUID_RE.test(m[1]) || !TOKEN_RE.test(m[2])) return null;
  return { deviceId: m[1], token: m[2] };
}

/* → строка devices или null (одинаковый ответ для «нет устройства» и «неверный токен») */
export async function authenticate(request, db) {
  const creds = parseAuthorization(request.headers.get('Authorization'));
  if (!creds) return null;
  const row = await db.prepare('SELECT * FROM devices WHERE id = ?').bind(creds.deviceId).first();
  const hash = await sha256Hex(creds.token);
  if (!row || !timingSafeEqual(row.token_hash, hash)) return null;
  return row;
}
