# Word Wolf MVP

Room-based Word Wolf web prototype for GitHub Pages + Supabase.

## Supabase Setup

1. Open your Supabase project.
2. Go to SQL Editor.
3. Paste and run `supabase/schema.sql`.
4. Paste and run `supabase/seed_words.sql`.
5. Go to Project Settings > API.
6. Copy `Project URL` and `anon public` key.
7. Paste them into `supabase-config.js`.

```js
window.WORD_WOLF_SUPABASE = {
  url: "https://YOUR_PROJECT.supabase.co",
  anonKey: "YOUR_ANON_PUBLIC_KEY"
};
```

## Word DB

The database structure and word data are intentionally separate.

- `supabase/schema.sql`: tables and game RPC functions
- `supabase/seed_words.sql`: small starter word set
- `supabase/words.sample.csv`: CSV format for bulk import

For a large word list, use Supabase Table Editor > `ww_word_pairs` > Import data from CSV. The CSV columns should be:

```csv
villager,wolf,category
커피,홍차,음료
```

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
- Supabase randomly picks a word pair from the word DB
- Each player privately sees their assigned word
- Players vote for the suspected Word Wolf
- Results reveal the wolf and both words

Rooms are stored in Supabase. Direct table reads are blocked by RLS; the app uses RPC functions so each player only receives their own secret word.
