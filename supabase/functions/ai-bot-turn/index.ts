const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

type BotAction = "hint" | "vote" | "guess" | "chat";

type BotTurnRequest = {
  action?: BotAction;
  code?: string;
  hostPlayerId?: string;
  botPlayerId?: string;
  triggerMessageId?: number;
};

type Player = {
  id: string;
  name: string;
  isBot?: boolean;
  votedFor?: boolean;
};

type Hint = {
  playerId: string;
  playerName: string;
  body: string;
};

type RoomState = {
  code: string;
  hostId: string;
  phase: string;
  players: Player[];
  currentGame?: {
    category?: string;
    activePlayerId?: string | null;
    hints?: Hint[];
    votes?: Record<string, string>;
    viewerWord?: string;
    viewerRole?: "wolf" | "villager";
  } | null;
};

type Message = {
  id: number;
  playerId: string;
  playerName: string;
  body: string;
  createdAt: number;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

function getServiceKey() {
  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeys) {
    try {
      const parsed = JSON.parse(secretKeys);
      if (parsed?.default) return parsed.default;
    } catch {
      // Fall back to legacy env below.
    }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
}

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = getServiceKey();
const openaiKey = Deno.env.get("OPENAI_API_KEY") || "";

async function rpc<T>(name: string, payload: Record<string, unknown>): Promise<T> {
  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Supabase Edge Function 기본 secret을 찾을 수 없어요.");
  }

  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data?.message || `${name} 호출에 실패했어요.`);
  }
  return data as T;
}

function playerName(room: RoomState, id?: string | null) {
  return room.players.find((player) => player.id === id)?.name || "알 수 없음";
}

function compactMessages(messages: Array<{ playerName: string; body: string }>) {
  return messages
    .slice(-18)
    .map((message) => `${message.playerName}: ${message.body}`)
    .join("\n") || "아직 채팅 없음";
}

function compactHints(room: RoomState) {
  const hints = room.currentGame?.hints || [];
  return hints.map((hint) => `${hint.playerName}: ${hint.body}`).join("\n") || "아직 힌트 없음";
}

function extractText(response: any) {
  if (typeof response?.output_text === "string") return response.output_text.trim();

  for (const output of response?.output || []) {
    for (const content of output?.content || []) {
      if (typeof content?.text === "string") return content.text.trim();
    }
  }
  return "";
}

function cleanShortText(text: string, fallback: string, maxLength = 40) {
  const cleaned = text
    .replace(/```(?:json)?/g, "")
    .replace(/["{}[\]]/g, "")
    .replace(/^(힌트|답|추리|투표|선택)\s*[:：-]\s*/i, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0] || fallback;

  return cleaned.slice(0, maxLength).trim() || fallback;
}

function normalizeKeyword(text: string) {
  return String(text || "").toLowerCase().replace(/\s+/g, "");
}

function containsKeyword(text: string, keywords: string[]) {
  const normalizedText = normalizeKeyword(text);
  return keywords
    .map(normalizeKeyword)
    .filter((keyword) => keyword.length >= 2)
    .some((keyword) => normalizedText.includes(keyword));
}

async function askOpenAI(instructions: string, input: string, maxOutputTokens = 90) {
  if (!openaiKey) {
    throw new Error("OPENAI_API_KEY Edge Function secret이 없어요.");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      instructions,
      input,
      max_output_tokens: maxOutputTokens,
      temperature: 0.8
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || "OpenAI 응답 생성에 실패했어요.");
  }

  return extractText(data);
}

async function loadBotRoom(code: string, botPlayerId: string) {
  return await rpc<RoomState>("ww_get_room_state", {
    p_code: code,
    p_player_id: botPlayerId
  });
}

async function loadViewerRoom(code: string, viewerPlayerId: string) {
  return await rpc<RoomState>("ww_get_room_state", {
    p_code: code,
    p_player_id: viewerPlayerId
  });
}

async function loadForbiddenWords(code: string) {
  if (!supabaseUrl || !supabaseKey) return [];

  const response = await fetch(
    `${supabaseUrl}/rest/v1/ww_rooms?code=eq.${encodeURIComponent(code)}&select=current_game`,
    {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`
      }
    }
  );

  if (!response.ok) return [];

  const rows = await response.json();
  const pair = rows?.[0]?.current_game?.pair || {};
  return [pair.villager, pair.wolf].filter((word) => typeof word === "string" && word.trim());
}

function validateRequest(request: BotTurnRequest) {
  if (!request.code || !request.hostPlayerId || !request.botPlayerId || !request.action) {
    throw new Error("AI 요청 정보가 부족해요.");
  }
  if (!["hint", "vote", "guess", "chat"].includes(request.action)) {
    throw new Error("지원하지 않는 AI 행동이에요.");
  }
}

function validateBotControl(room: RoomState, hostPlayerId: string, botPlayerId: string) {
  if (room.hostId !== hostPlayerId) {
    throw new Error("방장만 AI를 실행할 수 있어요.");
  }

  const bot = room.players.find((player) => player.id === botPlayerId);
  if (!bot?.isBot) {
    throw new Error("AI 플레이어를 찾을 수 없어요.");
  }
  return bot;
}

async function makeHint(
  room: RoomState,
  bot: Player,
  messages: Array<{ playerName: string; body: string }>,
  forbiddenKeywords: string[]
) {
  if (room.phase !== "hint" || room.currentGame?.activePlayerId !== bot.id) {
    throw new Error("지금은 이 AI의 힌트 차례가 아니에요.");
  }

  const word = room.currentGame?.viewerWord || "";
  const role = room.currentGame?.viewerRole === "wolf" ? "울프" : "시민";
  const forbiddenWords = Array.from(new Set([word, ...forbiddenKeywords].filter(Boolean)));
  const villagerHintFallbacks = ["먼 길 여행", "오래된 취향", "낯선 가게", "조용한 오후", "먼지 낀 선반"];
  const wolfHintFallbacks = ["어디선가 본 느낌", "살짝 비슷한 결", "말하기 애매함", "기억의 주변부", "익숙한 분위기"];
  const prompt = [
    `너는 워드울프 게임의 ${role} 플레이어 "${bot.name}"이다.`,
    `네 단어: ${word}`,
    `카테고리: ${room.currentGame?.category || "알 수 없음"}`,
    "힌트는 정답의 사전적 특징을 바로 설명하지 말고, 한 단계 떨어진 넓은 연상으로 제출해라.",
    "좋은 힌트는 문화, 장소, 경험, 브랜드명, 말장난, 간접 이미지, 분위기, 용도 주변부처럼 범주가 큰 단서다.",
    "예를 들어 선인장이라면 '가시가 많은 식물'보다 '카레', '사막 여행', '건조한 창가'처럼 한 다리 건너뛴 연상도 가능하다.",
    "단, 너무 무관하거나 랜덤하면 안 된다. 나중에 설명하면 그럴듯하게 연결될 정도여야 한다.",
    "절대 금지: 네 단어를 힌트에 그대로 쓰기, 네 단어의 일부 글자를 포함하기, 상대 단어를 그대로 쓰기, 상대 단어의 일부 글자를 포함하기.",
    "금지: 정답의 동의어, 상하위어, 너무 직접적인 생김새/서식지/기능 설명.",
    "출력은 3~12글자 정도의 짧은 힌트 텍스트만 작성해라."
  ].join("\n");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const context = [
      `기존 힌트:\n${compactHints(room)}`,
      `최근 채팅:\n${compactMessages(messages)}`,
      attempt > 0 ? `이전 답변에 금지 단어가 포함됐다. 이번에는 "${forbiddenWords.join(", ")}"의 글자를 절대 포함하지 마라.` : ""
    ].filter(Boolean).join("\n\n");

    const generated = await askOpenAI(prompt, context, 80);
    const hint = cleanShortText(generated, "오래 보면 떠올라요", 30);
    if (!containsKeyword(hint, forbiddenWords)) return hint;
  }

  const fallbackPool = role === "시민" ? villagerHintFallbacks : wolfHintFallbacks;
  return fallbackPool[Math.floor(Math.random() * fallbackPool.length)];
}

async function chooseVote(room: RoomState, bot: Player, messages: Array<{ playerName: string; body: string }>) {
  if (room.phase !== "vote") {
    throw new Error("지금은 투표 시간이 아니에요.");
  }
  if (bot.votedFor || room.currentGame?.votes?.[bot.id]) {
    throw new Error(`${bot.name}은 이미 투표했어요.`);
  }

  const candidates = room.players.filter((player) => player.id !== bot.id);
  const candidateList = candidates.map((player) => `${player.id}: ${player.name}`).join("\n");
  const prompt = [
    `너는 워드울프 게임 플레이어 "${bot.name}"이다.`,
    `네 단어: ${room.currentGame?.viewerWord || "알 수 없음"}`,
    `네 역할: ${room.currentGame?.viewerRole === "wolf" ? "울프" : "시민"}`,
    "힌트와 채팅을 보고 워드울프일 가능성이 가장 높은 사람 하나를 골라라.",
    "반드시 후보 ID 하나만 출력해라. 이름이나 이유를 쓰지 마라."
  ].join("\n");

  const context = [
    `후보:\n${candidateList}`,
    `힌트:\n${compactHints(room)}`,
    `최근 채팅:\n${compactMessages(messages)}`
  ].join("\n\n");

  const generated = await askOpenAI(prompt, context, 40);
  const picked = candidates.find((player) => generated.includes(player.id)) ||
    candidates.find((player) => generated.includes(player.name)) ||
    candidates[Math.floor(Math.random() * candidates.length)];

  return picked;
}

async function guessWord(room: RoomState, bot: Player, messages: Array<{ playerName: string; body: string }>) {
  if (room.phase !== "wolf_guess" || room.currentGame?.activePlayerId !== bot.id) {
    throw new Error("지금은 이 AI의 최종 추리 차례가 아니에요.");
  }

  const prompt = [
    `너는 워드울프 게임에서 지목된 울프 "${bot.name}"이다.`,
    `네가 받은 울프 단어: ${room.currentGame?.viewerWord || "알 수 없음"}`,
    `카테고리: ${room.currentGame?.category || "알 수 없음"}`,
    "시민들이 가진 진짜 단어를 맞혀야 한다.",
    "출력은 추리한 단어 하나만 작성해라. 설명하지 마라."
  ].join("\n");

  const context = [
    `힌트:\n${compactHints(room)}`,
    `최근 채팅:\n${compactMessages(messages)}`
  ].join("\n\n");

  const generated = await askOpenAI(prompt, context, 40);
  return cleanShortText(generated, "모르겠음", 30);
}

async function makeChatReply(room: RoomState, bot: Player, messages: Message[], triggerMessageId?: number) {
  const triggerMessage = messages.find((message) => message.id === triggerMessageId) || messages[messages.length - 1];
  if (!triggerMessage) {
    throw new Error("답변할 채팅이 없어요.");
  }
  if (triggerMessage.playerId === bot.id) {
    throw new Error("자기 메시지에는 답하지 않아요.");
  }

  const prompt = [
    `너는 워드울프 게임에 참여 중인 AI 플레이어 "${bot.name}"이다.`,
    `현재 단계: ${room.phase}`,
    `네 단어: ${room.currentGame?.viewerWord || "게임 시작 전"}`,
    `네 역할: ${room.currentGame?.viewerRole === "wolf" ? "울프" : room.currentGame?.viewerRole === "villager" ? "시민" : "대기 중"}`,
    "방금 메시지에 직접 반응해라. 질문이면 질문에 답하고, 의견이면 그 의견에 이어서 말해라.",
    "친구 채팅방처럼 1문장으로 짧고 자연스럽게 답해라.",
    "뜬금없는 새 화제를 꺼내지 마라. 최근 채팅보다 방금 메시지를 우선해라.",
    "정답 단어를 직접 공개하지 말고, 힌트 단계에서도 너무 노골적인 단어는 피하라.",
    "출력은 채팅 메시지 한 줄만 작성해라."
  ].join("\n");

  const context = [
    `방금 메시지: ${triggerMessage.playerName}: ${triggerMessage.body}`,
    `힌트:\n${compactHints(room)}`,
    `최근 채팅:\n${compactMessages(messages)}`
  ].join("\n\n");

  const generated = await askOpenAI(prompt, context, 90);
  return cleanShortText(generated, "음... 그럴 수도 있겠네", 90);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = (await request.json()) as BotTurnRequest;
    validateRequest(body);

    const code = body.code!.toUpperCase().trim();
    const hostPlayerId = body.hostPlayerId!;
    const botPlayerId = body.botPlayerId!;
    const room = await loadBotRoom(code, botPlayerId);
    const bot = validateBotControl(room, hostPlayerId, botPlayerId);
    const messages = await rpc<Message[]>("ww_get_messages", {
      p_code: code,
      p_player_id: botPlayerId
    });

    if (body.action === "chat") {
      const reply = await makeChatReply(room, bot, messages, body.triggerMessageId);
      await rpc<Message[]>("ww_send_message", {
        p_code: code,
        p_player_id: bot.id,
        p_body: reply
      });
      const viewerRoom = await loadViewerRoom(code, hostPlayerId);
      return jsonResponse({ room: viewerRoom, text: reply });
    }

    if (body.action === "hint") {
      const forbiddenWords = await loadForbiddenWords(code);
      const hint = await makeHint(room, bot, messages, forbiddenWords);
      const updatedRoom = await rpc<RoomState>("ww_submit_hint", {
        p_code: code,
        p_player_id: bot.id,
        p_body: hint
      });
      const viewerRoom = await loadViewerRoom(code, hostPlayerId);
      return jsonResponse({ room: viewerRoom || updatedRoom, text: hint });
    }

    if (body.action === "vote") {
      const target = await chooseVote(room, bot, messages);
      const updatedRoom = await rpc<RoomState>("ww_vote", {
        p_code: code,
        p_player_id: bot.id,
        p_target_id: target.id
      });
      const viewerRoom = await loadViewerRoom(code, hostPlayerId);
      return jsonResponse({ room: viewerRoom || updatedRoom, targetId: target.id, text: `${bot.name} -> ${target.name}` });
    }

    const guess = await guessWord(room, bot, messages);
    const updatedRoom = await rpc<RoomState>("ww_submit_wolf_guess", {
      p_code: code,
      p_player_id: bot.id,
      p_guess: guess
    });
    const viewerRoom = await loadViewerRoom(code, hostPlayerId);
    return jsonResponse({ room: viewerRoom || updatedRoom, text: guess });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "AI 실행에 실패했어요." });
  }
});
