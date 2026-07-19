import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";

export function migrate(database: Database.Database): void {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL
  ) STRICT`);
  const directory = join(dirname(fileURLToPath(import.meta.url)), "migrations");
  const files = readdirSync(directory).filter((name) => /^\d+-.+\.sql$/.test(name)).sort();
  const apply = database.transaction((version: number, name: string, sql: string) => {
    database.exec(sql);
    database.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
      .run(version, name, new Date().toISOString());
  });
  for (const name of files) {
    const version = Number.parseInt(name, 10);
    const exists = database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version);
    if (!exists) apply(version, name, readFileSync(join(directory, name), "utf8"));
  }
}
