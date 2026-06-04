import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const databaseUrl = String(process.env.SUPABASE_DB_URL || "").trim().replace(/^["']|["']$/g, "");
const migrationsDir = process.env.MIGRATIONS_DIR || "supabase/migrations";

if (!databaseUrl) {
  throw new Error("SUPABASE_DB_URL GitHub Secret is missing.");
}

if (!/^postgres(ql)?:\/\//i.test(databaseUrl)) {
  throw new Error("SUPABASE_DB_URL must be a PostgreSQL connection string that starts with postgresql://.");
}

const client = new pg.Client({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false }
});

await client.connect();

try {
  await client.query(`
    create table if not exists ww_schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    );
  `);

  const filenames = (await readdir(migrationsDir))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();

  if (filenames.length === 0) {
    console.log(`No migrations found in ${migrationsDir}.`);
  }

  for (const filename of filenames) {
    const alreadyApplied = await client.query(
      "select 1 from ww_schema_migrations where filename = $1",
      [filename]
    );

    if (alreadyApplied.rowCount) {
      console.log(`Skipping ${filename}; already applied.`);
      continue;
    }

    const sql = await readFile(path.join(migrationsDir, filename), "utf8");
    console.log(`Applying ${filename}...`);

    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into ww_schema_migrations (filename) values ($1)", [filename]);
      await client.query("commit");
      console.log(`Applied ${filename}.`);
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
} finally {
  await client.end();
}
