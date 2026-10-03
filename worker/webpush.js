/* =========================================================
   worker/webpush.js — отправка Web Push без внешних библиотек.
   Только WebCrypto (есть и в Cloudflare Workers, и в Node).
   - VAPID (RFC 8292): JWT ES256, заголовок Authorization: vapid t=…, k=…
   - Шифрование payload (RFC 8291 + RFC 8188, aes128gcm)
   Секреты (VAPID private key, ключи подписки) не логируются.
   ========================================================= */

const enc = new TextEncoder();

export function b64uEncode(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64uDecode(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_\-=\s]*$/.test(str)) throw new Error('bad base64url');
  const s = str.replace(/\s+/g, '').replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/* Ключи подписки: p256dh — несжатая точка P-256 (65 байт, 0x04…), auth — 16 байт */
export function validSubscriptionKeys(p256dh, auth) {
  try {
    const p = b64uDecode(p256dh); const a = b64uDecode(auth);
    return p.length === 65 && p[0] === 4 && a.length === 16;
  } catch { return false; }
}

/* RFC 8291 §3.4: payload → тело запроса aes128gcm.
   opts.asKeyPair / opts.salt — только для тестового вектора RFC. */
export async function encryptPayload(plaintext, p256dhB64u, authB64u, opts = {}) {
  const uaPublic = b64uDecode(p256dhB64u);
  const authSecret = b64uDecode(authB64u);
  const asKeys = opts.asKeyPair || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = opts.salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const data = typeof plaintext === 'string' ? enc.encode(plaintext) : plaintext;
  if (data.length > 3800) throw new Error('payload too large');
  const padded = concat(data, new Uint8Array([2])); // одна запись: разделитель 0x02
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, padded));

  const rs = 4096;
  const header = concat(salt, new Uint8Array([(rs >>> 24) & 255, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255, asPublic.length]), asPublic);
  return concat(header, cipher);
}

/* VAPID: private key — base64url 32 байта (d), public — base64url 65 байт (x, y) */
export async function importVapidKey(publicB64u, privateB64u) {
  const pub = b64uDecode(publicB64u); const d = b64uDecode(privateB64u);
  if (pub.length !== 65 || pub[0] !== 4 || d.length !== 32) throw new Error('VAPID keys have wrong format');
  const jwk = { kty: 'EC', crv: 'P-256', x: b64uEncode(pub.slice(1, 33)), y: b64uEncode(pub.slice(33, 65)), d: b64uEncode(d), ext: false };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/* JWT ES256 для origin push-сервиса (aud). Кэш на время жизни изолята. */
const jwtCache = new Map();
export async function vapidAuthorization(endpoint, vapid, nowMs = Date.now()) {
  const aud = new URL(endpoint).origin;
  const cacheKey = `${aud}|${vapid.publicKey}|${vapid.subject}`;
  const hit = jwtCache.get(cacheKey);
  if (hit && hit.exp - 3600 > nowMs / 1000) return hit.header;
  const exp = Math.floor(nowMs / 1000) + 12 * 3600; // ≤ 24 ч (RFC 8292)
  const head = b64uEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64uEncode(enc.encode(JSON.stringify({ aud, exp, sub: vapid.subject })));
  const key = vapid.key || await importVapidKey(vapid.publicKey, vapid.privateKey);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${body}`)));
  const header = `vapid t=${head}.${body}.${b64uEncode(sig)}, k=${vapid.publicKey}`;
  jwtCache.set(cacheKey, { exp, header });
  return header;
}

/* Хосты push-сервисов браузеров. Запросы на произвольные URL запрещены (SSRF). */
const PUSH_HOSTS = [
  /^web\.push\.apple\.com$/, /^[a-z0-9-]+\.push\.apple\.com$/,
  /^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/, /^push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];
export function isAllowedEndpoint(endpoint, { allowLocal = false } = {}) {
  if (typeof endpoint !== 'string' || endpoint.length > 1024) return false;
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.username || u.password) return false;
  if (allowLocal && u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return true;
  return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some((re) => re.test(u.hostname));
}

/* Отправить push. → { ok, status, kind: 'ok'|'gone'|'retry'|'error' }.
   Сеть недоступна → kind 'retry', status 0. Ничего секретного не возвращается. */
export async function sendWebPush(sub, payload, vapid, { ttl = 600, urgency = 'high', topic, fetchImpl = fetch, nowMs } = {}) {
  const body = await encryptPayload(JSON.stringify(payload), sub.p256dh, sub.auth);
  const headers = {
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(ttl),
    Urgency: urgency,
    Authorization: await vapidAuthorization(sub.endpoint, vapid, nowMs),
  };
  if (topic) headers.Topic = topic; // ≤ 32 символа base64url: push-сервис заменит неотправленный дубль
  let res;
  try {
    res = await fetchImpl(sub.endpoint, { method: 'POST', headers, body });
  } catch {
    return { ok: false, status: 0, kind: 'retry' };
  }
  const status = res.status;
  try { await res.body?.cancel?.(); } catch { /* тело ответа не нужно */ }
  if (status >= 200 && status < 300) return { ok: true, status, kind: 'ok' };
  if (status === 404 || status === 410) return { ok: false, status, kind: 'gone' };
  if (status === 429 || status >= 500) return { ok: false, status, kind: 'retry' };
  return { ok: false, status, kind: 'error' };
}

/* Topic из occurrenceId: SHA-256 → первые 24 байта → 32 символа base64url */
export async function topicFor(occurrenceId) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(occurrenceId)));
  return b64uEncode(h.slice(0, 24));
}

/* Пара VAPID-ключей (для scripts/gen-vapid.mjs и тестов) */
export async function generateVapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  return { publicKey: b64uEncode(pub), privateKey: jwk.d };
}
