import { readFileSync } from "node:fs";

const csvPath = "supabase/word_pairs.csv";
const expectedRows = 200;
const expectedHeader = "villager,wolf,category";

const forbiddenCategories = new Set([
  "색모양",
  "한국지리",
  "계절"
]);

const forbiddenExactWords = new Set([
  "제주",
  "서귀포",
  "RPG",
  "MMORPG",
  "의사",
  "사원",
  "대리",
  "과장",
  "팀장",
  "부장",
  "왕",
  "공주",
  "왕자"
]);

const forbiddenPairs = new Set([
  "아바타/점수",
  "점수/아바타",
  "커피/라테",
  "라테/커피",
  "제주/서귀포",
  "서귀포/제주",
  "RPG/MMORPG",
  "MMORPG/RPG"
]);

const hierarchyPairs = new Set([
  "배/요트",
  "요트/배",
  "캠핑/글램핑",
  "글램핑/캠핑",
  "요리/베이킹",
  "베이킹/요리",
  "게임/보드게임",
  "보드게임/게임",
  "공원/놀이터",
  "놀이터/공원",
  "배송/택배",
  "택배/배송",
  "초밥/회",
  "회/초밥",
  "냉장고/김치냉장고",
  "김치냉장고/냉장고",
  "카메라/렌즈",
  "렌즈/카메라"
]);

const lines = readFileSync(csvPath, "utf8").trim().split(/\r?\n/);
const header = lines.shift();
const rows = lines.map((line, index) => {
  const row = line.split(",");
  if (row.length !== 3 || row.some((value) => !value.trim())) {
    throw new Error(`Invalid row at line ${index + 2}: ${line}`);
  }
  return row.map((value) => value.trim());
});

if (header !== expectedHeader) {
  throw new Error(`CSV header must be ${expectedHeader}`);
}

if (rows.length !== expectedRows) {
  throw new Error(`Expected ${expectedRows} word pairs, got ${rows.length}`);
}

const seen = new Set();
const categoryCounts = new Map();

for (const [villager, wolf, category] of rows) {
  if (villager === wolf) {
    throw new Error(`Word pair cannot use the same word: ${villager}/${wolf}`);
  }

  const key = `${villager}\t${wolf}\t${category}`;
  const reverseKey = `${wolf}\t${villager}\t${category}`;
  if (seen.has(key) || seen.has(reverseKey)) {
    throw new Error(`Duplicate or reversed duplicate pair: ${villager}/${wolf}/${category}`);
  }
  seen.add(key);

  if (forbiddenCategories.has(category)) {
    throw new Error(`Forbidden low-signal category: ${category}`);
  }
  if (forbiddenExactWords.has(villager) || forbiddenExactWords.has(wolf)) {
    throw new Error(`Forbidden exact word: ${villager}/${wolf}/${category}`);
  }
  if (forbiddenPairs.has(`${villager}/${wolf}`) || hierarchyPairs.has(`${villager}/${wolf}`)) {
    throw new Error(`Forbidden or hierarchical pair: ${villager}/${wolf}/${category}`);
  }

  categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
}

for (const [category, count] of categoryCounts) {
  if (count !== 5) {
    throw new Error(`Category ${category} must have exactly 5 pairs, got ${count}`);
  }
}

console.log(`Validated ${rows.length} curated word pairs across ${categoryCounts.size} categories.`);
