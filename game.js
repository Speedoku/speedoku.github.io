/**
 * game.js — Board rendering, input handling, notes mode, opponent boards.
 * Manages the active game state client-side.
 */

// ─── Game State ──────────────────────────────────────────────────────────────
const Game = {
  puzzle: null,          // 9x9 array from server (0 = blank)
  givenCells: null,      // Set of "r,c" strings
  board: null,           // 9x9 player-visible board (numbers only)
  notes: null,           // 9x9 array of Set<number> (pencil marks)
  selectedCell: null,    // [row, col] or null
  notesMode: false,
  eliminated: false,
  lives: 0,
  maxLives: 0,
  timerInterval: null,
  startTime: null,
  opponents: {},         // player_id → { username, filledCount, miniBoard, givenSet }
  myFilledCount: 0,
  active: false,
  lockedCells: {},       // "r,c" → timestamp when lockout expires

  /** Called when the server sends us the puzzle. */
  init(puzzle, givenCells, lives) {
    this.puzzle = puzzle;
    this.givenCells = new Set(givenCells.map(([r, c]) => `${r},${c}`));
    this.board = puzzle.map(row => [...row]);
    this.notes = Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => new Set()));
    this.selectedCell = null;
    this.notesMode = false;
    this.eliminated = false;
    this.lives = lives;
    this.maxLives = lives;
    this.active = false;
    this.myFilledCount = puzzle.flat().filter(v => v !== 0).length;
    this.opponents = {};
    this.lockedCells = {};

    _renderBoard();
    _updateLives();
    _updateNumpad();
    _resetTimer();
    document.getElementById("btn-notes").classList.remove("active");
    // Re-enable all numpad buttons from any previous game
    document.querySelectorAll(".num-btn[data-num]").forEach(btn => {
      btn.disabled = false;
      btn.classList.remove("num-complete");
    });
  },

  /** Called when game_start countdown begins. */
  startCountdown(seconds) {
    _showCountdown(seconds, () => {
      this.active = true;
      this.startTime = Date.now();
      _startTimer();
    });
  },

  /** Begin the timer (called after countdown). */
  startTimer() {
    this.startTime = Date.now();
    this.active = true;
    _startTimer();
  },

  stop() {
    this.active = false;
    _stopTimer();
  },

  /** Handle move_result from server. */
  onMoveResult(row, col, valid, complete, lockedUntil) {
    const cellEl = _cellEl(row, col);
    if (valid) {
      // Optimistic update already shown — just update numpad state
      _updateNumpad();
      if (complete) {
        this.stop();
      }
    } else {
      // Revert the cell visually
      this.board[row][col] = 0;
      this.myFilledCount = Math.max(0, this.myFilledCount - 1);
      _renderCell(row, col);
      _applyHighlights(row, col);
      if (cellEl) {
        cellEl.classList.remove("invalid");
        void cellEl.offsetWidth;
        cellEl.classList.add("invalid");
        setTimeout(() => cellEl.classList.remove("invalid"), 600);
      }
      // Apply lockout if server sent one
      if (lockedUntil) {
        const key = `${row},${col}`;
        this.lockedCells[key] = lockedUntil * 1000; // convert to ms
        if (cellEl) {
          cellEl.classList.add("locked");
          const msLeft = lockedUntil * 1000 - Date.now();
          setTimeout(() => {
            cellEl.classList.remove("locked");
            delete this.lockedCells[key];
          }, Math.max(0, msLeft));
        }
      }
    }
  },

  /** Update lives after an invalid move. */
  onLivesUpdate(remaining) {
    this.lives = remaining;
    _updateLives();
  },

  /** Mark self as eliminated. */
  onEliminated() {
    this.eliminated = true;
    this.active = false;
    _stopTimer();
    const board = document.getElementById("main-board");
    if (board) board.style.opacity = "0.35";
    showToast("You have been eliminated.", "error");
  },

  /** Register an opponent. */
  addOpponent(playerId, username, filledCount, givenCells) {
    const givenSet = new Set((givenCells || []).map(([r, c]) => `${r},${c}`));
    this.opponents[playerId] = { username, filledCount, givenSet, eliminated: false };
    _renderOpponentBoard(playerId);
    _updateOpponentLabel(playerId);
  },

  /** Update opponent's fill state. */
  onOpponentUpdate(playerId, filledCount, lastCell) {
    const opp = this.opponents[playerId];
    if (!opp) return;
    opp.filledCount = filledCount;
    _updateOpponentLabel(playerId);
    if (lastCell) {
      _animateOpponentCell(playerId, lastCell[0], lastCell[1]);
    }
  },

  /** Mark opponent as eliminated. */
  onOpponentEliminated(playerId) {
    const opp = this.opponents[playerId];
    if (!opp) return;
    opp.eliminated = true;
    const wrap = document.getElementById(`opp-wrap-${playerId}`);
    if (wrap) {
      wrap.classList.add("eliminated");
      const label = wrap.querySelector(".opponent-label");
      if (label) label.classList.add("eliminated-label");
      const badge = document.createElement("div");
      badge.className = "eliminated-badge";
      badge.textContent = "Eliminated";
      wrap.appendChild(badge);
    }
  },
};

// ─── Board Rendering ──────────────────────────────────────────────────────────

function _renderBoard() {
  const container = document.getElementById("main-board");
  container.innerHTML = "";

  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.row = r;
      cell.dataset.col = c;
      _applyCell(cell, r, c);

      cell.addEventListener("click", () => _selectCell(r, c));
      container.appendChild(cell);
    }
  }
}

function _renderCell(row, col) {
  const el = _cellEl(row, col);
  if (el) _applyCell(el, row, col);
}

function _applyCell(el, row, col) {
  const key = `${row},${col}`;
  const isGiven = Game.givenCells && Game.givenCells.has(key);
  const value = Game.board[row][col];
  const noteSet = Game.notes[row][col];

  el.classList.toggle("given", isGiven);
  el.innerHTML = "";

  if (value !== 0) {
    el.textContent = value;
  } else if (noteSet && noteSet.size > 0) {
    // Render pencil marks
    const grid = document.createElement("div");
    grid.className = "cell-notes";
    for (let n = 1; n <= 9; n++) {
      const nd = document.createElement("div");
      nd.className = "note-digit";
      nd.textContent = noteSet.has(n) ? n : "";
      grid.appendChild(nd);
    }
    el.appendChild(grid);
  }
}

function _cellEl(row, col) {
  return document.querySelector(`.cell[data-row="${row}"][data-col="${col}"]`);
}

function _selectCell(row, col) {
  if (!Game.active || Game.eliminated) return;
  _clearHighlights();
  Game.selectedCell = [row, col];
  _applyHighlights(row, col);
}

function _applyHighlights(selRow, selCol) {
  const selValue = Game.board[selRow][selCol]; // 0 if empty

  document.querySelectorAll(".cell").forEach(el => {
    const r = +el.dataset.row;
    const c = +el.dataset.col;
    const sameRow = r === selRow;
    const sameCol = c === selCol;
    const sameBox = Math.floor(r / 3) === Math.floor(selRow / 3) &&
                    Math.floor(c / 3) === Math.floor(selCol / 3);
    const isSelected = r === selRow && c === selCol;
    // Highlight matching numbers (but not the selected cell itself, and only when cell has a value)
    const sameNum = selValue !== 0 && !isSelected && Game.board[r][c] === selValue;

    el.classList.toggle("selected", isSelected);
    el.classList.toggle("same-number", sameNum);
    el.classList.toggle("highlight", !isSelected && !sameNum && (sameRow || sameCol || sameBox));
  });
}

function _clearHighlights() {
  document.querySelectorAll(".cell").forEach(el => {
    el.classList.remove("selected", "highlight", "same-number");
  });
}

// ─── Input ────────────────────────────────────────────────────────────────────

function _enterValue(num) {
  if (!Game.active || Game.eliminated || !Game.selectedCell) return;
  const [row, col] = Game.selectedCell;
  if (Game.givenCells && Game.givenCells.has(`${row},${col}`)) return;

  // Client-side lockout check (mirrors server-side brute-force deterrent)
  const lockKey = `${row},${col}`;
  if (Game.lockedCells[lockKey] && Date.now() < Game.lockedCells[lockKey]) {
    const cellEl = _cellEl(row, col);
    if (cellEl) {
      cellEl.classList.remove("locked");
      void cellEl.offsetWidth;
      cellEl.classList.add("locked");
    }
    return;
  }

  if (Game.notesMode) {
    // Toggle pencil mark
    const noteSet = Game.notes[row][col];
    if (noteSet.has(num)) noteSet.delete(num);
    else noteSet.add(num);
    _renderCell(row, col);
    return;
  }

  // Optimistic update
  Game.board[row][col] = num;
  _renderCell(row, col);
  Game.myFilledCount++;

  // Refresh highlights so same-number tint reflects the newly entered value
  _applyHighlights(row, col);

  WS.send({ type: "move", cell: [row, col], value: num });
}

function _eraseValue() {
  if (!Game.active || Game.eliminated || !Game.selectedCell) return;
  const [row, col] = Game.selectedCell;
  if (Game.givenCells && Game.givenCells.has(`${row},${col}`)) return;

  if (Game.notesMode) {
    Game.notes[row][col].clear();
    _renderCell(row, col);
    return;
  }

  if (Game.board[row][col] !== 0) {
    Game.board[row][col] = 0;
    Game.myFilledCount = Math.max(0, Game.myFilledCount - 1);
    _renderCell(row, col);
    // Cell is now empty — reapply highlights to clear same-number tints
    _applyHighlights(row, col);
    WS.send({ type: "erase", cell: [row, col] });
  }
}

function _moveSelection(dr, dc) {
  if (!Game.selectedCell) {
    Game.selectedCell = [0, 0];
    _applyHighlights(0, 0);
    return;
  }
  let [r, c] = Game.selectedCell;
  r = Math.max(0, Math.min(8, r + dr));
  c = Math.max(0, Math.min(8, c + dc));
  _selectCell(r, c);
}

// ─── Keyboard ─────────────────────────────────────────────────────────────────

function _initKeyboard() {
  document.addEventListener("keydown", e => {
    const active = document.querySelector(".view.active");
    if (!active || active.id !== "view-game") return;
    if (e.target.tagName === "INPUT") return;

    if (e.key >= "1" && e.key <= "9") {
      _enterValue(parseInt(e.key));
    } else if (e.key === "Backspace" || e.key === "Delete") {
      _eraseValue();
    } else if (e.key === "ArrowUp")    { e.preventDefault(); _moveSelection(-1, 0); }
    else if (e.key === "ArrowDown")    { e.preventDefault(); _moveSelection(1, 0); }
    else if (e.key === "ArrowLeft")    { e.preventDefault(); _moveSelection(0, -1); }
    else if (e.key === "ArrowRight")   { e.preventDefault(); _moveSelection(0, 1); }
    else if (e.key === "n" || e.key === "N") {
      _toggleNotesMode();
    }
  });
}

function _initNumpad() {
  document.getElementById("numpad").addEventListener("click", e => {
    const btn = e.target.closest(".num-btn");
    if (!btn || !btn.dataset.num) return;
    _enterValue(parseInt(btn.dataset.num));
  });

  document.getElementById("btn-erase").addEventListener("click", _eraseValue);
  document.getElementById("btn-notes").addEventListener("click", _toggleNotesMode);
}

function _toggleNotesMode() {
  Game.notesMode = !Game.notesMode;
  document.getElementById("btn-notes").classList.toggle("active", Game.notesMode);
}

// ─── Timer ────────────────────────────────────────────────────────────────────

function _startTimer() {
  _stopTimer();
  Game.timerInterval = setInterval(_tickTimer, 1000);
}

function _stopTimer() {
  if (Game.timerInterval) {
    clearInterval(Game.timerInterval);
    Game.timerInterval = null;
  }
}

function _resetTimer() {
  _stopTimer();
  document.getElementById("game-timer").textContent = "0:00";
}

function _tickTimer() {
  if (!Game.startTime) return;
  const elapsed = Math.floor((Date.now() - Game.startTime) / 1000);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  document.getElementById("game-timer").textContent = `${m}:${s.toString().padStart(2, "0")}`;
}

// ─── Lives ────────────────────────────────────────────────────────────────────

function _updateLives() {
  const container = document.getElementById("lives-display");
  container.innerHTML = "";
  if (Game.maxLives === 0) return;
  for (let i = 0; i < Game.maxLives; i++) {
    const icon = document.createElement("div");
    icon.className = "life-icon" + (i >= Game.lives ? " lost" : "");
    container.appendChild(icon);
  }
}

// ─── Countdown ────────────────────────────────────────────────────────────────

function _showCountdown(seconds, onDone) {
  const overlay = document.getElementById("countdown-overlay");
  const numEl   = document.getElementById("countdown-number");
  overlay.classList.remove("hidden");

  let remaining = seconds;
  numEl.textContent = remaining;

  // Reset animation by cloning
  const clone = numEl.cloneNode(true);
  numEl.parentNode.replaceChild(clone, numEl);

  function tick() {
    remaining--;
    const fresh = document.getElementById("countdown-number");
    if (remaining <= 0) {
      overlay.classList.add("hidden");
      onDone && onDone();
      return;
    }
    fresh.textContent = remaining;
    // Restart animation
    const c2 = fresh.cloneNode(true);
    fresh.parentNode.replaceChild(c2, fresh);
    setTimeout(tick, 1000);
  }

  setTimeout(tick, 1000);
}

// ─── Opponent Boards ──────────────────────────────────────────────────────────

function _renderOpponentBoard(playerId) {
  const section = document.getElementById("opponents-section");

  // Remove existing
  const existing = document.getElementById(`opp-wrap-${playerId}`);
  if (existing) existing.remove();

  const opp = Game.opponents[playerId];
  if (!opp) return;

  const wrap = document.createElement("div");
  wrap.className = "opponent-board-wrap";
  wrap.id = `opp-wrap-${playerId}`;

  const label = document.createElement("div");
  label.className = "opponent-label";
  label.id = `opp-label-${playerId}`;
  label.innerHTML = `<span>${_escapeHtml(opp.username)}</span> <span class="opp-pct">0%</span>`;

  const miniBoard = document.createElement("div");
  miniBoard.className = "opponent-mini-board";
  miniBoard.id = `opp-board-${playerId}`;

  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const cell = document.createElement("div");
      cell.className = "mini-cell";
      cell.dataset.row = r;
      cell.dataset.col = c;
      cell.id = `opp-${playerId}-${r}-${c}`;
      if (opp.givenSet && opp.givenSet.has(`${r},${c}`)) {
        cell.classList.add("given-mini", "filled");
      }
      miniBoard.appendChild(cell);
    }
  }

  wrap.appendChild(label);
  wrap.appendChild(miniBoard);
  section.appendChild(wrap);
}

function _updateOpponentLabel(playerId) {
  const opp = Game.opponents[playerId];
  if (!opp) return;
  const label = document.getElementById(`opp-label-${playerId}`);
  if (!label) return;
  const pct = Math.round((opp.filledCount / 81) * 100);
  const pctEl = label.querySelector(".opp-pct");
  if (pctEl) pctEl.textContent = `${pct}%`;
}

function _animateOpponentCell(playerId, row, col) {
  const cell = document.getElementById(`opp-${playerId}-${row}-${col}`);
  if (!cell) return;
  cell.classList.remove("blink-on");
  void cell.offsetWidth; // reflow
  cell.classList.add("filled", "blink-on");
  setTimeout(() => cell.classList.remove("blink-on"), 350);
}

// ─── Numpad State ─────────────────────────────────────────────────────────────

/**
 * Count how many times each digit 1-9 appears correctly placed on the board
 * (i.e. cell is non-zero and matches the solution as confirmed by server).
 * When a digit reaches 9 placements, grey out its button.
 * We use Game.board directly since only valid moves ever persist there.
 */
function _updateNumpad() {
  if (!Game.board) return;
  const counts = new Array(10).fill(0); // index 1-9
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const v = Game.board[r][c];
      if (v !== 0) counts[v]++;
    }
  }
  document.querySelectorAll(".num-btn[data-num]").forEach(btn => {
    const n = parseInt(btn.dataset.num);
    const complete = counts[n] >= 9;
    btn.classList.toggle("num-complete", complete);
    btn.disabled = complete;
  });
}

// ─── WS Handlers ─────────────────────────────────────────────────────────────

function _registerGameHandlers() {
  WS.on("game_start", msg => {
    Game.startCountdown(msg.countdown || 3);
  });

  WS.on("move_result", msg => {
    Game.onMoveResult(msg.cell[0], msg.cell[1], msg.valid, msg.complete, msg.locked_until || null);
    if (!msg.valid && msg.lives_remaining !== undefined) {
      Game.onLivesUpdate(msg.lives_remaining);
    }
    if (msg.complete) {
      showToast("Puzzle complete! 🎉", "success");
    }
  });

  WS.on("opponent_update", msg => {
    Game.onOpponentUpdate(msg.player_id, msg.filled_count, msg.last_cell);
  });

  WS.on("player_eliminated", msg => {
    const opp = Game.opponents[msg.player_id];
    if (opp) {
      Game.onOpponentEliminated(msg.player_id);
    } else if (Auth.user && msg.player_id === String(Auth.user.id)) {
      Game.onEliminated();
    }
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function initGame() {
  _initKeyboard();
  _initNumpad();
  _registerGameHandlers();
}

function _escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}
