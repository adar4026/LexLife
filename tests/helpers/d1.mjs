/* =========================================================
   tests/helpers/d1.mjs — D1-совместимая обёртка над node:sqlite
   для тестов Worker'а без сети и без Cloudflare.
   Применяет настоящие migrations/*.sql. Каждый вызов уступает
   event loop (как сетевой D1), поэтому параллельные «запуски cron»
   действительно чередуются; batch — одна транзакция, как в D1.
   ========================================================= */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

const MIGRATIONS = new URL('../../migrations/', import.meta.url);
const tick = () => new Promise((r) => setImmediate(r));

export function createD1() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, MIGRATIONS), 'utf8'));

  const check = (args) => args.forEach((a) => { if (a === undefined) throw new Error('D1_TYPE_ERROR: undefined bind'); });
  class Stmt {
    constructor(sql, args = []) { this.sql = sql; this.args = args; }
    bind(...args) { check(args); return new Stmt(this.sql, args); }
    _exec() {
      const s = db.prepare(this.sql);
      if (/^\s*(SELECT|WITH)\b/i.test(this.sql)) return { success: true, results: s.all(...this.args).map((r) => ({ ...r })), meta: {} };
      const r = s.run(...this.args);
      return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    }
    async first(col) { await tick(); const row = db.prepare(this.sql).get(...this.args); if (!row) return null; return col ? row[col] : { ...row }; }
    async all() { await tick(); return this._exec(); }
    async run() { await tick(); return this._exec(); }
  }
  return {
    raw: db,
    prepare: (sql) => new Stmt(sql),
    async batch(stmts) {
      await tick();
      db.exec('BEGIN');
      try { const out = stmts.map((s) => s._exec()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    q: (sql, ...args) => db.prepare(sql).all(...args).map((r) => ({ ...r })),
  };
}
