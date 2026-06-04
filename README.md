# Word Wolf MVP

Room-based Word Wolf web prototype for GitHub Pages + Supabase.

## Supabase Setup

1. Open your Supabase project.
2. Go to SQL Editor.
3. Paste and run `supabase/schema.sql`.
4. Go to Project Settings > API.
5. Copy `Project URL` and `anon public` key.
6. Paste them into `supabase-config.js`.

```js
window.WORD_WOLF_SUPABASE = {
  url: "https://YOUR_PROJECT.supabase.co",
  anonKey: "YOUR_ANON_PUBLIC_KEY"
};
```

## Word DB

The database structure and word data are intentionally separate.

- `supabase/schema.sql`: tables and game RPC functions
- `supabase/migrations/001_add_test_bots.sql`: adds test AI players to an existing database
- `supabase/word_pairs.csv`: source-of-truth word list
- `.github/workflows/sync-words.yml`: syncs CSV into Supabase
- `scripts/sync-words.mjs`: sync script used by GitHub Actions

The CSV columns should be:

```csv
villager,wolf,category
커피,홍차,음료
```

To let GitHub sync the CSV into Supabase, add these GitHub repository secrets:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_DB_URL`

Use the `service_role` key only as a GitHub secret. Never put it in `supabase-config.js`.
Use `SUPABASE_DB_URL` only as a GitHub secret. It is used by `Run Supabase Migrations`.

If the sync workflow fails, open the failed run > `sync` job > `Sync words to Supabase`.
The Node.js deprecation text is only a warning; the real error is usually below that step.

## Local Run

```powershell
npm start
```

Then open:

```text
http://localhost:4173
```

## GitHub Pages

Upload `index.html`, `app.js`, `styles.css`, and `supabase-config.js` to the GitHub Pages repository root.
Because the app uses relative paths, it can run from a subpath like:

`https://noctis248650-cyber.github.io/word-wolf/`

## Current MVP

- Create a room
- Join with a nickname and room code
- Host starts the round
- Host can add test AI players in the lobby
- Host can make AI players vote randomly during discussion
- Supabase randomly picks a word pair from the word DB
- Each player privately sees their assigned word
- Players vote for the suspected Word Wolf
- Results reveal the wolf and both words

Rooms are stored in Supabase. Direct table reads are blocked by RLS; the app uses RPC functions so each player only receives their own secret word.
