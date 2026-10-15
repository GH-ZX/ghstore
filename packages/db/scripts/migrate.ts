/**
 * Apply SQL migrations in order. Each file runs once, in its own transaction.
 *
 *   DATABASE_URL=postgres://postgres:...@db.<ref>.supabase.co:5432/postgres pnpm db:migrate
 *
 * Use the direct (or session-pooler) connection as the `postgres` user: migrations
 * create the `app` schema, roles and SECURITY DEFINER functions.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL (see .env.example).");
  process.exit(1);
}
const dir = join(import.meta.dirname, "..", "migrations");
const sql = postgres(url, { max: 1, onnotice: () => {}, prepare: false });

try {
  await sql.unsafe(`
    create schema if not exists app;
    create table if not exists app.schema_migrations (name text primary key, applied_at timestamptz not null default now());
  `);
  const done = new Set((await sql<{ name: string }[]>`select name from app.schema_migrations`).map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const body = await readFile(join(dir, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into app.schema_migrations (name) values (${file})`;
    });
    console.log(`applied ${file}`);
  }
  console.log("database is up to date");
} finally {
  await sql.end();
}
