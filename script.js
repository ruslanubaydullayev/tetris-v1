const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
const nextCanvas = document.getElementById("nextCanvas");
const nextCtx = nextCanvas.getContext("2d");
const scoreValue = document.getElementById("scoreValue");
const overlay = document.getElementById("overlay");
const overlayTitle = document.getElementById("overlayTitle");
const overlayMessage = document.getElementById("overlayMessage");
const restartButton = document.getElementById("restartButton");
const goToMenuButton = document.getElementById("goToMenuButton");
const overlayPlayButton = document.getElementById("overlayPlayButton");
const gameTitle = document.getElementById("gameTitle");
const controlsList = document.getElementById("controlsList");
const dashboard = document.getElementById("dashboard");
const gameScreen = document.getElementById("gameScreen");
const playGameButton = document.getElementById("playGameButton");
const backToDashboardButton = document.getElementById("backToDashboardButton");
const enableNotificationsButton = document.getElementById("enableNotificationsButton");
const dashMenuLevel = document.getElementById("dashMenuLevel");
const dashCurrentLevel = document.getElementById("dashCurrentLevel");
const dashCurrentScore = document.getElementById("dashCurrentScore");
const dashCurrentLines = document.getElementById("dashCurrentLines");
const playLevelValue = document.getElementById("playLevelValue");
const playLinesValue = document.getElementById("playLinesValue");
const highScoreList = document.getElementById("highScoreList");
const gameToast = document.getElementById("gameToast");
const mLeft = document.getElementById("mLeft");
const mRight = document.getElementById("mRight");
const mRotate = document.getElementById("mRotate");
const mSoftDrop = document.getElementById("mSoftDrop");
const mHardDrop = document.getElementById("mHardDrop");
const mPause = document.getElementById("mPause");
const mRestart = document.getElementById("mRestart");
const nameModal = document.getElementById("nameModal");
const nameForm = document.getElementById("nameForm");
const nameModalGoToMenuButton = document.getElementById("nameModalGoToMenuButton");
const playerNameInput = document.getElementById("playerNameInput");
const nameError = document.getElementById("nameError");
const nameModalScore = document.getElementById("nameModalScore");

const activeState = {
  mode: "blocks",
  score: 0,
  paused: false,
  gameOver: false,
};

const modes = {};
let loopId = null;
let lastFrameTime = 0;
const HIGH_SCORE_KEY = "tetrisNBlockHighScores";
let toastTimeoutId = null;
let pendingGameOverMessage = "";

let leftHoldTimer = null;
let rightHoldTimer = null;
let softDropHoldTimer = null;
const HOLD_REPEAT_MS = 85;

// Leaderboard API (Tetris)
const API_BASE_URL = "https://activus.pythonanywhere.com";
const LAST_SYNCED_USERNAME_KEY = "tetrisNBlockLastSyncedUsername";
const LAST_REMINDER_NOTIFICATION_AT_KEY = "tetrisNBlockLastReminderNotificationAt";
const REMINDER_COOLDOWN_MS = 1000 * 60 * 60 * 24; // once per day

function normalizeUsername(username) {
  const s = String(username ?? "").trim();
  return s ? s.slice(0, 16).toUpperCase() : "PLAYER";
}

function normalizeScoreNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

function notificationsSupported() {
  return "Notification" in window;
}

async function registerServiceWorkerIfPossible() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register("./sw.js");
    return reg;
  } catch (err) {
    console.warn("Service worker registration failed:", err);
    return null;
  }
}

async function requestNotificationPermission() {
  if (!notificationsSupported()) return "unsupported";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  try {
    return await Notification.requestPermission();
  } catch {
    // Safari sometimes throws; treat as denied.
    return "denied";
  }
}

async function sendReminderNotification() {
  if (!notificationsSupported()) return false;
  if (Notification.permission !== "granted") return false;

  const now = Date.now();
  const lastAt = Number(localStorage.getItem(LAST_REMINDER_NOTIFICATION_AT_KEY) || 0);
  if (now - lastAt < REMINDER_COOLDOWN_MS) return false;

  const message = "Hey, don't you want beat record today?";

  // Prefer SW notifications when available.
  const reg = await registerServiceWorkerIfPossible();
  if (reg && reg.showNotification) {
    await reg.showNotification("Tetris", {
      body: message,
      tag: "tetris-reminder",
      renotify: false,
    });
  } else {
    new Notification("Tetris", { body: message });
  }

  localStorage.setItem(LAST_REMINDER_NOTIFICATION_AT_KEY, String(now));
  return true;
}

function updateNotificationsButtonUi() {
  if (!enableNotificationsButton) return;
  if (!notificationsSupported()) {
    enableNotificationsButton.textContent = "Notifications not supported";
    enableNotificationsButton.disabled = true;
    return;
  }
  const p = Notification.permission;
  if (p === "granted") {
    enableNotificationsButton.textContent = "Notifications enabled";
    enableNotificationsButton.disabled = true;
  } else if (p === "denied") {
    enableNotificationsButton.textContent = "Notifications blocked";
    enableNotificationsButton.disabled = true;
  } else {
    enableNotificationsButton.textContent = "Enable notifications";
    enableNotificationsButton.disabled = false;
  }
}

async function apiJson(path, options = {}) {
  const { method = "GET", body = undefined } = options;

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `API request failed: ${method} ${path} (${res.status}) ${text}`
    );
  }

  return res.json();
}

async function apiEnsureUser(username) {
  try {
    return await apiJson("/api/users", { method: "POST", body: { username } });
  } catch (err) {
    const message = String(err?.message || "");
    // Existing user is okay; we only need the user to exist before posting score.
    if (message.includes("(409)") || /already exists/i.test(message)) {
      return { username, exists: true };
    }
    throw err;
  }
}

async function apiPostScore(username, score) {
  return apiJson("/api/scores", { method: "POST", body: { username, score } });
}

async function apiFetchTopScores(limit = 10) {
  return apiJson(`/api/scores/top?limit=${encodeURIComponent(limit)}`);
}

async function apiFetchUserBest(username) {
  return apiJson(
    `/api/users/${encodeURIComponent(username)}/best`
  );
}

async function apiFetchUserScores(username, limit = 20) {
  return apiJson(
    `/api/users/${encodeURIComponent(username)}/scores?limit=${encodeURIComponent(
      limit
    )}`
  );
}

function renderHighScoresFromApiResults(results) {
  if (!highScoreList) return;

  const filled = (Array.isArray(results) ? results : [])
    .slice(0, 10)
    .map((item) => {
      const u = item?.username ?? item?.user ?? item?.name ?? "PLAYER";
      const bestScore = item?.bestScore ?? item?.score ?? item?.value ?? 0;
      return {
        name: normalizeUsername(u),
        score: normalizeScoreNumber(bestScore),
      };
    });

  const padded = filled.concat(
    Array.from({ length: Math.max(0, 10 - filled.length) }, () => ({
      name: "---",
      score: 0,
    }))
  );

  highScoreList.innerHTML = padded
    .slice(0, 10)
    .map((s) => `<li>${s.name} - ${s.score}</li>`)
    .join("");
}

let leaderboardRefreshRequestId = 0;

function showLeaderboardLoading() {
  if (!highScoreList) return;
  highScoreList.innerHTML = Array.from({ length: 10 }, () => "<li>Loading...</li>").join(
    ""
  );
}

async function refreshLeaderboardFromApi(limit = 10) {
  const requestId = ++leaderboardRefreshRequestId;
  showLeaderboardLoading();

  try {
    const data = await apiFetchTopScores(limit);
    if (requestId !== leaderboardRefreshRequestId) return;
    renderHighScoresFromApiResults(data?.results ?? []);
  } catch (err) {
    console.warn("Failed to refresh leaderboard from API:", err);
    if (requestId !== leaderboardRefreshRequestId) return;
    // Local fallback if API is down.
    renderHighScores();
  }
}

async function syncUserScoreWithApi(username, score) {
  // Spec-listed order: ensure user, post score, then fetch best & history.
  await apiEnsureUser(username);
  const postRes = await apiPostScore(username, score);
  const bestRes = await apiFetchUserBest(username);
  const scoresRes = await apiFetchUserScores(username, 20);

  const bestScore = normalizeScoreNumber(
    bestRes?.bestScore ?? postRes?.bestScore
  );
  const historyScores = Array.isArray(scoresRes?.history)
    ? scoresRes.history.map((h) => normalizeScoreNumber(h?.score))
    : [];

  return { bestScore, historyScores };
}

function gameIsInteractive() {
  if (!gameScreen || gameScreen.classList.contains("hidden")) return false;
  if (!nameModal || !nameModal.hidden) return false;
  return true;
}

function dispatchTetrisKey(key) {
  if (!gameIsInteractive()) return;
  if (activeState.paused || activeState.gameOver) return;
  const game = modes[activeState.mode];
  if (!game || !game.onKey) return;
  // Some onKey branches expect event.preventDefault()
  game.onKey(key, { preventDefault: () => {} });
}

function startHold(timerRef, key) {
  if (timerRef) clearInterval(timerRef);
  const id = setInterval(() => {
    dispatchTetrisKey(key);
  }, HOLD_REPEAT_MS);
  return id;
}

function stopHold(timerRef) {
  if (timerRef) clearInterval(timerRef);
}

const TETRIS = {
  COLS: 10,
  ROWS: 20,
  BASE_SPEED: 600,
  SHAPES: {
    I: [[0, -1], [0, 0], [0, 1], [0, 2]],
    O: [[0, 0], [1, 0], [0, 1], [1, 1]],
    T: [[0, 0], [-1, 0], [1, 0], [0, 1]],
    L: [[0, -1], [0, 0], [0, 1], [1, 1]],
    J: [[0, -1], [0, 0], [0, 1], [-1, 1]],
    S: [[0, 0], [1, 0], [0, 1], [-1, 1]],
    Z: [[0, 0], [-1, 0], [0, 1], [1, 1]],
  },
  COLORS: {
    I: "#38bdf8",
    O: "#fbbf24",
    T: "#a855f7",
    L: "#fb923c",
    J: "#60a5fa",
    S: "#22c55e",
    Z: "#ef4444",
  },
};

function resizeCanvasForGrid(cols, rows) {
  // Use HiDPI bitmap sizing while keeping integer cell sizes to avoid
  // fractional-pixel artifacts (which can make blocks look misaligned).
  const dpr = Math.max(1, window.devicePixelRatio || 1);

  const rect = canvas.getBoundingClientRect();
  const displayWidth = rect.width && rect.width > 0 ? rect.width : 200;

  const cellBitmapPx = Math.max(1, Math.round((displayWidth * dpr) / cols));
  const targetBitmapWidth = cellBitmapPx * cols;
  const targetBitmapHeight = cellBitmapPx * rows;

  canvas.width = targetBitmapWidth;
  canvas.height = targetBitmapHeight;

  // Prevent CSS scaling blur/distortion by matching CSS size to the bitmap.
  canvas.style.display = "block";
  canvas.style.marginLeft = "auto";
  canvas.style.marginRight = "auto";
  canvas.style.width = `${targetBitmapWidth / dpr}px`;
  canvas.style.height = `${targetBitmapHeight / dpr}px`;
}

function updateScore(value) {
  activeState.score = value;
  scoreValue.textContent = String(value);
  dashCurrentScore.textContent = String(value);
}

function updateDashboardStats(level, score, lines) {
  dashCurrentLevel.textContent = String(level);
  dashCurrentScore.textContent = String(score);
  dashCurrentLines.textContent = String(lines);
  playLevelValue.textContent = String(level);
  playLinesValue.textContent = String(lines);
}

function readHighScores() {
  try {
    const raw = localStorage.getItem(HIGH_SCORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        if (typeof item === "number") {
          return { name: "PLAYER", score: item };
        }
        return {
          name: String(item?.name || "PLAYER"),
          score: Number(item?.score) || 0,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
  } catch {
    return [];
  }
}

function renderHighScores() {
  const scores = readHighScores();
  const filled = scores.concat(
    Array.from({ length: Math.max(0, 10 - scores.length) }, () => ({
      name: "---",
      score: 0,
    }))
  );
  highScoreList.innerHTML = filled
    .slice(0, 10)
    .map((s) => `<li>${s.name} - ${s.score}</li>`)
    .join("");
}

function openNameModal(score, message) {
  pendingGameOverMessage = message;
  nameModalScore.textContent = String(score);
  nameError.hidden = true;
  playerNameInput.value = localStorage.getItem(LAST_SYNCED_USERNAME_KEY) || "";
  nameModal.hidden = false;
  nameModal.style.display = "flex";
  playerNameInput.focus();
}

function closeNameModal() {
  nameModal.hidden = true;
  nameModal.style.display = "none";
}

function saveHighScore(score, playerName) {
  const scores = readHighScores();
  scores.push({
    name: playerName,
    score: Number(score) || 0,
  });
  scores.sort((a, b) => b.score - a.score);
  localStorage.setItem(HIGH_SCORE_KEY, JSON.stringify(scores.slice(0, 10)));
}

function showGameToast(message) {
  if (!gameToast) return;
  gameToast.textContent = message;
  gameToast.hidden = false;
  if (toastTimeoutId) clearTimeout(toastTimeoutId);
  toastTimeoutId = setTimeout(() => {
    gameToast.hidden = true;
  }, 1400);
}

function showOverlay(title, message, opts = {}) {
  overlayTitle.textContent = title;
  overlayMessage.textContent = message;
  overlay.hidden = false;
  overlay.style.display = "flex";
  const showPlay = Boolean(opts.showPlay);
  if (overlayPlayButton) {
    overlayPlayButton.hidden = !showPlay;
    overlayPlayButton.style.display = showPlay ? "inline-block" : "none";
  }
}

function hideOverlay() {
  overlay.hidden = true;
  overlay.style.display = "none";
  if (overlayPlayButton) {
    overlayPlayButton.hidden = true;
    overlayPlayButton.style.display = "none";
  }
}

function goToMenu() {
  closeNameModal();
  hideOverlay();
  // Prevent the game loop from resuming and re-triggering endGame().
  activeState.paused = true;
  activeState.gameOver = false;
  gameScreen.classList.add("hidden");
  dashboard.classList.remove("hidden");
}

function setPaused(isPaused) {
  if (activeState.gameOver) return;
  activeState.paused = isPaused;
  if (mPause) {
    mPause.textContent = isPaused ? "Play" : "Pause";
  }
  if (isPaused) {
    showOverlay("Paused", "Press P to resume, or use Play. Restart starts a new game.", {
      showPlay: true,
    });
  } else {
    hideOverlay();
  }
}

function endGame(message) {
  activeState.gameOver = true;
  hideOverlay();
  pendingGameOverMessage = message;
  const remembered = String(
    localStorage.getItem(LAST_SYNCED_USERNAME_KEY) || ""
  ).trim();
  if (remembered && /^[A-Za-z]/.test(remembered)) {
    playerNameInput.value = remembered;
    nameForm.requestSubmit();
    return;
  }
  openNameModal(activeState.score, message);
}

function clearCanvas() {
  ctx.fillStyle = "#020617";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function drawGrid(cols, rows, color = "rgba(30,64,175,0.25)") {
  const cell = canvas.width / cols;
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.5;
  for (let x = 0; x <= cols; x++) {
    const px = x * cell;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, canvas.height);
    ctx.stroke();
  }
  for (let y = 0; y <= rows; y++) {
    const py = y * cell;
    ctx.beginPath();
    ctx.moveTo(0, py);
    ctx.lineTo(canvas.width, py);
    ctx.stroke();
  }
}

function drawRectCell(col, row, cols, color, stroke = "rgba(15,23,42,1)") {
  const cell = canvas.width / cols;
  const x = col * cell;
  const y = row * cell;
  ctx.fillStyle = color;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(x + 1, y + 1, cell - 2, cell - 2);
  ctx.fill();
  ctx.stroke();
}

function drawNextPiece(piece) {
  nextCtx.fillStyle = "#b9c8df";
  nextCtx.fillRect(0, 0, nextCanvas.width, nextCanvas.height);

  const cols = 5;
  const rows = 5;
  const cell = nextCanvas.width / cols;

  nextCtx.strokeStyle = "rgba(68,87,130,0.25)";
  nextCtx.lineWidth = 0.5;
  for (let i = 0; i <= cols; i++) {
    const p = i * cell;
    nextCtx.beginPath();
    nextCtx.moveTo(p, 0);
    nextCtx.lineTo(p, nextCanvas.height);
    nextCtx.stroke();
    nextCtx.beginPath();
    nextCtx.moveTo(0, p);
    nextCtx.lineTo(nextCanvas.width, p);
    nextCtx.stroke();
  }

  const xs = piece.blocks.map((b) => b.x);
  const ys = piece.blocks.map((b) => b.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const shapeW = maxX - minX + 1;
  const shapeH = maxY - minY + 1;
  const offsetX = Math.floor((cols - shapeW) / 2) - minX;
  const offsetY = Math.floor((rows - shapeH) / 2) - minY;

  for (const block of piece.blocks) {
    const gx = block.x + offsetX;
    const gy = block.y + offsetY;
    const x = gx * cell;
    const y = gy * cell;
    nextCtx.fillStyle = TETRIS.COLORS[piece.type];
    nextCtx.strokeStyle = "rgba(15,23,42,0.9)";
    nextCtx.lineWidth = 1;
    nextCtx.beginPath();
    nextCtx.rect(x + 1, y + 1, cell - 2, cell - 2);
    nextCtx.fill();
    nextCtx.stroke();
  }
}

function createBlocksMode() {
  const state = {};

  function createEmptyBoard() {
    const board = [];
    for (let y = 0; y < TETRIS.ROWS; y++) {
      board.push(new Array(TETRIS.COLS).fill(null));
    }
    return board;
  }

  function refillBag() {
    const keys = Object.keys(TETRIS.SHAPES);
    for (let i = keys.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [keys[i], keys[j]] = [keys[j], keys[i]];
    }
    state.bag = keys;
  }

  function randomPiece() {
    if (!state.bag || state.bag.length === 0) {
      refillBag();
    }
    const type = state.bag.pop();
    return {
      type,
      blocks: TETRIS.SHAPES[type].map(([x, y]) => ({ x, y })),
      x: Math.floor(TETRIS.COLS / 2),
      y: 1,
    };
  }

  function canMove(piece, offX, offY, altBlocks = null) {
    const blocks = altBlocks || piece.blocks;
    for (const block of blocks) {
      const x = piece.x + block.x + offX;
      const y = piece.y + block.y + offY;
      if (x < 0 || x >= TETRIS.COLS || y >= TETRIS.ROWS) return false;
      if (y >= 0 && state.board[y][x]) return false;
    }
    return true;
  }

  function findFullRows() {
    const fullRows = [];
    for (let y = TETRIS.ROWS - 1; y >= 0; y--) {
      if (state.board[y].every((cell) => cell !== null)) fullRows.push(y);
    }
    return fullRows;
  }

  function startLineClear() {
    const fullRows = findFullRows();
    if (fullRows.length === 0) return false;

    state.clearing = {
      rows: fullRows.slice(),
      t: 0,
      duration: 300,
    };

    const cleared = fullRows.length;
    state.lines += cleared;
    const base =
      cleared === 1 ? 100 : cleared === 2 ? 300 : cleared === 3 ? 500 : 800;
    state.score += base * state.level;
    state.level = 1 + Math.floor(state.lines / 10);
    state.dropSpeed = Math.max(
      120,
      TETRIS.BASE_SPEED - (state.level - 1) * 60
    );

    updateScore(state.score);
    updateDashboardStats(state.level, state.score, state.lines);
    return true;
  }

  function finishLineClear() {
    if (!state.clearing) return;

    const rows = state.clearing.rows.slice().sort((a, b) => b - a);
    for (const y of rows) {
      state.board.splice(y, 1);
    }
    // Add empty rows back only after all splices, otherwise indices shift.
    for (let i = 0; i < rows.length; i++) {
      state.board.unshift(new Array(TETRIS.COLS).fill(null));
    }

    const isAllClear = state.board.every((row) =>
      row.every((cell) => cell === null)
    );
    if (isAllClear) {
      state.score += 500;
      updateScore(state.score);
      updateDashboardStats(state.level, state.score, state.lines);
      showGameToast("Awesome! Perfect clear!");
    }

    const spawnPiece = state.pieceAfterClear;
    state.pieceAfterClear = null;
    state.clearing = null;
    if (spawnPiece) state.piece = spawnPiece;

    if (!canMove(state.piece, 0, 0)) {
      endGame("Blocks reached the top.");
    }
  }

  function lockPiece() {
    for (const block of state.piece.blocks) {
      const x = state.piece.x + block.x;
      const y = state.piece.y + block.y;
      if (y < 0) return endGame("Blocks reached the top.");
      state.board[y][x] = state.piece.type;
    }

    // If lines are full, animate them before spawning the next piece.
    const hasClear = startLineClear();
    if (hasClear) {
      state.pieceAfterClear = state.nextPiece;
      state.nextPiece = randomPiece();
      drawNextPiece(state.nextPiece);
      return;
    }

    // No clear: spawn next immediately.
    state.piece = state.nextPiece;
    state.nextPiece = randomPiece();
    drawNextPiece(state.nextPiece);
    if (!canMove(state.piece, 0, 0)) endGame("You did very well!");
  }

  function ghostOffset() {
    let n = 0;
    while (canMove(state.piece, 0, n + 1)) n++;
    return n;
  }

  return {
    title: "Tetris Blocks",
    controls: [
      "<li><strong>Left / Right</strong>: Move piece</li>",
      "<li><strong>Up</strong>: Rotate piece</li>",
      "<li><strong>Down</strong>: Soft drop</li>",
      "<li><strong>Space</strong>: Hard drop</li>",
      "<li><strong>P</strong>: Pause | <strong>R</strong>: Restart</li>",
    ],
    init() {
      resizeCanvasForGrid(TETRIS.COLS, TETRIS.ROWS);
      state.board = createEmptyBoard();
      state.nextPiece = randomPiece();
      state.piece = state.nextPiece;
      state.nextPiece = randomPiece();
      state.score = 0;
      state.lines = 0;
      state.level = 1;
      state.dropSpeed = TETRIS.BASE_SPEED;
      state.tick = 0;
      state.bag = [];
      state.clearing = null;
      state.pieceAfterClear = null;
      updateScore(0);
      updateDashboardStats(state.level, state.score, state.lines);
      drawNextPiece(state.nextPiece);
    },
    update(deltaMs) {
      if (state.clearing) {
        state.clearing.t += deltaMs;
        if (state.clearing.t >= state.clearing.duration) {
          finishLineClear();
        }
        return;
      }
      state.tick += deltaMs;
      if (state.tick < state.dropSpeed) return;
      state.tick = 0;
      if (canMove(state.piece, 0, 1)) state.piece.y += 1;
      else lockPiece();
    },
    draw() {
      clearCanvas();
      for (let y = 0; y < TETRIS.ROWS; y++) {
        for (let x = 0; x < TETRIS.COLS; x++) {
          const cell = state.board[y][x];
          if (!cell) continue;
          drawRectCell(x, y, TETRIS.COLS, TETRIS.COLORS[cell], "rgba(15,23,42,0.85)");
        }
      }

      if (state.clearing) {
        const p = Math.max(
          0,
          Math.min(1, state.clearing.t / state.clearing.duration)
        );
        const alpha = 0.15 + (1 - p) * 0.45;
        const shake = Math.round(Math.sin(state.clearing.t / 18) * (1 - p) * 2);

        ctx.save();
        ctx.translate(shake, 0);

        const cell = canvas.width / TETRIS.COLS;
        for (const rowY of state.clearing.rows) {
          const py = rowY * cell;
          ctx.fillStyle = `rgba(34,197,94,${alpha})`;
          ctx.fillRect(1, py + 1, canvas.width - 2, cell - 2);

          ctx.strokeStyle = `rgba(34,197,94,${alpha * 1.2})`;
          ctx.lineWidth = 2;
          ctx.strokeRect(1, py + 1, canvas.width - 2, cell - 2);
        }

        ctx.restore();
      } else {
        const g = ghostOffset();
        if (g > 0) {
          for (const block of state.piece.blocks) {
            const gx = state.piece.x + block.x;
            const gy = state.piece.y + block.y + g;
            if (gy >= 0) {
              ctx.fillStyle = `${TETRIS.COLORS[state.piece.type]}33`;
              ctx.strokeStyle = `${TETRIS.COLORS[state.piece.type]}99`;
              ctx.setLineDash([4, 3]);
              drawRectCell(
                gx,
                gy,
                TETRIS.COLS,
                `${TETRIS.COLORS[state.piece.type]}33`,
                `${TETRIS.COLORS[state.piece.type]}99`
              );
              ctx.setLineDash([]);
            }
          }
        }
        for (const block of state.piece.blocks) {
          const x = state.piece.x + block.x;
          const y = state.piece.y + block.y;
          if (y >= 0)
            drawRectCell(x, y, TETRIS.COLS, TETRIS.COLORS[state.piece.type]);
        }
      }
      drawGrid(TETRIS.COLS, TETRIS.ROWS);
    },
    onKey(key, event) {
      const p = state.piece;
      if (key === "arrowleft") {
        if (canMove(p, -1, 0)) p.x -= 1;
      } else if (key === "arrowright") {
        if (canMove(p, 1, 0)) p.x += 1;
      } else if (key === "arrowdown") {
        if (canMove(p, 0, 1)) {
          p.y += 1;
          // Soft drop: reward player for each manual downward step.
          state.score += 1;
          updateScore(state.score);
          updateDashboardStats(state.level, state.score, state.lines);
        }
      } else if (key === "arrowup") {
        if (p.type !== "O") {
          const r = p.blocks.map((b) => ({ x: -b.y, y: b.x }));
          if (canMove(p, 0, 0, r)) p.blocks = r;
        }
      } else if (key === " ") {
        event.preventDefault();
        // Hard drop: reward distance for each manual downward step.
        let dropped = 0;
        while (canMove(p, 0, 1)) {
          p.y += 1;
          dropped += 1;
        }
        if (dropped > 0) {
          state.score += dropped * 2;
          updateScore(state.score);
          updateDashboardStats(state.level, state.score, state.lines);
        }
        lockPiece();
      }
    },
  };
}

function createTanksMode() {
  const state = {};
  const COLS = 12;
  const ROWS = 18;

  function spawnEnemy() {
    state.enemies.push({
      x: Math.floor(Math.random() * COLS),
      y: 2,
      dir: Math.random() < 0.5 ? -1 : 1,
      fireTick: 0,
    });
  }

  function moveTank(tank, dx, dy) {
    const nx = tank.x + dx;
    const ny = tank.y + dy;
    if (nx >= 1 && nx < COLS - 1 && ny >= 1 && ny < ROWS - 1) {
      tank.x = nx;
      tank.y = ny;
    }
  }

  function rectHit(a, b) {
    return a.x === b.x && a.y === b.y;
  }

  return {
    title: "Block Tanks",
    controls: [
      "<li><strong>Arrows / WASD</strong>: Move tank (forward, back, left, right)</li>",
      "<li><strong>Space</strong>: Shoot in facing direction</li>",
      "<li><strong>P</strong>: Pause | <strong>R</strong>: Restart</li>",
    ],
    init() {
      resizeCanvasForGrid(COLS, ROWS);
      state.player = {
        x: Math.floor(COLS / 2),
        y: ROWS - 3,
        dir: "up",
      };
      state.bullets = [];
      state.enemyBullets = [];
      state.enemies = [];
      state.spawnTick = 0;
      state.score = 0;
      updateScore(0);
    },
    update(deltaMs) {
      state.spawnTick += deltaMs;
      if (state.spawnTick > 1200) {
        state.spawnTick = 0;
        if (state.enemies.length < 4) spawnEnemy();
      }

      const bulletSpeed = 14 * (deltaMs / 1000);
      for (const b of state.bullets) {
        if (b.dir === "up") b.y -= bulletSpeed;
        else if (b.dir === "down") b.y += bulletSpeed;
        else if (b.dir === "left") b.x -= bulletSpeed;
        else if (b.dir === "right") b.x += bulletSpeed;
      }
      state.bullets = state.bullets.filter(
        (b) => b.x >= 0 && b.x < COLS && b.y >= 0 && b.y < ROWS
      );

      const enemyBulletSpeed = 10 * (deltaMs / 1000);
      for (const eb of state.enemyBullets) {
        if (eb.dir === "up") eb.y -= enemyBulletSpeed;
        else if (eb.dir === "down") eb.y += enemyBulletSpeed;
        else if (eb.dir === "left") eb.x -= enemyBulletSpeed;
        else if (eb.dir === "right") eb.x += enemyBulletSpeed;
      }
      state.enemyBullets = state.enemyBullets.filter(
        (b) => b.x >= 0 && b.x < COLS && b.y >= 0 && b.y < ROWS
      );

      for (const e of state.enemies) {
        moveTank(e, e.dir * (deltaMs / 250), 0);
        if (e.x <= 1 || e.x >= COLS - 2) e.dir *= -1;
        e.fireTick += deltaMs;
        if (e.fireTick > 1400) {
          e.fireTick = 0;
          const dir =
            state.player.y < e.y ? "up" : state.player.y > e.y ? "down" : state.player.x < e.x ? "left" : "right";
          state.enemyBullets.push({
            x: e.x,
            y: e.y,
            dir,
          });
        }
      }

      for (let i = state.enemies.length - 1; i >= 0; i--) {
        const e = state.enemies[i];
        for (let j = state.bullets.length - 1; j >= 0; j--) {
          const b = state.bullets[j];
          if (Math.round(b.x) === e.x && Math.round(b.y) === e.y) {
            state.enemies.splice(i, 1);
            state.bullets.splice(j, 1);
            state.score += 25;
            updateScore(state.score);
            break;
          }
        }
      }

      for (const eb of state.enemyBullets) {
        if (
          Math.round(eb.x) === state.player.x &&
          Math.round(eb.y) === state.player.y
        ) {
          endGame("You were destroyed by enemy fire.");
          return;
        }
      }

      for (const e of state.enemies) {
        if (rectHit(e, state.player)) {
          endGame("You collided with an enemy tank.");
          return;
        }
      }
    },
    draw() {
      clearCanvas();
      drawGrid(COLS, ROWS);

      for (let x = 0; x < COLS; x++) {
        drawRectCell(x, 0, COLS, "rgba(15,23,42,0.9)");
        drawRectCell(x, ROWS - 1, COLS, "rgba(15,23,42,0.9)");
      }

      const p = state.player;
      drawRectCell(p.x, p.y, COLS, "#22c55e");
      drawRectCell(p.x, p.y - 1, COLS, "#16a34a");
      let bx = p.x;
      let by = p.y;
      if (p.dir === "up") by -= 2;
      else if (p.dir === "down") by += 1;
      else if (p.dir === "left") bx -= 1;
      else if (p.dir === "right") bx += 1;
      drawRectCell(
        Math.max(1, Math.min(COLS - 2, bx)),
        Math.max(1, Math.min(ROWS - 2, by)),
        COLS,
        "#bbf7d0"
      );

      for (const e of state.enemies) {
        drawRectCell(e.x, e.y, COLS, "#ef4444");
        drawRectCell(e.x, e.y - 1, COLS, "#b91c1c");
      }

      for (const b of state.bullets) {
        drawRectCell(Math.round(b.x), Math.round(b.y), COLS, "#f9fafb");
      }
      for (const eb of state.enemyBullets) {
        drawRectCell(Math.round(eb.x), Math.round(eb.y), COLS, "#fee2e2");
      }
    },
    onKey(key, event) {
      const p = state.player;
      if (key === "arrowleft" || key === "a") {
        p.dir = "left";
        moveTank(p, -1, 0);
      } else if (key === "arrowright" || key === "d") {
        p.dir = "right";
        moveTank(p, 1, 0);
      } else if (key === "arrowup" || key === "w") {
        p.dir = "up";
        moveTank(p, 0, -1);
      } else if (key === "arrowdown" || key === "s") {
        p.dir = "down";
        moveTank(p, 0, 1);
      } else if (key === " ") {
        event.preventDefault();
        state.bullets.push({
          x: p.x,
          y: p.y - 1,
          dir: p.dir,
        });
      }
    },
  };
}

function createRaceMode() {
  const state = {};
  const LANES = 5;
  const ROWS = 20;

  function spawnObstacle() {
    state.obstacles.push({
      lane: Math.floor(Math.random() * LANES),
      y: -1,
      speed: 3 + Math.random() * 1.5,
    });
  }

  return {
    title: "Block Race",
    controls: [
      "<li><strong>Left / Right</strong>: Change lane</li>",
      "<li><strong>Down</strong>: Boost score speed</li>",
      "<li><strong>P</strong>: Pause | <strong>R</strong>: Restart</li>",
    ],
    init() {
      resizeCanvasForGrid(LANES, ROWS);
      state.playerLane = Math.floor(LANES / 2);
      state.obstacles = [];
      state.spawnTick = 0;
      state.score = 0;
      state.boost = false;
      updateScore(0);
    },
    update(deltaMs) {
      state.spawnTick += deltaMs;
      if (state.spawnTick > 550) {
        state.spawnTick = 0;
        spawnObstacle();
      }
      const factor = state.boost ? 1.7 : 1;
      state.score += deltaMs * 0.02 * factor;
      updateScore(Math.floor(state.score));

      for (const o of state.obstacles) {
        o.y += o.speed * (deltaMs / 1000) * 5 * factor;
      }
      state.obstacles = state.obstacles.filter((o) => o.y < ROWS + 1);

      for (const o of state.obstacles) {
        const row = Math.floor(o.y);
        if ((row === ROWS - 1 || row === ROWS - 2) && o.lane === state.playerLane) {
          endGame("You crashed.");
          return;
        }
      }
    },
    draw() {
      clearCanvas();
      // road lanes
      drawGrid(LANES, ROWS, "rgba(148,163,184,0.2)");
      for (let y = 0; y < ROWS; y++) {
        if (y % 2 === 0) {
          for (let lane = 1; lane < LANES; lane++) {
            drawRectCell(lane, y, LANES, "rgba(148,163,184,0.08)", "rgba(148,163,184,0.02)");
          }
        }
      }
      // player car
      drawRectCell(state.playerLane, ROWS - 1, LANES, "#22c55e");
      drawRectCell(state.playerLane, ROWS - 2, LANES, "#16a34a");
      // obstacles
      for (const o of state.obstacles) {
        const y = Math.floor(o.y);
        if (y >= 0 && y < ROWS) drawRectCell(o.lane, y, LANES, "#f97316");
      }
    },
    onKey(key) {
      if (key === "arrowleft") state.playerLane = Math.max(0, state.playerLane - 1);
      else if (key === "arrowright") state.playerLane = Math.min(LANES - 1, state.playerLane + 1);
      else if (key === "arrowdown") state.boost = true;
    },
    onKeyUp(key) {
      if (key === "arrowdown") state.boost = false;
    },
  };
}

function setMode(mode) {
  activeState.mode = mode;
  activeState.paused = false;
  activeState.gameOver = false;
  closeNameModal();
  hideOverlay();
  if (mPause) mPause.textContent = "Pause";

  const game = modes[mode];
  game.init();
  if (gameTitle) gameTitle.textContent = game.title;
  controlsList.innerHTML = game.controls.join("");
}

function resetCurrentMode() {
  const game = modes[activeState.mode];
  activeState.paused = false;
  activeState.gameOver = false;
  closeNameModal();
  hideOverlay();
  if (mPause) mPause.textContent = "Pause";
  game.init();
}

function frame(timestamp) {
  const delta = lastFrameTime ? timestamp - lastFrameTime : 16;
  lastFrameTime = timestamp;
  const game = modes[activeState.mode];

  if (!activeState.paused && !activeState.gameOver) {
    game.update(delta);
  }
  game.draw();
  loopId = requestAnimationFrame(frame);
}

window.addEventListener("keydown", (event) => {
  if (!nameModal.hidden) return;
  if (gameScreen.classList.contains("hidden")) return;
  const key = event.key.toLowerCase();
  if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(key)) {
    event.preventDefault();
  }
  if (key === "p") return setPaused(!activeState.paused);
  if (key === "r") return resetCurrentMode();
  if (activeState.paused || activeState.gameOver) return;
  modes[activeState.mode].onKey(key, event);
});

window.addEventListener("keyup", (event) => {
  const key = event.key.toLowerCase();
  const game = modes[activeState.mode];
  if (game.onKeyUp) game.onKeyUp(key);
});

restartButton.addEventListener("click", () => {
  resetCurrentMode();
});

if (goToMenuButton) {
  goToMenuButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    goToMenu();
  });
}

if (nameModalGoToMenuButton) {
  nameModalGoToMenuButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    goToMenu();
  });
}

if (overlayPlayButton) {
  overlayPlayButton.addEventListener("click", () => {
    if (!gameIsInteractive() || activeState.gameOver) return;
    setPaused(false);
  });
}

nameForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const rawName = playerNameInput.value.trim();
  if (!rawName || !/^[A-Za-z]/.test(rawName)) {
    nameError.hidden = false;
    playerNameInput.focus();
    return;
  }

  const playerName = rawName.slice(0, 16).toUpperCase();
  const score = activeState.score;
  saveHighScore(score, playerName);
  localStorage.setItem(LAST_SYNCED_USERNAME_KEY, playerName);
  closeNameModal();
  showOverlay(
    "Game over",
    `${pendingGameOverMessage} You earned ${score} point. Just share to friend to challenge them. Press R to restart.`,
    { showPlay: false }
  );

  // Sync leaderboard in the background.
  void (async () => {
    try {
      const { bestScore, historyScores } = await syncUserScoreWithApi(
        playerName,
        score
      );

      // If the player restarted quickly, don't overwrite the new screen.
      if (!activeState.gameOver) return;

      const topData = await apiFetchTopScores(10);
      const topResults = Array.isArray(topData?.results)
        ? topData.results
        : [];

      const lastBestScore =
        topResults.length > 0
          ? normalizeScoreNumber(
              topResults[topResults.length - 1]?.bestScore ??
                topResults[topResults.length - 1]?.score ??
                0
            )
          : 0;
      const isTop10 = topResults.length > 0 && bestScore >= lastBestScore;
      const top10Text = isTop10
        ? "Great, you are one of top-10 players 😇"
        : "Try one more time to become top players 😅";

      showOverlay(
        "Game over",
        `${pendingGameOverMessage} You earned ${bestScore} point. ${top10Text}. Just share to friend to challenge them. Press R to restart.`,
        { showPlay: false }
      );

      await refreshLeaderboardFromApi(10);
    } catch (err) {
      console.warn("Failed to sync score to API:", err);
      if (!activeState.gameOver) return;
      showGameToast("Leaderboard sync failed");
      await refreshLeaderboardFromApi(10);
    }
  })();
});

playGameButton.addEventListener("click", () => {
  closeNameModal();
  dashboard.classList.add("hidden");
  gameScreen.classList.remove("hidden");
  resetCurrentMode();
});

backToDashboardButton.addEventListener("click", () => {
  goToMenu();
});

// Mobile controls (touch)
function bindMobileHold(button, actionKey, which) {
  if (!button) return;

  const start = (event) => {
    if (!gameIsInteractive()) return;
    event.preventDefault();
    dispatchTetrisKey(actionKey);

    if (which === "left") leftHoldTimer = startHold(leftHoldTimer, actionKey);
    if (which === "right") rightHoldTimer = startHold(rightHoldTimer, actionKey);
    if (which === "soft")
      softDropHoldTimer = startHold(softDropHoldTimer, actionKey);
  };

  const stop = (event) => {
    if (event) event.preventDefault();
    if (which === "left") {
      stopHold(leftHoldTimer);
      leftHoldTimer = null;
    }
    if (which === "right") {
      stopHold(rightHoldTimer);
      rightHoldTimer = null;
    }
    if (which === "soft") {
      stopHold(softDropHoldTimer);
      softDropHoldTimer = null;
    }
  };

  button.addEventListener("pointerdown", start);
  button.addEventListener("pointerup", stop);
  button.addEventListener("pointercancel", stop);
  button.addEventListener("pointerleave", stop);
}

function bindMobileTap(button, actionKey) {
  if (!button) return;
  button.addEventListener("pointerdown", (event) => {
    if (!gameIsInteractive()) return;
    event.preventDefault();
    dispatchTetrisKey(actionKey);
  });
}

bindMobileHold(mLeft, "arrowleft", "left");
bindMobileHold(mRight, "arrowright", "right");
bindMobileHold(mSoftDrop, "arrowdown", "soft");

bindMobileTap(mRotate, "arrowup");
bindMobileTap(mHardDrop, " ");

// Touch drag controls on the canvas:
// - Drag down: soft drop step-by-step
// - Release after a strong downward drag: hard drop (landing)
function bindMobileDragToLandOnCanvas() {
  if (!canvas) return;

  const DRAG_STEP_PX = 22; // "grid" between repeated moves
  const TAP_MAX_PX = 16; // keep small gesture => treat as tap

  let active = false;
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let axis = null; // "x" | "y"
  let lastXSteps = 0;
  let lastYSteps = 0;

  function signFloorSteps(v, stepPx) {
    const abs = Math.abs(v);
    if (abs < stepPx) return 0;
    return Math.sign(v) * Math.floor(abs / stepPx);
  }

  function reset() {
    active = false;
    pointerId = null;
    axis = null;
    lastXSteps = 0;
    lastYSteps = 0;
  }

  canvas.style.touchAction = "none";

  canvas.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch") return;
    if (!gameIsInteractive()) return;
    if (activeState.paused || activeState.gameOver) return;
    if (event.button !== undefined && event.button !== 0) return;

    active = true;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    axis = null;
    lastXSteps = 0;
    lastYSteps = 0;

    try {
      canvas.setPointerCapture(pointerId);
    } catch {
      // Ignore if capture fails
    }

    event.preventDefault();
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!active) return;
    if (event.pointerId !== pointerId) return;
    if (!gameIsInteractive()) return;

    event.preventDefault();

    const dx = event.clientX - startX;
    const dy = event.clientY - startY;

    if (!axis) {
      // Decide which axis drives motion based on the dominant gesture.
      if (Math.abs(dx) >= DRAG_STEP_PX || Math.abs(dy) >= DRAG_STEP_PX) {
        axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
      }
    }

    // Drag-down no longer performs soft-drop.
    // (Keep horizontal drag movement if you drag mostly left/right.)
    const xSteps = signFloorSteps(dx, DRAG_STEP_PX);
    const delta = xSteps - lastXSteps;
    if (delta !== 0) {
      const stepsToApply = Math.min(Math.abs(delta), 8);
      const dirKey = delta > 0 ? "arrowright" : "arrowleft";
      for (let i = 0; i < stepsToApply; i++) dispatchTetrisKey(dirKey);
      lastXSteps += stepsToApply * (delta > 0 ? 1 : -1);
    }
  });

  function onPointerEnd(event) {
    if (!active) return;
    if (event.pointerId !== pointerId) return;

    const dy = event.clientY - startY;
    const dx = event.clientX - startX;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    // Small tap => rotate once (mobile-only).
    // Larger drags are treated as movement/soft-drop only (no hard landing on release).
    if (absDx <= TAP_MAX_PX && absDy <= TAP_MAX_PX) {
      dispatchTetrisKey("arrowup");
    }

    reset();
    event.preventDefault();
  }

  canvas.addEventListener("pointerup", onPointerEnd);
  canvas.addEventListener("pointercancel", onPointerEnd);
  canvas.addEventListener("pointerleave", (e) => {
    // If finger leaves the canvas while pressed, treat it as end.
    if (!active) return;
    if (e.pointerId !== pointerId) return;
    onPointerEnd(e);
  });
}

if (mPause) {
  mPause.addEventListener("click", () => {
    if (!gameIsInteractive()) return;
    setPaused(!activeState.paused);
  });
}

if (mRestart) {
  mRestart.addEventListener("click", () => {
    if (!gameIsInteractive()) return;
    resetCurrentMode();
  });
}

bindMobileDragToLandOnCanvas();

if (enableNotificationsButton) {
  updateNotificationsButtonUi();
  enableNotificationsButton.addEventListener("click", async () => {
    const permission = await requestNotificationPermission();
    updateNotificationsButtonUi();
    if (permission === "granted") {
      await sendReminderNotification();
    }
  });
}

// Try sending a reminder occasionally (only if user already granted permission).
setInterval(() => {
  if (Notification?.permission !== "granted") return;
  // Only nudge when user is on the dashboard (not mid-game).
  if (!gameScreen || !gameScreen.classList.contains("hidden")) return;
  void sendReminderNotification();
}, 1000 * 60 * 30);

// Prevent page scroll while playing on mobile
window.addEventListener(
  "touchmove",
  (event) => {
    if (!gameScreen || gameScreen.classList.contains("hidden")) return;
    if (!nameModal || !nameModal.hidden) return;

    // Only prevent scroll when the user is interacting with the game UI.
    // This keeps the page scrollable in other situations (including over modal).
    const target = event.target;
    const inCanvas = canvas && (target === canvas || canvas.contains(target));
    const inControls =
      target &&
      typeof target.closest === "function" &&
      target.closest(".mobile-controls");

    if (!inCanvas && !inControls) return;
    event.preventDefault();
  },
  { passive: false }
);

modes.blocks = createBlocksMode();
closeNameModal();
setMode("blocks");
showLeaderboardLoading(); // wait for remote leaderboard
void refreshLeaderboardFromApi(10); // remote leaderboard
if (loopId) cancelAnimationFrame(loopId);
loopId = requestAnimationFrame(frame);

