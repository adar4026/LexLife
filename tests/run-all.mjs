/* =========================================================
   tests/run-all.mjs — все автономные тесты (npm test).
   Каждый файл — отдельный процесс; push-тесты в «чужих» timezone,
   чтобы доказать независимость сервера от TZ процесса.
   ========================================================= */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const run = [
  ['attachments.test.mjs'], ['tests-journal.test.mjs'], ['bottom-nav.test.mjs'], ['water-goal-days.test.mjs'], ['water-import.test.mjs'], ['home-summary.test.mjs'],
  ['notifications.test.mjs'], // сам перебирает 4 timezone
  ['push-worker.test.mjs', 'Asia/Tokyo'],
  ['push-client.test.mjs', 'Europe/Madrid'],
  ['push-client.test.mjs', 'America/New_York'],
  ['build-assets.test.mjs'], // последним: пересобирает dist/
];
let bad = 0;
for (const [file, tz] of run) {
  const env = { ...process.env };
  if (tz) env.TZ = tz;
  const r = spawnSync(process.execPath, [fileURLToPath(new URL(file, import.meta.url))], { env, encoding: 'utf8' });
  const summary = (r.stdout.trim().split('\n').pop() || '').trim();
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'}  ${file}${tz ? ` (TZ=${tz})` : ''} — ${summary}`);
  if (r.status !== 0) { bad++; process.stdout.write(r.stdout.split('\n').filter((l) => /FAIL|Error|assert/i.test(l)).slice(0, 30).join('\n') + '\n' + r.stderr); }
}
process.exit(bad ? 1 : 0);
