/**
 * Run the SQL tests against a database that already has the migrations applied.
 * Every test file wraps itself in a transaction and rolls back, so it leaves no data,
 * and runs on its own connection, so no session state carries over to the next.
 *
 *   DATABASE_URL=postgres://... pnpm db:test
 *
 * Never point this at production: use a local Postgres or a throwaway project.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL to a TEST database.");
  process.exit(1);
}
const dir = join(import.meta.dirname, "..", "tests");
let failed = false;
for (const file of (await readdir(dir)).filter((f) => f.endsWith(".test.sql")).sort()) {
  console.log(file);
  // A fresh connection per file: a role, search_path or temp table one file sets can not leak into the next.
  const sql = postgres(url, { max: 1, prepare: false, onnotice: (n) => console.log(`  ${n.message}`) });
  try {
    await sql.unsafe(await readFile(join(dir, file), "utf8"));
  } catch (err) {
    failed = true;
    console.error(`  FAILED: ${(err as Error).message}`);
  } finally {
    await sql.end();
  }
}
process.exit(failed ? 1 : 0);
