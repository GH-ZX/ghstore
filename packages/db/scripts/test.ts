/**
 * Run the SQL tests against a database that already has the migrations applied.
 * Every test file wraps itself in a transaction and rolls back, so it leaves no data.
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
const sql = postgres(url, { max: 1, prepare: false, onnotice: (n) => console.log(`  ${n.message}`) });
let failed = false;
try {
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".test.sql")).sort()) {
    console.log(file);
    try {
      await sql.unsafe(await readFile(join(dir, file), "utf8"));
    } catch (err) {
      failed = true;
      console.error(`  FAILED: ${(err as Error).message}`);
    }
  }
} finally {
  await sql.end();
}
process.exit(failed ? 1 : 0);
