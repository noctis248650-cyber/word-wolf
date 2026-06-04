const entryPanel = document.querySelector("#entryPanel");
const gamePanel = document.querySelector("#gamePanel");
const playerNameInput = document.querySelector("#playerName");
const roomCodeInput = document.querySelector("#roomCode");
const createRoomBtn = document.querySelector("#createRoomBtn");
const joinRoomBtn = document.querySelector("#joinRoomBtn");
const roomBadge = document.querySelector("#roomBadge");
const playerCount = document.querySelector("#playerCount");
const playersEl = document.querySelector("#players");
const phaseTitle = document.querySelector("#phaseTitle");
const timerEl = document.querySelector("#timer");
const secretWord = document.querySelector("#secretWord");
const categoryText = document.querySelector("#categoryText");
const actionBar = document.querySelector("#actionBar");
const messageEl = document.querySelector("#message");

const config = window.WORD_WOLF_SUPABASE || {};
const hasSupabaseConfig =
  config.url &&
  config.anonKey &&
  !config.url.includes("YOUR_SUPABASE") &&
  !config.anonKey.includes("YOUR_SUPABASE");

const db = hasSupabaseConfig ? window.supabase.createClient(config.url, config.anonKey) : null;

let state = {
  room: null,
  playerId: localStorage.getItem("wordWolfPlayerId") || "",
  pollHandle: null,
  timerHandle: null,
  busy: false
};

function currentPlayer() {
  return state.room?.players.find((player) => player.id === state.playerId) || null;
}

function isHost() {
  return state.room?.hostId === state.playerId;
}

function setMessage(message, isError = false) {
  messageEl.textContent = message || "";
  messageEl.style.color = isError ? "#b42318" : "";
}

function normalizeRpcError(error) {
  if (!error) return "요청에 실패했어요.";
  return error.message?.replace(/^Error:\s*/, "") || "요청에 실패했어요.";
}

async function rpc(name, args = {}) {
  if (!db) {
    throw new Error("Supabase 설정이 필요해요. supabase-config.js에 URL과 anon key를 넣어주세요.");
  }

  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(normalizeRpcError(error));
  return data;
}

function requireName() {
  const name = playerNameInput.value.trim();
  if (!name) {
    playerNameInput.focus();
    throw new Error("아이디를 먼저 입력해주세요.");
  }
  return name;
}

function saveSession(room, playerId) {
  state.room = room;
  state.playerId = playerId;
  localStorage.setItem("wordWolfRoomCode", room.code);
  localStorage.setItem("wordWolfPlayerId", playerId);
}

function startPolling() {
  stopPolling();
  if (!state.room || !state.playerId) return;

  state.pollHandle = window.setInterval(async () => {
    if (state.busy) return;
    try {
      const room = await rpc("ww_get_room_state", {
        p_code: state.room.code,
        p_player_id: state.playerId
      });
      state.room = room;
      render();
    } catch (error) {
      setMessage(error.message, true);
    }
  }, 1200);
}

function stopPolling() {
  if (state.pollHandle) {
    window.clearInterval(state.pollHandle);
    state.pollHandle = null;
  }
}

async function runAction(callback) {
  if (state.busy) return;
  state.busy = true;
  setButtonsDisabled(true);
  try {
    await callback();
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    state.busy = false;
    setButtonsDisabled(false);
  }
}

function setButtonsDisabled(disabled) {
  for (const button of document.querySelectorAll("button")) {
    button.disabled = disabled;
  }
}

function phaseLabel(phase) {
  return {
    lobby: "대기실",
    discussion: "토론 및 투표",
    result: "결과 공개"
  }[phase] || "대기 중";
}

function formatTimer(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function renderTimer() {
  clearInterval(state.timerHandle);
  const endsAt = state.room?.currentGame?.discussionEndsAt;
  if (state.room?.phase !== "discussion" || !endsAt) {
    timerEl.textContent = "--:--";
    return;
  }

  const tick = () => {
    timerEl.textContent = formatTimer(Number(endsAt) - Date.now());
  };
  tick();
  state.timerHandle = setInterval(tick, 500);
}

function renderPlayers() {
  const room = state.room;
  playerCount.textContent = `${room.players.length}명`;
  playersEl.innerHTML = "";

  for (const player of room.players) {
    const row = document.createElement("div");
    row.className = "player-row";

    const meta = document.createElement("div");
    meta.className = "player-meta";

    const name = document.createElement("span");
    name.className = "player-name";
    name.textContent = player.name;
    meta.append(name);

    if (player.id === room.hostId) {
      const host = document.createElement("span");
      host.className = "tag host";
      host.textContent = "방장";
      meta.append(host);
    }

    if (player.id === state.playerId) {
      const me = document.createElement("span");
      me.className = "tag";
      me.textContent = "나";
      meta.append(me);
    }

    row.append(meta);

    if (player.votedFor) {
      const voted = document.createElement("span");
      voted.className = "tag voted";
      voted.textContent = "투표완료";
      row.append(voted);
    }

    playersEl.append(row);
  }
}

function renderSecret() {
  const game = state.room.currentGame;
  if (!game) {
    secretWord.textContent = "게임 시작 전";
    categoryText.textContent = "방장이 시작하면 각자 다른 화면에 비밀 단어가 표시돼요.";
    return;
  }

  if (state.room.phase === "result") {
    const result = game.result;
    const role = game.viewerRole === "wolf" ? "워드울프" : "시민";
    secretWord.textContent = game.viewerWord || "공개됨";
    categoryText.textContent = `내 역할: ${role} · 시민 단어: ${result.words.villager} · 울프 단어: ${result.words.wolf}`;
    return;
  }

  secretWord.textContent = game.viewerWord || "비밀";
  categoryText.textContent = `카테고리: ${game.category} · 이 단어를 직접 말하지 말고 설명으로만 버텨보세요.`;
}

function clearActions() {
  actionBar.innerHTML = "";
}

function addButton(label, className, onClick) {
  const button = document.createElement("button");
  button.textContent = label;
  if (className) button.className = className;
  button.addEventListener("click", onClick);
  actionBar.append(button);
  return button;
}

function renderLobbyActions() {
  if (isHost()) {
    addButton("게임 시작", "primary", () =>
      runAction(async () => {
        state.room = await rpc("ww_start_round", {
          p_code: state.room.code,
          p_player_id: state.playerId
        });
        render();
      })
    );
    setMessage("친구들에게 방 코드를 공유하고, 3명 이상 모이면 시작하세요.");
  } else {
    setMessage("방장이 게임을 시작할 때까지 기다리는 중이에요.");
  }
}

function renderDiscussionActions() {
  const voteList = document.createElement("div");
  voteList.className = "vote-list";
  actionBar.append(voteList);

  for (const player of state.room.players) {
    if (player.id === state.playerId) continue;

    const button = document.createElement("button");
    button.className = "vote-row";
    button.textContent = `${player.name}에게 투표`;
    button.addEventListener("click", () =>
      runAction(async () => {
        state.room = await rpc("ww_vote", {
          p_code: state.room.code,
          p_player_id: state.playerId,
          p_target_id: player.id
        });
        render();
      })
    );
    voteList.append(button);
  }

  if (isHost()) {
    addButton("즉시 결과 공개", "danger", () =>
      runAction(async () => {
        state.room = await rpc("ww_finish_room", {
          p_code: state.room.code,
          p_player_id: state.playerId
        });
        render();
      })
    );
  }

  const voted = currentPlayer()?.votedFor;
  setMessage(voted ? "투표가 반영됐어요. 모두 투표하면 결과가 열립니다." : "토론 후 워드울프라고 생각하는 사람에게 투표하세요.");
}

function renderResultActions() {
  const result = state.room.currentGame?.result;
  if (!result) return;

  const wolfNames = result.wolves
    .map((id) => state.room.players.find((player) => player.id === id)?.name)
    .filter(Boolean)
    .join(", ");
  const eliminatedName = result.eliminatedId
    ? state.room.players.find((player) => player.id === result.eliminatedId)?.name
    : "없음";
  const winnerText = result.winners === "villagers" ? "시민 승리" : "워드울프 승리";

  setMessage(`${winnerText}\n지목된 사람: ${eliminatedName}\n워드울프: ${wolfNames || "없음"}`);

  if (isHost()) {
    addButton("다음 판 준비", "primary", () =>
      runAction(async () => {
        state.room = await rpc("ww_reset_room", {
          p_code: state.room.code,
          p_player_id: state.playerId
        });
        render();
      })
    );
  }
}

function renderActions() {
  clearActions();
  if (state.room.phase === "lobby") renderLobbyActions();
  if (state.room.phase === "discussion") renderDiscussionActions();
  if (state.room.phase === "result") renderResultActions();
}

function render() {
  const room = state.room;
  if (!room) return;

  entryPanel.classList.add("hidden");
  gamePanel.classList.remove("hidden");
  roomBadge.textContent = `방 코드 ${room.code}`;
  phaseTitle.textContent = phaseLabel(room.phase);
  renderPlayers();
  renderSecret();
  renderTimer();
  renderActions();
}

createRoomBtn.addEventListener("click", () =>
  runAction(async () => {
    const data = await rpc("ww_create_room", { p_name: requireName() });
    saveSession(data.room, data.playerId);
    startPolling();
    render();
  })
);

joinRoomBtn.addEventListener("click", () =>
  runAction(async () => {
    const code = roomCodeInput.value.trim().toUpperCase();
    if (!code) throw new Error("방 코드를 입력해주세요.");
    const data = await rpc("ww_join_room", {
      p_code: code,
      p_name: requireName()
    });
    saveSession(data.room, data.playerId);
    startPolling();
    render();
  })
);

roomCodeInput.addEventListener("input", () => {
  roomCodeInput.value = roomCodeInput.value.toUpperCase();
});

if (!hasSupabaseConfig) {
  setMessage("Supabase 설정이 필요해요. supabase-config.js에 Project URL과 anon public key를 넣어주세요.", true);
}
