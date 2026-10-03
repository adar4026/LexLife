/* =========================================================
   scripts/build-assets.mjs — собирает dist/ для Cloudflare Static Assets.
   Только явный allowlist файлов приложения. В dist/ никогда не попадут
   private/ (реальные анализы), бэкапы, tests/, docs/, worker/, node_modules/.
   Файлы копируются без изменений: GitHub Pages и Cloudflare отдают
   одинаковый код (все пути в приложении относительные).
   ========================================================= */

import { cpSync, rmSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist');
const ALLOW = ['index.html', 'manifest.json', 'sw.js', 'css', 'js', 'icons'];
const FORBIDDEN = [/(^|\/)private(\/|$)/, /lexlife-(full-)?backup-[^/]*$/i, /\.lexlife-backup\.json$/i, /\.(zip|env|pem|key)$/i, /(^|\/)\.dev\.vars/, /(^|\/)\./];

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
console.log(`dist/: ${files.length} файлов`);
