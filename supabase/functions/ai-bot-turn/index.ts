const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

type BotAction = "hint" | "vote" | "guess";

type BotTurnRequest = {
  action?: BotAction;
  code?: string;
  hostPlayerId?: string;
  botPlayerId?: string;
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

function validateRequest(request: BotTurnRequest) {
  if (!request.code || !request.hostPlayerId || !request.botPlayerId || !request.action) {
    throw new Error("AI 요청 정보가 부족해요.");
  }
  if (!["hint", "vote", "guess"].includes(request.action)) {
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

async function makeHint(room: RoomState, bot: Player, messages: Array<{ playerName: string; body: string }>) {
  if (room.phase !== "hint" || room.currentGame?.activePlayerId !== bot.id) {
    throw new Error("지금은 이 AI의 힌트 차례가 아니에요.");
  }

  const word = room.currentGame?.viewerWord || "";
  const role = room.currentGame?.viewerRole === "wolf" ? "울프" : "시민";
  const prompt = [
    `너는 워드울프 게임의 ${role} 플레이어 "${bot.name}"이다.`,
    `네 단어: ${word}`,
    `카테고리: ${room.currentGame?.category || "알 수 없음"}`,
    "정답 단어를 직접 말하면 안 된다. 너무 추상적이지 않게, 한 문장 또는 짧은 명사구로 자연스러운 힌트만 제출해라.",
    "출력은 힌트 텍스트만 작성해라."
  ].join("\n");

  const context = [
    `기존 힌트:\n${compactHints(room)}`,
    `최근 채팅:\n${compactMessages(messages)}`
  ].join("\n\n");

  const generated = await askOpenAI(prompt, context, 70);
  return cleanShortText(generated, "일상에서 꽤 자주 접해요", 50);
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
    const messages = await rpc<Array<{ playerName: string; body: string }>>("ww_get_messages", {
      p_code: code,
      p_player_id: botPlayerId
    });

    if (body.action === "hint") {
      const hint = await makeHint(room, bot, messages);
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
