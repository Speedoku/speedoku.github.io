/**
 * auth.js — Login / register UI logic.
 * Handles form submission, token storage, and auth state.
 */

// ─── State ───────────────────────────────────────────────────────────────────
const Auth = {
  user: null,        // { id, username, elo, tier, ... } or null for guest
  token: null,
  isGuest: true,

  /** Load token from localStorage and set up handlers. */
  init() {
    const token = localStorage.getItem("speedoku_token");
    if (token) {
      this.token = token;
    }
    _bindForms();
    _bindTabs();
    _registerHandlers();
    _checkResetUrl();
  },

  /** Returns true if the user is authenticated (not a guest). */
  get isAuthed() { return !this.isGuest && !!this.user; },

  /** Store credentials returned from the server. */
  _setUser(user, token) {
    this.user = user;
    this.token = token;
    this.isGuest = false;
    localStorage.setItem("speedoku_token", token);
    localStorage.setItem("speedoku_user", JSON.stringify(user));
  },

  /** Clear session (logout). */
  logout() {
    this.user = null;
    this.token = null;
    this.isGuest = true;
    localStorage.removeItem("speedoku_token");
    localStorage.removeItem("speedoku_user");
    WS.disconnect();
  },

  /** Reconnect the WS with the stored token. */
  reconnect() {
    WS.connect(this.token);
  },
};

// ─── Form Binding ─────────────────────────────────────────────────────────────

function _bindForms() {
  document.getElementById("form-login").addEventListener("submit", e => {
    e.preventDefault();
    const email    = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;
    _clearError("login-error");
    WS.send({ type: "login", email, password });
  });

  document.getElementById("form-register").addEventListener("submit", e => {
    e.preventDefault();
    const username = document.getElementById("reg-username").value.trim();
    const email    = document.getElementById("reg-email").value.trim();
    const password = document.getElementById("reg-password").value;
    _clearError("reg-error");
    if (username.length < 3 || username.length > 20) {
      _showError("reg-error", "Username must be 3–20 characters");
      return;
    }
    if (password.length < 8) {
      _showError("reg-error", "Password must be at least 8 characters");
      return;
    }
    WS.send({ type: "register", username, email, password });
  });

  document.getElementById("form-forgot").addEventListener("submit", e => {
    e.preventDefault();
    const email = document.getElementById("forgot-email").value.trim();
    _clearError("forgot-error");
    document.getElementById("forgot-success").classList.add("hidden");
    document.getElementById("forgot-submit").disabled = true;
    WS.send({ type: "forgot_password", email });
  });

  document.getElementById("form-reset").addEventListener("submit", e => {
    e.preventDefault();
    const password = document.getElementById("reset-password").value;
    const confirm  = document.getElementById("reset-confirm").value;
    _clearError("reset-error");
    if (password !== confirm) {
      _showError("reset-error", "Passwords don't match");
      return;
    }
    const token = document.getElementById("view-reset").dataset.token || "";
    WS.send({ type: "reset_password", token, password });
  });

  document.getElementById("btn-forgot").addEventListener("click", () => {
    App.showView("forgot");
  });

  document.getElementById("forgot-back").addEventListener("click", () => {
    App.showView("auth");
  });
}

function _bindTabs() {
  document.querySelectorAll(".auth-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".auth-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      const which = tab.dataset.tab;
      document.getElementById("form-login").classList.toggle("hidden", which !== "login");
      document.getElementById("form-register").classList.toggle("hidden", which !== "register");
    });
  });
}

// ─── WS Handlers ─────────────────────────────────────────────────────────────

function _registerHandlers() {
  WS.on("login_ok", msg => {
    Auth._setUser(msg.user, msg.token);
    App.showView("lobby-browser");
    App.updateHeaderUser();
    showToast(`Welcome back, ${msg.user.username}!`, "success");
  });

  WS.on("register_ok", msg => {
    Auth._setUser(msg.user, msg.token);
    App.showView("lobby-browser");
    App.updateHeaderUser();
    showToast(`Account created. Welcome, ${msg.user.username}!`, "success");
  });

  WS.on("auth_ok", msg => {
    Auth.user = msg.user;
    Auth.isGuest = false;
    if (msg.token) {
      Auth.token = msg.token;
      localStorage.setItem("speedoku_token", msg.token);
    }
    App.updateHeaderUser();
  });

  WS.on("forgot_ok", () => {
    document.getElementById("forgot-submit").disabled = false;
    const el = document.getElementById("forgot-success");
    el.textContent = "If that email is registered, a reset link is on its way.";
    el.classList.remove("hidden");
    document.getElementById("forgot-email").value = "";
  });

  WS.on("reset_ok", () => {
    // Clear the token, go to sign in with a success toast
    history.replaceState(null, "", window.location.pathname);
    App.showView("auth");
    showToast("Password updated — you can now sign in.", "success");
  });

  WS.on("error", msg => {
    // Route errors to the active auth form if we're on auth view
    const activeView = document.querySelector(".view.active");
    if (activeView && activeView.id === "view-auth") {
      const loginVisible = !document.getElementById("form-login").classList.contains("hidden");
      _showError(loginVisible ? "login-error" : "reg-error", msg.message);
    }
  });

  WS.on("_connected", () => {
    // If we have a stored token, re-authenticate
    const token = Auth.token;
    if (token) {
      WS.send({ type: "auth", token });
    }
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _showError(id, msg) {
  const el = document.getElementById(id);
  if (el) el.textContent = msg;
}

function _clearError(id) {
  const el = document.getElementById(id);
  if (el) el.textContent = "";
}

function _checkResetUrl() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("reset");
  if (token) {
    const view = document.getElementById("view-reset");
    view.dataset.token = token;
    App.showView("reset");
    // Clean the token from the URL bar without reloading
    history.replaceState(null, "", window.location.pathname);
  }
}

/** Global toast helper — available everywhere. */
function showToast(message, type = "") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast${type ? " " + type : ""}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}
