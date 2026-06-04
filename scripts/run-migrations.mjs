import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import dns from "node:dns";
import pg from "pg";

dns.setDefaultResultOrder("ipv4first");

const databaseUrl = String(process.env.SUPABASE_DB_URL || "").trim().replace(/^["']|["']$/g, "");
const migrationsDir = process.env.MIGRATIONS_DIR || "supabase/migrations";

if (!databaseUrl) {
  throw new Error("SUPABASE_DB_URL GitHub Secret is missing.");
}

if (!/^postgres(ql)?:\/\//i.test(databaseUrl)) {
  throw new Error("SUPABASE_DB_URL must be a PostgreSQL connection string that starts with postgresql://.");
}

let parsedDatabaseUrl;
try {
  parsedDatabaseUrl = new URL(databaseUrl);
} catch {
  throw new Error("SUPABASE_DB_URL is not a valid URL.");
}

if (parsedDatabaseUrl.hostname.includes("pooler.supabase.com") && parsedDatabaseUrl.username === "postgres") {
  throw new Error(
    "SUPABASE_DB_URL looks like a Supabase pooler URL, but the username is only postgres. For pooler URLs, use the username from Supabase Connect, usually postgres.<project-ref>."
  );
}

const client = new pg.Client({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false }
});

try {
  await client.connect();
} catch (error) {
  if (error.code === "ENETUNREACH" || error.message?.includes("ENETUNREACH")) {
    throw new Error(
      "Could not reach the Supabase database host. If SUPABASE_DB_URL uses db.<project>.supabase.co:5432, replace it with the Transaction pooler connection string from Supabase Connect."
    );
  }
  if (error.code === "28P01") {
    throw new Error(
      "Database password authentication failed. Check that SUPABASE_DB_URL uses the Transaction pooler URI exactly, the pooler username is postgres.<project-ref>, and [YOUR-PASSWORD] was replaced with the database password. If the password contains special characters, URL-encode it or reset it to letters and numbers only."
    );
  }
  throw error;
}

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
