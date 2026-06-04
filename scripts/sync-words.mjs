import { readFile } from "node:fs/promises";

function cleanSecret(value, name) {
  const trimmed = String(value || "").trim().replace(/^["']|["']$/g, "");
  return trimmed.startsWith(`${name}=`) ? trimmed.slice(name.length + 1).trim() : trimmed;
}

const supabaseUrl = cleanSecret(process.env.SUPABASE_URL, "SUPABASE_URL");
const serviceRoleKey = cleanSecret(process.env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY");
const csvPath = process.env.WORDS_CSV_PATH || "supabase/word_pairs.csv";

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error(
    "GitHub Secrets are missing. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Settings > Secrets and variables > Actions."
  );
}

if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl)) {
  throw new Error(
    "SUPABASE_URL must look like https://your-project-ref.supabase.co. Put only the URL value in the GitHub Secret, not SUPABASE_URL=..."
  );
}

function parseCsv(text) {
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      field += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }

  row.push(field);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

function toRecords(csvText) {
  const rows = parseCsv(csvText.trim());
  const [headers, ...body] = rows;
  const expected = ["villager", "wolf", "category"];

  if (!headers || expected.some((name, index) => headers[index]?.trim() !== name)) {
    throw new Error(`CSV header must be: ${expected.join(",")}`);
  }

  return body.map((row, index) => {
    const record = {
      villager: row[0]?.trim(),
      wolf: row[1]?.trim(),
      category: row[2]?.trim()
    };

    if (!record.villager || !record.wolf || !record.category) {
      throw new Error(`Invalid word row at CSV line ${index + 2}.`);
    }

    return record;
  });
}

async function supabaseFetch(path, options = {}) {
  const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}${path}`, {
    ...options,
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const detail = await response.text();
    if (detail.includes("ww_word_pairs") || detail.includes("relation")) {
      throw new Error(
        "Supabase table ww_word_pairs was not found. Run supabase/schema.sql in Supabase SQL Editor first."
      );
    }
    throw new Error(`Supabase request failed: ${response.status} ${detail}`);
  }

  return response;
}

const csvText = await readFile(csvPath, "utf8");
const records = toRecords(csvText);

await supabaseFetch("/rest/v1/ww_word_pairs?id=not.is.null", {
  method: "DELETE",
  headers: { prefer: "return=minimal" }
});

await supabaseFetch("/rest/v1/ww_word_pairs", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    prefer: "return=minimal"
  },
  body: JSON.stringify(records)
});

console.log(`Synced ${records.length} word pairs from ${csvPath}.`);
