/* =========================================================
   scripts/build-assets.mjs — собирает dist/ для Cloudflare Static Assets.
   Только явный allowlist файлов приложения. В dist/ никогда не попадут
   private/ (реальные анализы), бэкапы, tests/, docs/, worker/, node_modules/.
   Код копируется без изменений (все пути в приложении относительные), кроме
   двух отметок сборки:
   - build-info.json — версия, commit и время сборки (Настройки → О приложении,
     GET /api/status). В репозитории (GitHub Pages) sha/builtAt = null;
   - sw.js — к CACHE_VERSION дописывается короткий commit: каждый deploy main
     даёт новый sw.js, браузер ставит новый SW, старый кэш удаляется.
   Commit: WORKERS_CI_COMMIT_SHA (Cloudflare Workers Builds) или git HEAD.
   Незакоммиченные изменения → суффикс по хэшу содержимого (+ dirty: true).
   ========================================================= */

import { cpSync, rmSync, mkdirSync, readdirSync, statSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist');
const ALLOW = ['index.html', 'manifest.json', 'build-info.json', 'sw.js', 'css', 'js', 'icons'];
const FORBIDDEN = [/(^|\/)private(\/|$)/, /lexlife-(full-)?backup-[^/]*$/i, /\.lexlife-backup\.json$/i, /\.(zip|env|pem|key)$/i, /(^|\/)\.dev\.vars/, /(^|\/)\./];
const CACHE_RE = /const CACHE_VERSION = '(lexlife-v\d+)';/;

const git = (...args) => { try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT);
for (const p of ALLOW) {
  if (!existsSync(join(ROOT, p))) throw new Error(`build: нет ${p}`);
  cpSync(join(ROOT, p), join(OUT, p), { recursive: true, filter: (src) => !/(^|\/)\.DS_Store$/.test(src) });
}

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full); else files.push(relative(OUT, full));
  }
})(OUT);
const bad = files.filter((f) => FORBIDDEN.some((re) => re.test(f)));
if (bad.length) { rmSync(OUT, { recursive: true, force: true }); throw new Error(`build: запрещённые файлы: ${bad.join(', ')}`); }

/* ---------- отметки сборки ---------- */
const envSha = process.env.WORKERS_CI_COMMIT_SHA || '';
const sha = /^[0-9a-f]{40}$/i.test(envSha) ? envSha.toLowerCase() : (git('rev-parse', 'HEAD') || null);
const dirty = !envSha && git('status', '--porcelain', '--untracked-files=no', '--', ...ALLOW, 'scripts').length > 0;
const appVersion = (readFileSync(join(ROOT, 'js/services/storage.js'), 'utf8').match(/export const APP_VERSION = '([^']+)'/) || [])[1] || null;
const builtAt = new Date().toISOString();

const swPath = join(OUT, 'sw.js');
const sw = readFileSync(swPath, 'utf8');
const m = sw.match(CACHE_RE);
if (!m) { rmSync(OUT, { recursive: true, force: true }); throw new Error('build: в sw.js не найден CACHE_VERSION'); }
let suffix;
if (sha && !dirty) suffix = sha.slice(0, 7);
else {
  const h = createHash('sha256');
  for (const f of files.sort()) if (f !== 'build-info.json') h.update(f).update(readFileSync(join(OUT, f)));
  suffix = `dev${h.digest('hex').slice(0, 7)}`;
}
writeFileSync(swPath, sw.replace(CACHE_RE, `const CACHE_VERSION = '${m[1]}-${suffix}';`));

const info = {
  app: 'lexlife', version: appVersion, sha, dirty, builtAt,
  branch: process.env.WORKERS_CI_BRANCH || git('rev-parse', '--abbrev-ref', 'HEAD') || null,
  source: envSha ? 'workers-builds' : 'local', cache: `${m[1]}-${suffix}`,
};
writeFileSync(join(OUT, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
console.log(`dist/: ${files.length} файлов · ${info.cache}${dirty ? ' (незакоммиченные изменения)' : ''}`);
