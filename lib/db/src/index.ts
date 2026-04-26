import { drizzle } from "drizzle-orm/better-sqlite3";
import Database, { type Database as BetterSqlite3Database } from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import * as schema from "./schema";

function findWorkspaceRoot(start: string): string {
  let dir = start;
  while (true) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

export function resolveDbPath(): string {
  const raw = process.env.DATABASE_URL?.trim();
  if (raw && !/^postgres(ql)?:\/\//i.test(raw)) {
    return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  }
  const root = findWorkspaceRoot(process.cwd());
  return resolve(root, "data", "bot.db");
}

const dbPath = resolveDbPath();
mkdirSync(dirname(dbPath), { recursive: true });

const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });
export const sqliteConnection: BetterSqlite3Database = sqlite;

export * from "./schema";
