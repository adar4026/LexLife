/* =========================================================
   tests/helpers/pushService.mjs — тестовый «браузер + push-сервис».
   - makeUserAgent(): ключи подписки (p256dh/auth) как у браузера
   - decrypt(): расшифровка aes128gcm так, как это делает браузер
   - verifyVapid(): проверка JWT ES256 из Authorization
   - createPushServer(): fetch-заглушка push-сервиса с журналом и
     настраиваемыми ответами (201 / 410 / 500 / сеть недоступна)
   ========================================================= */

import { b64uEncode, b64uDecode } from '../../worker/webpush.js';

const enc = new TextEncoder();
const concat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
async function hkdf(salt, ikm, info, n) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, n * 8));
}

export async function makeUserAgent() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { privateKey: kp.privateKey, p256dh: b64uEncode(pub), auth: b64uEncode(auth), pub, authBytes: auth };
}

export async function decrypt(ua, body) {
  const b = new Uint8Array(body);
  const salt = b.slice(0, 16);
  const idlen = b[20];
  const asPub = b.slice(21, 21 + idlen);
  const cipher = b.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
  const ikm = await hkdf(ua.authBytes, secret, concat(enc.encode('WebPush: info\0'), ua.pub, asPub), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, cipher));
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  if (plain[end] !== 2) throw new Error('bad padding delimiter');
  return JSON.parse(new TextDecoder().decode(plain.slice(0, end)));
}

export async function verifyVapid(authorization, publicKeyB64u, endpoint) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(authorization || '');
  if (!m || m[2] !== publicKeyB64u) return null;
  const [h, p, s] = m[1].split('.');
  const pub = b64uDecode(publicKeyB64u);
  const key = await crypto.subtle.importKey('raw', pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64uDecode(s), enc.encode(`${h}.${p}`));
  const claims = JSON.parse(new TextDecoder().decode(b64uDecode(p)));
  return ok && claims.aud === new URL(endpoint).origin ? claims : null;
}

/* responder(endpoint, n) → число (HTTP-статус) или 'network' */
export function createPushServer(responder = () => 201) {
  const log = [];
  const fetchImpl = async (url, init) => {
    const n = log.filter((x) => x.url === url).length;
    const entry = { url, headers: init.headers, body: init.body };
    log.push(entry);
    const r = responder(url, n);
    if (r === 'network') { entry.status = 0; throw new TypeError('fetch failed'); }
    entry.status = r;
    return new Response(null, { status: r });
  };
  return { log, fetchImpl, set(fn) { responder = fn; } };
}
