/**
 * app.js — Main application controller.
 * View switching, lobby logic, post-game, profile.
 * Entry point: App.init() called on DOMContentLoaded.
 */

// ─── App State ────────────────────────────────────────────────────────────────
const App = {
  currentView: null,
  currentRoom: null,    // { code, players, difficulty, lives, host_id, ... }
  myPlayerId: null,     // own player ID — works for guests too
  _pendingQueueMode: null,   // "ranked" | "casual" | "solo" — set during difficulty step
  _selectedDifficulty: "medium",
  _publicTab: "easy",        // currently viewed difficulty tab in public lobbies
  _lastRoomList: [],
  _soloSettings: { difficulty: 'easy' },
  _soloReturnView: null,     // where "Back" / "Done" goes after solo/journey puzzle
  _profileReturnView: null,  // where profile "← Back" returns to
  _journeyState: {           // runtime journey state
    counts: { easy: 0, medium: 0, hard: 0 },
    nextDifficulty: null,
    nextIndex: null,
  },

  init() {
    Auth.init();
    initGame();
    _bindNavigation();
    _registerAppHandlers();
    _checkUrlRoomCode();

    // Connect WebSocket
    const token = Auth.token;
    WS.connect(token);

    // Direct profile URL: /username injected by Cloudflare Worker
    const profileUsername = window.__SPEEDOKU_PROFILE__;
    if (profileUsername) {
      // Show home/lobby first, then open profile once WS is ready
      const storedUser = localStorage.getItem("speedoku_user");
      if (storedUser) {
        try { Auth.user = JSON.parse(storedUser); Auth.isGuest = false; } catch {}
      }
      this.showView("lobby-browser");
      this.updateHeaderUser();
      const unsub = WS.on("_connected", () => {
        WS.send({ type: "get_profile", username: profileUsername });
        unsub();
      });
      return;
    }

    // Try to restore session from localStorage
    const storedUser = localStorage.getItem("speedoku_user");
    if (storedUser) {
      try {
        Auth.user = JSON.parse(storedUser);
        Auth.isGuest = false;
        this.showView("lobby-browser");
        this.updateHeaderUser();
      } catch {
        this.showView("home");
      }
    } else {
      this.showView("home");
    }
  },

  showView(name) {
    document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
    const el = document.getElementById(`view-${name}`);
    if (el) el.classList.add("active");
    this.currentView = name;
    if (name === "lobby-browser") WS.send({ type: "get_rooms" });
  },

  updateHeaderUser() {
    const el = document.getElementById("header-username");
    if (!el) return;
    if (Auth.user) {
      el.textContent = Auth.user.username;
    } else {
      el.textContent = "Guest";
    }
  },

  _startSolo(difficulty) {
    this._soloSettings.difficulty = difficulty;
    App.showView('solo');
    // Show a subtle loading state on the board while waiting
    const boardEl = document.getElementById('solo-board');
    if (boardEl) boardEl.innerHTML = '<div class="solo-loading">Loading puzzle…</div>';
    WS.send({ type: 'get_solo_puzzle', difficulty });
  },

  _showSoloDifficultyPicker() {
    this._pendingQueueMode = 'solo';
    _showDifficultyPicker('solo');
  },

  // ─── Journey ──────────────────────────────────────────────────────────────

  _openJourney() {
    App.showView('journey');
    // Show loading state in each section
    ['easy', 'medium', 'hard'].forEach(d => {
      document.getElementById(`journey-dots-${d}`).innerHTML =
        '<span class="journey-loading">Loading…</span>';
    });
    WS.send({ type: 'get_journey_info' });
  },

  _renderJourneyDots(counts, serverCompletions) {
    this._journeyState.counts = counts;
    const progress = this._getJourneyProgress();

    // Merge server completions (server wins on conflict)
    if (serverCompletions) {
      for (const c of serverCompletions) {
        if (!progress[c.difficulty]) progress[c.difficulty] = {};
        const ex = progress[c.difficulty][String(c.index)];
        if (ex === undefined || c.best_time < ex) {
          progress[c.difficulty][String(c.index)] = c.best_time;
        }
      }
      localStorage.setItem('speedoku_journey', JSON.stringify(progress));
    }

    let totalDone = 0, totalCount = 0;
    for (const diff of ['easy', 'medium', 'hard']) {
      const count = counts[diff] || 0;
      totalCount += count;
      const diffProgress = progress[diff] || {};
      const doneCount = Object.keys(diffProgress).length;
      totalDone += doneCount;

      document.getElementById(`journey-count-${diff}`).textContent = `${doneCount} / ${count}`;

      const container = document.getElementById(`journey-dots-${diff}`);
      container.innerHTML = '';
      for (let i = 0; i < count; i++) {
        const dot = document.createElement('button');
        dot.className = 'journey-dot';
        dot.dataset.diff = diff;
        dot.dataset.index = i;
        const bestTime = diffProgress[String(i)];
        if (bestTime !== undefined) {
          dot.classList.add('done');
          const mins = Math.floor(bestTime / 60);
          const secs = String(Math.floor(bestTime % 60)).padStart(2, '0');
          dot.dataset.tip = `${mins}:${secs}`;
        } else {
          dot.dataset.tip = `#${i + 1}`;
        }
        dot.addEventListener('click', () => App._startJourneyPuzzle(diff, i));
        container.appendChild(dot);
      }
    }
    document.getElementById('journey-total-progress').textContent = `${totalDone} / ${totalCount}`;
  },

  _startJourneyPuzzle(difficulty, index) {
    this._journeyState.difficulty = difficulty;
    this._journeyState.index = index;
    this._soloReturnView = 'journey';
    App.showView('solo');
    const boardEl = document.getElementById('solo-board');
    if (boardEl) boardEl.innerHTML = '<div class="solo-loading">Loading puzzle…</div>';
    WS.send({ type: 'get_journey_puzzle', difficulty, index });
  },

  _handleJourneyComplete(difficulty, index, elapsed) {
    // Persist to localStorage (keep personal best)
    const p = this._getJourneyProgress();
    if (!p[difficulty]) p[difficulty] = {};
    const existing = p[difficulty][String(index)];
    const isNewBest = existing === undefined || elapsed < existing;
    if (isNewBest) p[difficulty][String(index)] = elapsed;
    localStorage.setItem('speedoku_journey', JSON.stringify(p));

    // Update dot on the map if it's rendered
    this._updateJourneyDot(difficulty, index, elapsed, isNewBest);

    // Completion card: show Next Puzzle if there's one in this difficulty
    const nextIndex = index + 1;
    const hasNext = nextIndex < (this._journeyState.counts[difficulty] || 0);
    document.getElementById('btn-solo-next').classList.toggle('hidden', !hasNext);
    if (hasNext) {
      this._journeyState.nextDifficulty = difficulty;
      this._journeyState.nextIndex = nextIndex;
    }
    document.getElementById('btn-solo-done').textContent = 'Back to Journey';
    if (isNewBest) document.getElementById('solo-complete-pb').classList.remove('hidden');

    // Sync to server if logged in
    if (WS && !Auth.isGuest && Auth.user) {
      WS.send({ type: 'journey_complete', difficulty, index, time_seconds: elapsed });
    }
  },

  _updateJourneyDot(difficulty, index, time, isNewBest) {
    const dot = document.querySelector(`#journey-dots-${difficulty} [data-index="${index}"]`);
    if (!dot) return;
    dot.classList.add('done');
    if (isNewBest) dot.classList.add('pb');
    const mins = Math.floor(time / 60);
    const secs = String(Math.floor(time % 60)).padStart(2, '0');
    dot.dataset.tip = `${mins}:${secs}`;
    // Refresh section count
    const container = document.getElementById(`journey-dots-${difficulty}`);
    const doneCount = container.querySelectorAll('.journey-dot.done').length;
    const total = this._journeyState.counts[difficulty] || 0;
    document.getElementById(`journey-count-${difficulty}`).textContent = `${doneCount} / ${total}`;
    // Refresh total
    const totalDone = document.querySelectorAll('.journey-dot.done').length;
    const totalCount = Object.values(this._journeyState.counts).reduce((a, b) => a + b, 0);
    document.getElementById('journey-total-progress').textContent = `${totalDone} / ${totalCount}`;
  },

  _getJourneyProgress() {
    try { return JSON.parse(localStorage.getItem('speedoku_journey') || '{}'); }
    catch { return {}; }
  },
};

// ─── Navigation / Button Bindings ────────────────────────────────────────────

function _bindNavigation() {
  // Home
  document.getElementById("btn-play-guest").addEventListener("click", () => {
    Auth.isGuest = true;
    Auth.user = null;
    App.showView("lobby-browser");
    App.updateHeaderUser();
    WS.connect(); // connect without token
    showToast("Playing as Guest — casual/private rooms only");
  });
  document.getElementById("btn-sign-in").addEventListener("click", () => {
    App.showView("auth");
    document.querySelector('[data-tab="login"]').click();
    WS.connect();
  });
  document.getElementById("btn-create-account").addEventListener("click", () => {
    App.showView("auth");
    document.querySelector('[data-tab="register"]').click();
    WS.connect();
  });
  document.getElementById("btn-how-to-play").addEventListener("click", () => {
    document.getElementById("modal-how-to-play").classList.remove("hidden");
  });

  // Auth back
  document.getElementById("auth-back").addEventListener("click", () => App.showView("home"));

  // How-to-play modal close
  document.getElementById("btn-close-how-to-play").addEventListener("click", () => {
    document.getElementById("modal-how-to-play").classList.add("hidden");
  });
  document.getElementById("btn-close-how-to-play-2").addEventListener("click", () => {
    document.getElementById("modal-how-to-play").classList.add("hidden");
  });
  document.getElementById("modal-how-to-play").addEventListener("click", e => {
    if (e.target === e.currentTarget) e.currentTarget.classList.add("hidden");
  });

  // Lobby Browser — step 1: pick mode
  document.getElementById("btn-journey").addEventListener("click", () => {
    App._openJourney();
  });

  document.getElementById("btn-journey-back").addEventListener("click", () => {
    App.showView("lobby-browser");
  });

  document.getElementById("btn-solo").addEventListener("click", () => {
    App._showSoloDifficultyPicker();
  });

  document.getElementById("btn-quick-match").addEventListener("click", () => {
    if (Auth.isGuest) { showToast("Ranked requires an account.", "error"); return; }
    _showDifficultyPicker("ranked");
  });
  document.getElementById("btn-quick-casual").addEventListener("click", () => {
    _showDifficultyPicker("casual");
  });
  document.getElementById("btn-create-room").addEventListener("click", () => {
    WS.send({ type: "create_room", difficulty: App._selectedDifficulty, private: true, lives: 0 });
  });

  // Step 2: difficulty picker
  document.querySelectorAll(".diff-pick").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".diff-pick").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      App._selectedDifficulty = btn.dataset.diff;
    });
  });
  document.getElementById("btn-confirm-queue").addEventListener("click", () => {
    const mode = App._pendingQueueMode;
    const diff = App._selectedDifficulty;
    _hideDifficultyPicker();
    if (mode === "solo") {
      App._startSolo(diff);
      return;
    }
    WS.send({ type: "join_queue", mode, difficulty: diff });
  });
  document.getElementById("btn-cancel-diff").addEventListener("click", () => {
    _hideDifficultyPicker();
  });

  document.getElementById("btn-leave-queue").addEventListener("click", () => {
    WS.send({ type: "leave_queue" });
    _hideMatchmaking();
  });
  document.getElementById("btn-join-room-code").addEventListener("click", _joinByCode);
  document.getElementById("join-room-code").addEventListener("keydown", e => {
    if (e.key === "Enter") _joinByCode();
  });

  document.getElementById("btn-leaderboard").addEventListener("click", () => {
    WS.send({ type: "get_leaderboard" });
  });
  document.getElementById("btn-leaderboard-back").addEventListener("click", () => {
    App.showView("lobby-browser");
  });

  document.getElementById("btn-profile").addEventListener("click", () => {
    if (!Auth.user) return;
    WS.send({ type: "get_profile", user_id: Auth.user.id });
  });
  document.getElementById("btn-logout").addEventListener("click", () => {
    Auth.logout();
    App.showView("home");
  });

  // Room Lobby
  document.getElementById("btn-leave-room").addEventListener("click", () => {
    WS.send({ type: "leave_room" });
    App.currentRoom = null;
    App.showView("lobby-browser");
  });

  // Notify server when page is closed or reloaded mid-lobby
  window.addEventListener("beforeunload", () => {
    if (App.currentRoom) WS.send({ type: "leave_room" });
  });
  const roomCodeLabel = document.getElementById("room-code-label");
  const _copyRoomCode = () => {
    const code = App.currentRoom && App.currentRoom.code;
    if (!code) return;
    navigator.clipboard.writeText(code).then(() => showToast("Room code copied!", "success"));
  };
  roomCodeLabel.addEventListener("click", _copyRoomCode);
  roomCodeLabel.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") _copyRoomCode(); });
  document.getElementById("btn-ready").addEventListener("click", () => {
    WS.send({ type: "ready" });
    document.getElementById("btn-ready").disabled = true;
    document.getElementById("btn-ready").textContent = "Waiting…";
  });

  // Difficulty buttons
  document.getElementById("difficulty-select").addEventListener("click", e => {
    const btn = e.target.closest("[data-diff]");
    if (!btn) return;
    document.querySelectorAll("#difficulty-select [data-diff]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    WS.send({ type: "update_room", difficulty: btn.dataset.diff });
  });

  // Lives buttons
  document.getElementById("lives-select").addEventListener("click", e => {
    const btn = e.target.closest("[data-lives]");
    if (!btn) return;
    document.querySelectorAll("#lives-select [data-lives]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    WS.send({ type: "update_room", lives: parseInt(btn.dataset.lives) });
  });

  // Post-game
  document.getElementById("btn-play-again").addEventListener("click", () => {
    App.showView("lobby-browser");
    WS.send({ type: "get_rooms" });
  });
  document.getElementById("btn-back-lobby").addEventListener("click", () => {
    App.showView("lobby-browser");
    WS.send({ type: "get_rooms" });
  });

  // Profile
  document.getElementById("btn-profile-back").addEventListener("click", () => {
    App.showView(App._profileReturnView || "lobby-browser");
    App._profileReturnView = null;
  });

  // Public lobby difficulty tabs
  document.querySelectorAll(".diff-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".diff-tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      App._publicTab = btn.dataset.tab;
      _renderPublicRooms(App._lastRoomList || []);
    });
  });

  // Solo mode navigation
  document.getElementById("btn-solo-back").addEventListener("click", () => {
    Game.stopSolo();
    const returnView = App._soloReturnView || "lobby-browser";
    App._soloReturnView = null;
    App.showView(returnView);
  });

  document.getElementById("btn-solo-again").addEventListener("click", () => {
    if (Game._journeyIndex !== null) {
      // Replay the same journey puzzle
      App._startJourneyPuzzle(Game._journeyDifficulty, Game._journeyIndex);
    } else {
      App._startSolo(App._soloSettings.difficulty);
    }
  });

  document.getElementById("btn-solo-next").addEventListener("click", () => {
    const { nextDifficulty, nextIndex } = App._journeyState;
    if (nextDifficulty != null) {
      App._startJourneyPuzzle(nextDifficulty, nextIndex);
    }
  });

  document.getElementById("btn-solo-done").addEventListener("click", () => {
    Game.stopSolo();
    const returnView = App._soloReturnView || "lobby-browser";
    App._soloReturnView = null;
    App.showView(returnView);
  });

  document.getElementById("btn-solo-timer-toggle").addEventListener("click", () => {
    Game.setSoloTimerEnabled(!Game._soloTimerEnabled);
  });
}

// ─── WS App Handlers ─────────────────────────────────────────────────────────

function _registerAppHandlers() {
  WS.on("_connected", () => {
    if (App.currentView === "lobby-browser") {
      WS.send({ type: "get_rooms" });
    }
  });

  WS.on("_disconnected", () => {
    showToast("Connection lost. Reconnecting…", "error");
  });

  WS.on("_reconnect_failed", () => {
    showToast("Could not reconnect to server.", "error");
  });

  WS.on("error", msg => {
    // Stale/invalid token — clear silently and fall back to guest
    if (msg.message === "Invalid token") {
      Auth.user = null;
      Auth.token = null;
      Auth.isGuest = true;
      localStorage.removeItem("speedoku_token");
      localStorage.removeItem("speedoku_user");
      App.updateHeaderUser();
      return;
    }
    // Only show toasts if not in auth view (auth.js handles those)
    const active = document.querySelector(".view.active");
    if (!active || active.id !== "view-auth") {
      showToast(msg.message, "error");
    }
  });

  // ─── Matchmaking ───────────────────────────────────────────────────────────

  WS.on("queue_joined", msg => {
    _showMatchmaking(`Finding ${msg.mode} opponent…`);
  });

  WS.on("queue_left", () => _hideMatchmaking());

  WS.on("match_found", msg => {
    _hideMatchmaking();
    App.currentRoom = { code: msg.room_code };
    showToast(`Matched vs ${msg.opponent.username} (${msg.opponent.elo})`, "success");
  });

  // ─── Room ──────────────────────────────────────────────────────────────────

  WS.on("room_created", msg => {
    App.myPlayerId = msg.my_player_id || (Auth.user && String(Auth.user.id)) || null;
    App.currentRoom = msg.room;
    _renderRoomLobby(msg.room);
    App.showView("room-lobby");
  });

  WS.on("room_joined", msg => {
    if (msg.puzzle) {
      // This is the game-start version of room_joined (puzzle included)
      _startGameFromRoomJoined(msg);
    } else {
      App.myPlayerId = msg.my_player_id || (Auth.user && String(Auth.user.id)) || null;
      App.currentRoom = msg.room || { code: msg.code };
      if (msg.room) _renderRoomLobby(msg.room);
      App.showView("room-lobby");
    }
  });

  WS.on("player_joined", msg => {
    if (!App.currentRoom) return;
    App.currentRoom.players = App.currentRoom.players || [];
    App.currentRoom.players.push(msg.player);
    _renderPlayerList(App.currentRoom);
    showToast(`${msg.player.username} joined the room`);
  });

  WS.on("player_ready", msg => {
    if (!App.currentRoom || !App.currentRoom.players) return;
    const p = App.currentRoom.players.find(pl => pl.id === msg.player_id);
    if (p) p.ready = true;
    _renderPlayerList(App.currentRoom);
  });

  WS.on("room_updated", msg => {
    App.currentRoom = msg.room;
    _renderRoomLobby(msg.room);
  });

  WS.on("countdown_tick", msg => {
    const wrap   = document.getElementById("lobby-countdown");
    const label  = document.getElementById("lobby-countdown-label");
    const number = document.getElementById("lobby-countdown-number");
    if (!wrap) return;
    if (msg.seconds != null) {
      label.textContent = "Game starting in";
      number.textContent = msg.seconds;
      number.classList.remove("hidden");
    } else {
      label.textContent = "Waiting for players…";
      number.classList.add("hidden");
    }
  });

  // ─── Game ──────────────────────────────────────────────────────────────────

  WS.on("game_start", msg => {
    // Countdown is handled in game.js
    // But we also need to show the game view if room_joined already sent the puzzle
    if (App.currentView !== "game") App.showView("game");
  });

  WS.on("player_disconnected", msg => {
    showToast(`${msg.username} disconnected — they forfeit the game.`, "error");
  });

  WS.on("game_over", msg => {
    Game.stop();
    App.currentRoom = null;
    _renderPostGame(msg);
    setTimeout(() => App.showView("post-game"), 800);
  });

  WS.on("elo_update", msg => {
    if (Auth.user) {
      Auth.user.elo = msg.new_elo;
      localStorage.setItem("speedoku_user", JSON.stringify(Auth.user));
    }
  });

  // ─── Lobby ─────────────────────────────────────────────────────────────────

  WS.on("room_list", msg => {
    _renderRoomList(msg.rooms);
  });

  WS.on("profile", msg => {
    _renderProfile(msg.profile);
    App.showView("profile");
  });

  // Track where profile "← Back" should return to
  document.getElementById("btn-profile").addEventListener("click", () => {
    App._profileReturnView = "lobby-browser";
  }, true);

  WS.on("solo_puzzle", msg => {
    Game.startSolo(msg.puzzle, msg.solution, msg.given_cells, msg.difficulty, msg.puzzle_id);
  });

  WS.on("solo_result", msg => {
    if (msg.new_best) {
      document.getElementById("solo-complete-pb").classList.remove("hidden");
    }
  });

  WS.on("leaderboard", msg => {
    _renderLeaderboard(msg);
    App._profileReturnView = "leaderboard";
    App.showView("leaderboard");
  });

  WS.on("journey_info", msg => {
    App._renderJourneyDots(msg.counts, msg.completions || null);
  });

  WS.on("journey_puzzle", msg => {
    Game.startSolo(msg.puzzle, msg.solution, msg.given_cells, msg.difficulty, msg.puzzle_id, msg.index);
  });

  WS.on("journey_result", () => {
    // Server confirmed — client already handled localStorage + UI in _handleJourneyComplete
  });
}

// ─── Room Lobby UI ────────────────────────────────────────────────────────────

function _renderRoomLobby(room) {
  App.currentRoom = room;
  document.getElementById("room-code-label").textContent = room.code;

  const myId = App.myPlayerId || (Auth.user && String(Auth.user.id));
  const isHost = myId && String(room.host_id) === myId;
  document.getElementById("room-controls").classList.toggle("hidden", !isHost || room.is_public);

  // Public rooms use the countdown — no Ready button needed
  const isPublic = !!room.is_public;
  const readyBtn = document.getElementById("btn-ready");
  const countdownWrap = document.getElementById("lobby-countdown");
  readyBtn.classList.toggle("hidden", isPublic);
  countdownWrap.classList.toggle("hidden", !isPublic);

  if (!isPublic) {
    // Reset ready button state for private rooms
    readyBtn.disabled = false;
    readyBtn.textContent = "Ready";
  } else {
    // Reset countdown to waiting state when entering a public room
    document.getElementById("lobby-countdown-label").textContent = "Waiting for players…";
    document.getElementById("lobby-countdown-number").classList.add("hidden");
  }

  // Set difficulty buttons
  document.querySelectorAll("#difficulty-select [data-diff]").forEach(b => {
    b.classList.toggle("active", b.dataset.diff === room.difficulty);
  });

  // Set lives buttons
  document.querySelectorAll("#lives-select [data-lives]").forEach(b => {
    b.classList.toggle("active", parseInt(b.dataset.lives) === room.lives);
  });

  _renderPlayerList(room);
}

function _renderPlayerList(room) {
  const container = document.getElementById("lobby-player-list");
  if (!container || !room.players) return;
  container.innerHTML = "";
  room.players.forEach(p => {
    const row = document.createElement("div");
    row.className = "player-row";

    const name = document.createElement("span");
    name.className = "player-row-name";
    name.textContent = p.username;

    const elo = document.createElement("span");
    elo.className = "player-row-elo";
    elo.textContent = p.is_guest ? "Guest" : p.elo;

    const ready = document.createElement("span");
    ready.className = `player-row-ready${p.ready ? " is-ready" : ""}`;
    ready.textContent = p.ready ? "Ready" : "Waiting";

    if (p.id === room.host_id) {
      const badge = document.createElement("span");
      badge.className = "host-badge";
      badge.textContent = "Host";
      row.appendChild(badge);
    }
    row.appendChild(name);
    row.appendChild(elo);
    row.appendChild(ready);
    container.appendChild(row);
  });
}

// ─── Game Start ───────────────────────────────────────────────────────────────

function _startGameFromRoomJoined(msg) {
  const room = App.currentRoom || {};
  const lives = room.lives || 0;
  Game.init(msg.puzzle, msg.given_cells, lives);

  // The server tells us exactly which player ID is ours — works for guests too.
  const myId = String(msg.my_player_id || (Auth.user && Auth.user.id) || "");
  const players = msg.players || [];
  document.getElementById("opponents-section").innerHTML = "";

  players.forEach(p => {
    const pid = String(p.id);
    if (pid !== myId) {
      Game.addOpponent(pid, p.username, p.filled_count || 0, msg.given_cells);
    }
  });

  App.showView("game");
}

// ─── Room List ────────────────────────────────────────────────────────────────

function _renderRoomList(rooms) {
  App._lastRoomList = rooms;
  _renderPublicRooms(rooms);
}

function _renderPublicRooms(rooms) {
  const grid = document.getElementById("public-rooms-grid");
  if (!grid) return;

  const tab = App._publicTab || "easy";
  const publicRooms = rooms
    .filter(r => r.is_public && r.difficulty === tab)
    .sort((a, b) => a.min_elo - b.min_elo);

  if (publicRooms.length === 0) {
    grid.innerHTML = '<div class="room-list-empty">Connecting\u2026</div>';
    return;
  }

  grid.innerHTML = "";
  publicRooms.forEach(r => {
    const card = document.createElement("div");
    card.className = `public-room-card${r.state !== "lobby" ? " unavailable" : ""}`;

    let statusHtml;
    if (r.state === "active") {
      statusHtml = '<span class="prc-status in-progress">In progress</span>';
    } else if (r.countdown != null && r.countdown > 0) {
      statusHtml = `<span class="prc-status counting">${r.countdown}s</span>`;
    } else if (r.player_count >= 2) {
      statusHtml = '<span class="prc-status counting">Starting\u2026</span>';
    } else {
      statusHtml = '<span class="prc-status waiting">Waiting</span>';
    }

    card.innerHTML = `
      <div class="prc-tier">${_escapeHtml(r.elo_label)}</div>
      <div class="prc-players">${r.player_count} <span>/ 8</span></div>
      ${statusHtml}
    `;

    if (r.state === "lobby") {
      card.addEventListener("click", () => {
        WS.send({ type: "join_room", code: r.code });
      });
    }

    grid.appendChild(card);
  });
}

// ─── Post Game ────────────────────────────────────────────────────────────────

function _renderPostGame(msg) {
  const myId = Auth.user ? String(Auth.user.id) : null;
  const isWinner = myId && String(msg.winner_id) === myId;

  document.getElementById("result-title").textContent = isWinner ? "Victory!" : "Game Over";

  const winnerResult = msg.results && msg.results[0];
  document.getElementById("result-winner").textContent =
    winnerResult ? `${winnerResult.username} wins` : "";

  // ELO delta — filled by elo_update handler
  const deltaEl = document.getElementById("elo-delta");
  deltaEl.textContent = "";
  WS.on("elo_update", function handler(eloMsg) {
    const sign = eloMsg.delta >= 0 ? "+" : "";
    deltaEl.textContent = `${sign}${eloMsg.delta} ELO`;
    deltaEl.className = `elo-delta ${eloMsg.delta >= 0 ? "positive" : "negative"}`;
    WS.off("elo_update"); // one-shot
  });

  const list = document.getElementById("results-list");
  list.innerHTML = "";
  (msg.results || []).forEach((r, i) => {
    const row = document.createElement("div");
    row.className = "result-row";
    row.innerHTML = `
      <span class="result-rank${i === 0 ? " winner" : ""}">#${i + 1}</span>
      <span class="result-name">${_escapeHtml(r.username)}</span>
      <span class="result-fill">${r.filled_count}/81 cells</span>
    `;
    list.appendChild(row);
  });
}

// ─── Profile ──────────────────────────────────────────────────────────────────

function _renderProfile(profile) {
  const fmt = secs => secs > 0
    ? `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, "0")}`
    : "—";

  // ── Hero ──────────────────────────────────────────────────────────────────
  document.getElementById("profile-username").textContent = profile.username;
  document.getElementById("profile-elo").textContent = profile.elo;
  document.getElementById("profile-tier").textContent = profile.tier;
  const bestElo = profile.best_elo || profile.elo;
  document.getElementById("profile-peak-elo").textContent =
    bestElo > profile.elo ? `Peak: ${bestElo}` : "";

  // ── Badges ────────────────────────────────────────────────────────────────
  const badgesEl = document.getElementById("profile-badges");
  badgesEl.innerHTML = "";
  const badges = profile.badges || [];
  if (badges.length === 0) {
    badgesEl.innerHTML = '<span class="no-badges">No badges yet — get out there!</span>';
  } else {
    badges.forEach(b => {
      const el = document.createElement("span");
      el.className = `badge tier-${b.tier}`;
      el.innerHTML = `<span class="badge-icon">${b.icon}</span>${_escapeHtml(b.label)}`;
      badgesEl.appendChild(el);
    });
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  document.getElementById("stat-games").textContent = profile.games_played;
  document.getElementById("stat-wins").textContent = profile.wins;
  document.getElementById("stat-losses").textContent = profile.losses ?? "—";
  document.getElementById("stat-winrate").textContent =
    profile.games_played > 0 ? (profile.win_rate * 100).toFixed(1) + "%" : "—";
  document.getElementById("stat-streak").textContent = profile.best_win_streak || 0;
  document.getElementById("stat-avgtime").textContent = fmt(profile.avg_time_seconds);

  // ── Journey Progress ──────────────────────────────────────────────────────
  const journeyBars = document.getElementById("journey-profile-bars");
  journeyBars.innerHTML = "";
  const totals = profile.journey_totals || {};
  const jStats = profile.journey_stats || {};
  let anyJourney = false;
  [["easy", "Easy"], ["medium", "Medium"], ["hard", "Hard"]].forEach(([diff, label]) => {
    const done  = jStats[diff] || 0;
    const total = totals[diff] || 0;
    if (total === 0) return;
    anyJourney = true;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const row = document.createElement("div");
    row.className = "journey-bar-row";
    row.innerHTML = `
      <span class="journey-bar-label diff-${diff}">${label}</span>
      <div class="journey-bar-track">
        <div class="journey-bar-fill diff-${diff}" style="width:${pct}%"></div>
      </div>
      <span class="journey-bar-count">${done} / ${total}</span>
    `;
    journeyBars.appendChild(row);
  });
  document.getElementById("section-journey").style.display = anyJourney ? "" : "none";

  // ── Speed Records ─────────────────────────────────────────────────────────
  const speedEl = document.getElementById("speed-records");
  speedEl.innerHTML = "";
  [["easy", "Easy"], ["medium", "Medium"], ["hard", "Hard"]].forEach(([diff, label]) => {
    const t = profile[`fastest_${diff}`];
    const block = document.createElement("div");
    block.className = "speed-record-block";
    block.innerHTML = `
      <div class="speed-record-value">${fmt(t)}</div>
      <div class="speed-record-label">${label}</div>
    `;
    speedEl.appendChild(block);
  });
  const hasSpeed = profile.fastest_easy || profile.fastest_medium || profile.fastest_hard;
  document.getElementById("section-speed").style.display = hasSpeed ? "" : "none";

  // ── Recent Games ──────────────────────────────────────────────────────────
  const recentList = document.getElementById("recent-games-list");
  recentList.innerHTML = "";
  (profile.recent_games || []).forEach(g => {
    const row = document.createElement("div");
    row.className = "recent-game-row";
    const delta = g.elo_after - g.elo_before;
    const sign = delta >= 0 ? "+" : "";
    row.innerHTML = `
      <span class="rgr-result ${g.result === "win" ? "win" : "loss"}">${g.result.toUpperCase()}</span>
      <span>${_escapeHtml(g.difficulty || "—")}</span>
      <span>${_escapeHtml(g.mode || "—")}</span>
      <span class="rgr-delta ${delta >= 0 ? "pos" : "neg"}">${sign}${delta} ELO</span>
    `;
    recentList.appendChild(row);
  });
}

// ─── Difficulty Picker UI ─────────────────────────────────────────────────────

function _showDifficultyPicker(mode) {
  App._pendingQueueMode = mode;
  document.getElementById("browser-step-1").classList.add("hidden");
  document.getElementById("browser-step-2").classList.remove("hidden");
  document.querySelector(".rooms-section").classList.add("hidden");
  const label = document.getElementById("difficulty-step-label");
  if (mode === "ranked") label.textContent = "Ranked — select difficulty";
  else if (mode === "solo") label.textContent = "Solo — select difficulty";
  else label.textContent = "Casual — select difficulty";
  document.getElementById("btn-confirm-queue").textContent =
    mode === "solo" ? "Play" : "Find Game";
}

function _hideDifficultyPicker() {
  document.getElementById("browser-step-2").classList.add("hidden");
  document.getElementById("browser-step-1").classList.remove("hidden");
  document.querySelector(".rooms-section").classList.remove("hidden");
  App._pendingQueueMode = null;
}

// ─── Matchmaking UI ───────────────────────────────────────────────────────────

function _showMatchmaking(label) {
  _hideDifficultyPicker();
  document.getElementById("browser-step-1").classList.add("hidden");
  document.getElementById("matchmaking-status").classList.remove("hidden");
  document.getElementById("mm-label").textContent = label;
}

function _hideMatchmaking() {
  document.getElementById("matchmaking-status").classList.add("hidden");
  document.getElementById("browser-step-1").classList.remove("hidden");
}

// ─── URL Room Code ────────────────────────────────────────────────────────────

function _checkUrlRoomCode() {
  const params = new URLSearchParams(location.search);
  const code = params.get("room");
  if (code) {
    // Auto-join after connecting
    const unsub = WS.on("_connected", () => {
      WS.send({ type: "join_room", code });
      unsub();
    });
  }
}

function _joinByCode() {
  const input = document.getElementById("join-room-code");
  const code = input.value.trim().toUpperCase();
  if (code.length !== 6) {
    showToast("Enter a 6-character room code", "error");
    return;
  }
  WS.send({ type: "join_room", code });
  input.value = "";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

// ─── Leaderboard ──────────────────────────────────────────────────────────────

function _renderLeaderboard(data) {
  const myId = Auth.user ? Auth.user.id : null;
  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const rankClass = i => i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : "";

  // ── Tab switching ───────────────────────────────────────────────────────
  document.querySelectorAll(".lb-tab").forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll(".lb-tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      document.getElementById("lb-panel-ranked").classList.toggle("hidden", tab !== "ranked");
      document.getElementById("lb-panel-speed").classList.toggle("hidden", tab !== "speed");
    };
  });
  // Reset to ranked tab
  document.querySelectorAll(".lb-tab")[0].click();

  // ── Ranked ──────────────────────────────────────────────────────────────
  const rankedList = document.getElementById("lb-ranked-list");
  rankedList.innerHTML = "";
  if (!data.ranked || data.ranked.length === 0) {
    rankedList.innerHTML = '<div class="lb-meta">No ranked players yet — play some games!</div>';
  } else {
    data.ranked.forEach((p, i) => {
      const row = document.createElement("div");
      row.className = `lb-row${myId && p.id === myId ? " is-me" : ""}`;
      row.innerHTML = `
        <span class="lb-rank ${rankClass(i)}">${i + 1}</span>
        <span class="lb-username">${_escapeHtml(p.username)}</span>
        <span class="lb-tier">${_escapeHtml(p.tier)}</span>
        <span class="lb-value">${p.elo}</span>
      `;
      row.addEventListener("click", () => {
        WS.send({ type: "get_profile", user_id: p.id });
      });
      rankedList.appendChild(row);
    });
  }

  // ── Speed ────────────────────────────────────────────────────────────────
  const speedGrid = document.getElementById("lb-speed-grid");
  speedGrid.innerHTML = "";
  for (const [diff, label] of [["easy", "Easy"], ["medium", "Medium"], ["hard", "Hard"]]) {
    const col = document.createElement("div");
    col.className = "lb-speed-col";
    col.innerHTML = `<div class="lb-speed-header diff-${diff}">${label}</div>`;
    const rows = data.speed?.[diff] || [];
    if (rows.length === 0) {
      col.innerHTML += '<div class="lb-meta">No records yet</div>';
    } else {
      rows.forEach((p, i) => {
        const row = document.createElement("div");
        row.className = `lb-speed-row${myId && p.id === myId ? " is-me" : ""}`;
        row.innerHTML = `
          <span class="lb-speed-rank ${rankClass(i)}">${i + 1}</span>
          <span class="lb-speed-name">${_escapeHtml(p.username)}</span>
          <span class="lb-speed-time">${fmt(p.best_time)}</span>
        `;
        row.addEventListener("click", () => {
          WS.send({ type: "get_profile", user_id: p.id });
        });
        col.appendChild(row);
      });
    }
    speedGrid.appendChild(col);
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => App.init());
