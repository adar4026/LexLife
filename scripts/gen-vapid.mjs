/* =========================================================
   scripts/gen-vapid.mjs — пара VAPID-ключей (P-256).
   --dev-vars : записать НОВУЮ локальную пару в .dev.vars (в .gitignore)
                и показать только публичный ключ.
   без флагов : вывести JSON { publicKey, privateKey } в stdout — для
                передачи в `wrangler secret put` через pipe, не в терминал.
   Приватный ключ никогда не коммитится и не попадает в wrangler.jsonc.
   ========================================================= */

import { writeFileSync, existsSync } from 'node:fs';
import { generateVapidKeys } from '../worker/webpush.js';

const keys = await generateVapidKeys();
if (process.argv.includes('--dev-vars')) {
  if (existsSync('.dev.vars') && !process.argv.includes('--force')) {
    console.error('.dev.vars уже есть (добавьте --force, чтобы заменить локальную пару)');
    process.exit(1);
  }
  writeFileSync('.dev.vars', [
    '# Локальная разработка (wrangler dev). Не коммитить.',
    `VAPID_PUBLIC_KEY=${keys.publicKey}`,
    `VAPID_PRIVATE_KEY=${keys.privateKey}`,
    'VAPID_SUBJECT=mailto:dev@localhost.invalid',
    'DEV_ALLOW_LOCAL_PUSH=1',
    '',
  ].join('\n'), { mode: 0o600 });
  console.log(`.dev.vars создан. Публичный ключ: ${keys.publicKey}`);
} else {
  process.stdout.write(JSON.stringify(keys));
}
