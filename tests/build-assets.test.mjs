/* =========================================================
   tests/build-assets.test.mjs — сборка dist/ для Cloudflare:
   allowlist (без private/, tests/, worker/, бэкапов), отметки сборки
   (build-info.json, CACHE_VERSION + commit), полнота предкэша SW
   (все модули приложения доступны офлайн), репозиторий не меняется.

   Запуск:  node tests/build-assets.test.mjs
   ========================================================= */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const build = (env = {}) => execFileSync(process.execPath, [join(ROOT, 'scripts/build-assets.mjs')], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
const list = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? list(join(dir, n)) : [relative(DIST, join(dir, n))]));
const FAKE_SHA = 'abcdef0123456789abcdef0123456789abcdef01';

test('Workers Builds: commit из WORKERS_CI_COMMIT_SHA → build-info.json и CACHE_VERSION', () => {
  const repoSw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const repoInfo = readFileSync(join(ROOT, 'build-info.json'), 'utf8');
  build({ WORKERS_CI_COMMIT_SHA: FAKE_SHA, WORKERS_CI_BRANCH: 'main' });
  const info = JSON.parse(readFileSync(join(DIST, 'build-info.json'), 'utf8'));
  const base = repoSw.match(/const CACHE_VERSION = '(lexlife-v\d+)';/)[1];
  assert.equal(info.sha, FAKE_SHA); assert.equal(info.branch, 'main'); assert.equal(info.source, 'workers-builds'); assert.equal(info.dirty, false);
  assert.match(info.version, /^\d+\.\d+\.\d+$/); assert.ok(!Number.isNaN(Date.parse(info.builtAt)));
  assert.equal(info.cache, `${base}-abcdef0`);
  assert.match(readFileSync(join(DIST, 'sw.js'), 'utf8'), new RegExp(`const CACHE_VERSION = '${base}-abcdef0';`));
  assert.equal(readFileSync(join(ROOT, 'sw.js'), 'utf8'), repoSw, 'sw.js в репозитории не меняется');
  assert.equal(readFileSync(join(ROOT, 'build-info.json'), 'utf8'), repoInfo, 'build-info.json в репозитории не меняется');
  assert.equal(JSON.parse(repoInfo).sha, null, 'в репозитории (GitHub Pages) номера сборки нет');
});

test('allowlist: в dist нет private/, tests/, worker/, docs/, бэкапов, секретов', () => {
  const files = list(DIST);
  for (const f of files) {
    assert.ok(/^(index\.html|manifest\.json|build-info\.json|sw\.js|css\/|js\/|icons\/)/.test(f), `лишний файл ${f}`);
    assert.ok(!/(^|\/)private\/|lexlife-(full-)?backup-|\.lexlife-backup\.json$|\.dev\.vars|\.env$|\.pem$|\.key$|\.zip$/i.test(f), `запрещённый файл ${f}`);
  }
  const text = files.filter((f) => /\.(js|json|html|css)$/.test(f)).map((f) => readFileSync(join(DIST, f), 'utf8')).join('\n');
  assert.ok(!/VAPID_PRIVATE_KEY\s*[=:]\s*["']?[A-Za-z0-9_-]{40}/.test(text), 'нет приватного VAPID-ключа');
});

test('офлайн: каждый модуль приложения в предкэше SW и есть в dist', () => {
  const sw = readFileSync(join(DIST, 'sw.js'), 'utf8');
  const shell = [...sw.matchAll(/^\s+'\.\/([^']*)',$/gm)].map((m) => m[1]);
  for (const f of shell.filter(Boolean)) assert.ok(existsSync(join(DIST, f)), `предкэш ссылается на отсутствующий ${f}`);
  const modules = list(DIST).filter((f) => /^js\/.*\.js$/.test(f));
  for (const f of modules) assert.ok(shell.includes(f), `модуль ${f} не в APP_SHELL — офлайн не откроется`);
  assert.ok(shell.includes('build-info.json'));
});

test('локальная сборка без WORKERS_CI_*: sha из git, суффикс кэша детерминирован', () => {
  const out = build({ WORKERS_CI_COMMIT_SHA: '' });
  const info = JSON.parse(readFileSync(join(DIST, 'build-info.json'), 'utf8'));
  assert.equal(info.source, 'local'); assert.match(info.sha || '', /^[0-9a-f]{40}$/);
  const first = info.cache;
  build({ WORKERS_CI_COMMIT_SHA: '' });
  assert.equal(JSON.parse(readFileSync(join(DIST, 'build-info.json'), 'utf8')).cache, first, 'та же сборка — тот же sw.js (нет лишних обновлений)');
  assert.match(out, /dist\/: \d+ файлов/);
});

let passed = 0; let failed = 0;
for (const t of tests) {
  try { await t.fn(); passed++; console.log(`  ok — ${t.name}`); } catch (err) { failed++; console.log(`  FAIL — ${t.name}\n    ${err && err.stack}`); }
}
console.log(`\n${passed} passed, ${failed} failed (${tests.length} total)`);
process.exit(failed ? 1 : 0);
