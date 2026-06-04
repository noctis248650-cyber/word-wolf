const entryPanel = document.querySelector("#entryPanel");
const gamePanel = document.querySelector("#gamePanel");
const playerNameInput = document.querySelector("#playerName");
const roomCodeInput = document.querySelector("#roomCode");
const createRoomBtn = document.querySelector("#createRoomBtn");
const joinRoomBtn = document.querySelector("#joinRoomBtn");
const roomBadge = document.querySelector("#roomBadge");
const leaveRoomBtn = document.querySelector("#leaveRoomBtn");
const playerCount = document.querySelector("#playerCount");
const playersEl = document.querySelector("#players");
const phaseTitle = document.querySelector("#phaseTitle");
const timerEl = document.querySelector("#timer");
const mastTimerEl = document.querySelector("#mastTimer");
const secretCard = document.querySelector("#secretCard");
const secretWord = document.querySelector("#secretWord");
const categoryText = document.querySelector("#categoryText");
const actionBar = document.querySelector("#actionBar");
const messageEl = document.querySelector("#message");
const hintPanel = document.querySelector("#hintPanel");
const activeHintPlayer = document.querySelector("#activeHintPlayer");
const hintList = document.querySelector("#hintList");
const hintForm = document.querySelector("#hintForm");
const hintInput = document.querySelector("#hintInput");
const chatCount = document.querySelector("#chatCount");
const chatLog = document.querySelector("#chatLog");
const chatForm = document.querySelector("#chatForm");
const chatInput = document.querySelector("#chatInput");

const config = window.WORD_WOLF_SUPABASE || {};
const hasSupabaseConfig =
  config.url &&
  config.anonKey &&
  !config.url.includes("YOUR_SUPABASE") &&
  !config.anonKey.includes("YOUR_SUPABASE");

const db = hasSupabaseConfig ? window.supabase.createClient(config.url, config.anonKey) : null;

const botHints = [
  "일상에서 자주 봐요",
  "사람마다 취향이 갈려요",
  "밖에서 많이 접해요",
  "설명하면 바로 떠올라요",
  "비슷한 느낌이 있어요",
  "혼자보다 여럿이 더 재밌어요",
  "어릴 때도 익숙했어요"
];

const botGuesses = [
  "커피",
  "도서관",
  "비행기",
  "피자",
  "수영장",
  "고양이",
  "영화관",
  "초콜릿",
  "바다",
  "축구",
  "마법사",
  "화산",
  "노래방",
  "택배"
];

let state = {
  room: null,
  playerId: localStorage.getItem("wordWolfPlayerId") || "",
  pollHandle: null,
  chatPollHandle: null,
  timerHandle: null,
  busy: false,
  messages: []
};

function currentPlayer() {
  return state.room?.players.find((player) => player.id === state.playerId) || null;
}

function playerById(id) {
  return state.room?.players.find((player) => player.id === id) || null;
}

function playerName(id) {
  return playerById(id)?.name || "알 수 없음";
}

function isHost() {
  return state.room?.hostId === state.playerId;
}

function isActivePlayer() {
  return state.room?.currentGame?.activePlayerId === state.playerId;
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

function clearSession() {
  stopPolling();
  clearInterval(state.timerHandle);
  state.timerHandle = null;
  state.room = null;
  state.playerId = "";
  state.messages = [];
  localStorage.removeItem("wordWolfRoomCode");
  localStorage.removeItem("wordWolfPlayerId");

  gamePanel.classList.add("hidden");
  entryPanel.classList.remove("hidden");
  leaveRoomBtn.classList.add("hidden");
  roomBadge.textContent = "대기 중";
  timerEl.textContent = "--:--";
  mastTimerEl.textContent = "--:--";
  mastTimerEl.classList.add("hidden");
  actionBar.innerHTML = "";
  playerNameInput.focus();
}

function startPolling() {
  stopPolling();
  if (!state.room || !state.playerId) return;

  state.pollHandle = window.setInterval(async () => {
    if (state.busy) return;
    try {
      state.room = await rpc("ww_advance_phase", {
        p_code: state.room.code,
        p_player_id: state.playerId
      });
      render();
    } catch (error) {
      setMessage(error.message, true);
    }
  }, 1200);

  fetchMessages();
  state.chatPollHandle = window.setInterval(fetchMessages, 1800);
}

function stopPolling() {
  if (state.pollHandle) {
    window.clearInterval(state.pollHandle);
    state.pollHandle = null;
  }
  if (state.chatPollHandle) {
    window.clearInterval(state.chatPollHandle);
    state.chatPollHandle = null;
  }
}

async function fetchMessages() {
  if (!state.room || !state.playerId) return;
  try {
    state.messages = await rpc("ww_get_messages", {
      p_code: state.room.code,
      p_player_id: state.playerId
    });
    renderChat();
  } catch {
    // Chat should not interrupt the main game loop.
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
    button.disabled = disabled || button.dataset.keepDisabled === "true";
  }
}

function phaseLabel(phase) {
  return (
    {
      lobby: "대기실",
      reveal: "단어 확인",
      hint: "힌트 라운드",
      discussion: "채팅",
      vote: "투표",
      wolf_guess: "울프 최종 추리",
      result: "결과 공개"
    }[phase] || "대기 중"
  );
}

function formatTimer(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function renderTimer() {
  clearInterval(state.timerHandle);
  const endsAt = state.room?.currentGame?.phaseEndsAt;
  if (!state.room?.currentGame || state.room.phase === "lobby" || state.room.phase === "result" || !endsAt) {
    timerEl.textContent = "--:--";
    mastTimerEl.textContent = "--:--";
    mastTimerEl.classList.add("hidden");
    return;
  }

  const tick = () => {
    const value = formatTimer(Number(endsAt) - Date.now());
    timerEl.textContent = value;
    mastTimerEl.textContent = value;
  };
  mastTimerEl.classList.remove("hidden");
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
    const isHintTurn = player.id === room.currentGame?.activePlayerId && room.phase === "hint";
    const isWolfGuessTurn = player.id === room.currentGame?.activePlayerId && room.phase === "wolf_guess";
    row.classList.toggle("is-hint-turn", isHintTurn);
    row.classList.toggle("is-active-turn", isWolfGuessTurn);

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

    if (player.isBot) {
      const bot = document.createElement("span");
      bot.className = "tag bot";
      bot.textContent = "AI";
      meta.append(bot);
    }

    if (room.phase === "lobby" && player.id !== room.hostId && !player.isBot) {
      const ready = document.createElement("span");
      ready.className = player.ready ? "tag ready" : "tag not-ready";
      ready.textContent = player.ready ? "준비" : "대기";
      meta.append(ready);
    }

    if (player.id === state.playerId) {
      const me = document.createElement("span");
      me.className = "tag";
      me.textContent = "나";
      meta.append(me);
    }

    if (isHintTurn || isWolfGuessTurn) {
      const active = document.createElement("span");
      active.className = "tag active";
      active.textContent = room.phase === "hint" ? "차례" : "추리";
      meta.append(active);
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
  secretCard.classList.toggle("hidden", ["lobby", "discussion"].includes(state.room.phase));

  const game = state.room.currentGame;
  if (!game) {
    secretWord.textContent = "게임 시작 전";
    categoryText.textContent = "방장이 시작하면 각자 화면에 비밀 단어가 표시돼요.";
    return;
  }

  if (state.room.phase === "result") {
    const result = game.result || {};
    const role = game.viewerRole === "wolf" ? "워드울프" : "시민";
    secretWord.textContent = result.winners === "villagers" ? "시민 승리" : "울프 승리";
    categoryText.textContent = `내 역할: ${role} · 시민 단어: ${result.words?.villager || "-"} · 울프 단어: ${
      result.words?.wolf || "-"
    }`;
    return;
  }

  if (state.room.phase === "wolf_guess" && isActivePlayer()) {
    secretWord.textContent = "정답 추리";
    categoryText.textContent = "당신이 울프로 지목됐어요. 시민들의 진짜 단어를 맞히면 울프가 승리합니다.";
    return;
  }

  secretWord.textContent = game.viewerWord || "비밀";
  categoryText.textContent = `카테고리: ${game.category || "-"}`;
}

function renderHintPanel() {
  const game = state.room.currentGame;
  hintPanel.classList.toggle("hidden", !game);
  if (!game) return;

  const hints = Array.isArray(game.hints) ? game.hints : [];
  const activeId = game.activePlayerId;
  const active = playerById(activeId);
  const hasOwnHint = hints.some((hint) => hint.playerId === state.playerId);
  const canSubmit = state.room.phase === "hint" && activeId === state.playerId && !hasOwnHint;

  if (state.room.phase === "hint" && active) {
    activeHintPlayer.textContent = `${active.name} 차례`;
  } else if (hints.length > 0) {
    activeHintPlayer.textContent = `${hints.length}개 제출`;
  } else {
    activeHintPlayer.textContent = "대기";
  }

  hintList.innerHTML = "";
  if (!hints.length) {
    const empty = document.createElement("div");
    empty.className = "hint-item empty";
    empty.textContent = "아직 제출된 힌트가 없어요.";
    hintList.append(empty);
  } else {
    for (const hint of hints) {
      const item = document.createElement("div");
      item.className = "hint-item";

      const name = document.createElement("strong");
      name.textContent = hint.playerName || playerName(hint.playerId);

      const body = document.createElement("span");
      body.textContent = hint.body;

      item.append(name, body);
      hintList.append(item);
    }
  }

  hintInput.disabled = !canSubmit;
  const hintButton = hintForm.querySelector("button");
  hintButton.disabled = !canSubmit;
  hintButton.dataset.keepDisabled = canSubmit ? "false" : "true";
  hintForm.classList.toggle("hidden", state.room.phase !== "hint");
  hintForm.classList.toggle("is-live", canSubmit);
  hintInput.placeholder = canSubmit ? "30초 안에 짧은 힌트 제출" : "내 차례가 되면 입력할 수 있어요";
}

function renderChat() {
  if (chatCount) chatCount.textContent = "";
  chatLog.innerHTML = "";

  if (!state.messages.length) {
    const empty = document.createElement("div");
    empty.className = "chat-empty";
    empty.textContent = "아직 대화가 없어요.";
    chatLog.append(empty);
    return;
  }

  for (const msg of state.messages) {
    const item = document.createElement("div");
    item.className = msg.playerId === state.playerId ? "chat-message me" : "chat-message";

    const name = document.createElement("div");
    name.className = "chat-name";
    name.textContent = msg.playerName || "알 수 없음";

    const body = document.createElement("div");
    body.className = "chat-text";
    body.textContent = msg.body;

    item.append(name, body);
    chatLog.append(item);
  }

  chatLog.scrollTop = chatLog.scrollHeight;
}

function clearActions() {
  actionBar.innerHTML = "";
}

function addButton(label, className, onClick, parent = actionBar) {
  const button = document.createElement("button");
  button.textContent = label;
  if (className) button.className = className;
  button.addEventListener("click", onClick);
  parent.append(button);
  return button;
}

function renderLobbyActions() {
  const waitingPlayers = state.room.players.filter((player) => player.id !== state.room.hostId && !player.isBot);
  const readyCount = waitingPlayers.filter((player) => player.ready).length;
  const allReady = waitingPlayers.length === 0 || readyCount === waitingPlayers.length;

  if (isHost()) {
    addButton("AI 추가", "", () =>
      runAction(async () => {
        state.room = await rpc("ww_add_bot", {
          p_code: state.room.code,
          p_player_id: state.playerId
        });
        render();
      })
    );
    const startButton = addButton("게임 시작", "primary", () =>
      runAction(async () => {
        setMessage("게임을 시작하는 중이에요.");
        state.room = await rpc("ww_start_round", {
          p_code: state.room.code,
          p_player_id: state.playerId
        });
        render();
      })
    );
    startButton.disabled = !allReady;
    startButton.dataset.keepDisabled = allReady ? "false" : "true";
    const readyText = waitingPlayers.length ? `준비 ${readyCount}/${waitingPlayers.length}` : "AI 테스트 모드";
    setMessage(allReady ? `${readyText}. 게임을 시작할 수 있어요.` : `${readyText}. 방장 제외 모두 준비 완료해야 시작할 수 있어요.`);
  } else {
    const ready = Boolean(currentPlayer()?.ready);
    addButton(ready ? "준비 취소" : "준비 완료", ready ? "" : "primary", () =>
      runAction(async () => {
        state.room = await rpc("ww_toggle_ready", {
          p_code: state.room.code,
          p_player_id: state.playerId
        });
        render();
      })
    );
    setMessage(ready ? "준비 완료 상태예요. 시작 전까지 취소할 수 있어요." : "준비가 되면 준비 완료를 눌러주세요.");
  }
}

function renderRevealActions() {
  setMessage("단어 확인 시간입니다. 잠시 후 힌트 라운드가 시작돼요.");
}

function renderHintActions() {
  const active = playerById(state.room.currentGame?.activePlayerId);

  if (active?.isBot && isHost()) {
    addButton("AI 힌트 제출", "primary", () =>
      runAction(async () => {
        const hint = botHints[Math.floor(Math.random() * botHints.length)];
        state.room = await rpc("ww_submit_hint", {
          p_code: state.room.code,
          p_player_id: active.id,
          p_body: hint
        });
        render();
      })
    );
  }

  if (isActivePlayer()) {
    setMessage("지금 당신 차례예요. 힌트 패널에 30초 안에 힌트를 제출하세요.");
  } else {
    setMessage(`${active?.name || "다음 플레이어"}님이 힌트를 제출하는 중이에요. 채팅은 계속 사용할 수 있어요.`);
  }
}

function renderDiscussionActions() {
  setMessage("채팅 시간입니다. 의심점을 이야기하세요. 180초 후 투표로 넘어갑니다.");
}

function renderVoteActions() {
  const voteList = document.createElement("div");
  voteList.className = "vote-list";
  actionBar.append(voteList);

  const alreadyVoted = Boolean(currentPlayer()?.votedFor);
  for (const player of state.room.players) {
    if (player.id === state.playerId) continue;

    const button = document.createElement("button");
    button.className = "vote-row";
    button.textContent = `${player.name}에게 투표`;
    button.disabled = alreadyVoted;
    button.dataset.keepDisabled = alreadyVoted ? "true" : "false";
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

  if (isHost() && state.room.players.some((player) => player.isBot && !player.votedFor)) {
    addButton("AI 투표", "", () =>
      runAction(async () => {
        state.room = await rpc("ww_bot_vote", {
          p_code: state.room.code,
          p_player_id: state.playerId
        });
        render();
      })
    );
  }

  setMessage(alreadyVoted ? "투표가 반영됐어요. 모두 투표하거나 30초가 지나면 결과가 진행됩니다." : "30초 안에 워드울프라고 생각하는 사람에게 투표하세요.");
}

function renderWolfGuessActions() {
  const active = playerById(state.room.currentGame?.activePlayerId);

  if (isActivePlayer()) {
    const form = document.createElement("form");
    form.className = "hint-form";

    const input = document.createElement("input");
    input.maxLength = 40;
    input.placeholder = "시민 단어 입력";

    const submit = document.createElement("button");
    submit.className = "primary";
    submit.type = "submit";
    submit.textContent = "추리";

    form.append(input, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      runAction(async () => {
        state.room = await rpc("ww_submit_wolf_guess", {
          p_code: state.room.code,
          p_player_id: state.playerId,
          p_guess: input.value.trim()
        });
        render();
      });
    });
    actionBar.append(form);
    input.focus();
    setMessage("울프로 지목됐어요. 시민의 진짜 단어를 맞히면 역전 승리입니다.");
    return;
  }

  if (active?.isBot && isHost()) {
    addButton("AI 추리 제출", "primary", () =>
      runAction(async () => {
        const guess = botGuesses[Math.floor(Math.random() * botGuesses.length)];
        state.room = await rpc("ww_submit_wolf_guess", {
          p_code: state.room.code,
          p_player_id: active.id,
          p_guess: guess
        });
        render();
      })
    );
  }

  setMessage(`${active?.name || "울프"}님이 시민 단어를 추리하는 중이에요. 30초 안에 맞히면 울프가 승리합니다.`);
}

function renderResultActions() {
  const result = state.room.currentGame?.result;
  if (!result) return;

  const wolfNames = (result.wolves || [])
    .map((id) => state.room.players.find((player) => player.id === id)?.name)
    .filter(Boolean)
    .join(", ");
  const eliminatedName = result.eliminatedId
    ? state.room.players.find((player) => player.id === result.eliminatedId)?.name
    : "없음";
  const winnerText = result.winners === "villagers" ? "시민 승리" : "울프 승리";
  const reasonText =
    {
      tie: "투표가 갈려서 울프를 잡지 못했어요.",
      vote_missed_wolf: "투표로 울프를 잡지 못했어요.",
      wolf_guessed_word: "울프가 시민 단어를 맞혔어요.",
      wolf_missed_word: "울프를 잡고 최종 추리도 막았어요."
    }[result.reason] || "게임이 종료됐어요.";

  setMessage(`${winnerText}\n${reasonText}\n지목된 사람: ${eliminatedName}\n워드울프: ${wolfNames || "없음"}`);

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
  const renderByPhase = {
    lobby: renderLobbyActions,
    reveal: renderRevealActions,
    hint: renderHintActions,
    discussion: renderDiscussionActions,
    vote: renderVoteActions,
    wolf_guess: renderWolfGuessActions,
    result: renderResultActions
  };
  renderByPhase[state.room.phase]?.();
}

function render() {
  const room = state.room;
  if (!room) return;

  entryPanel.classList.add("hidden");
  gamePanel.classList.remove("hidden");
  leaveRoomBtn.classList.remove("hidden");
  roomBadge.textContent = `방 코드 ${room.code}`;
  phaseTitle.textContent = phaseLabel(room.phase);
  renderPlayers();
  renderSecret();
  renderHintPanel();
  renderTimer();
  renderActions();
  renderChat();
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

leaveRoomBtn.addEventListener("click", () =>
  runAction(async () => {
    const code = state.room?.code;
    const playerId = state.playerId;
    if (code && playerId) {
      try {
        await rpc("ww_leave_room", {
          p_code: code,
          p_player_id: playerId
        });
      } catch {
        // Leaving should still clear this browser even if the room was already gone.
      }
    }
    clearSession();
  })
);

hintForm.addEventListener("submit", (event) => {
  event.preventDefault();
  runAction(async () => {
    const body = hintInput.value.trim();
    if (!body) return;
    state.room = await rpc("ww_submit_hint", {
      p_code: state.room.code,
      p_player_id: state.playerId,
      p_body: body
    });
    hintInput.value = "";
    render();
  });
});

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  runAction(async () => {
    const body = chatInput.value.trim();
    if (!body) return;

    state.messages = await rpc("ww_send_message", {
      p_code: state.room.code,
      p_player_id: state.playerId,
      p_body: body
    });
    chatInput.value = "";
    renderChat();
  });
});

async function restoreSession() {
  const code = localStorage.getItem("wordWolfRoomCode");
  if (!code || !state.playerId || !hasSupabaseConfig) return;

  try {
    state.room = await rpc("ww_advance_phase", {
      p_code: code,
      p_player_id: state.playerId
    });
    startPolling();
    render();
  } catch {
    localStorage.removeItem("wordWolfRoomCode");
    localStorage.removeItem("wordWolfPlayerId");
    state.playerId = "";
  }
}

if (!hasSupabaseConfig) {
  setMessage("Supabase 설정이 필요해요. supabase-config.js에 Project URL과 anon public key를 넣어주세요.", true);
} else {
  restoreSession();
}
