import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { D1Database, D1PreparedStatement, D1Result } from '../server/types';

/**
 * Minimal D1-compatible wrapper over node:sqlite so the real Hono app, real
 * SQL and real migrations run in tests without a Cloudflare runtime.
 */
export function createLiteD1(): D1Database {
  const db = new DatabaseSync(':memory:');

  const normalize = (params: unknown[]): SQLInputValue[] =>
    params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p) as SQLInputValue);

  const make = (sql: string, params: unknown[]): D1PreparedStatement => {
    const stmt: D1PreparedStatement = {
      bind(...values: unknown[]) {
        return make(sql, values);
      },
      async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        const rows = db.prepare(sql).all(...normalize(params)) as T[];
        return { results: rows, success: true, meta: {} };
      },
      async first<T = Record<string, unknown>>(): Promise<T | null> {
        const rows = db.prepare(sql).all(...normalize(params)) as T[];
        return (rows[0] as T | undefined) ?? null;
      },
      async run(): Promise<D1Result> {
        db.prepare(sql).run(...normalize(params));
        return { results: [], success: true, meta: {} };
      },
    };
    return stmt;
  };

  return {
    prepare(sql: string) {
      return make(sql, []);
    },
    async batch(statements: D1PreparedStatement[]) {
      const out: D1Result[] = [];
      for (const statement of statements) out.push(await statement.run());
      return out;
    },
    async exec(sql: string) {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
}
