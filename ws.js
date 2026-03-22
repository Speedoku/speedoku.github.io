/**
 * ws.js — WebSocket client for Speedoku.
 * Manages the connection, message routing, and reconnection.
 */

// ─── Configuration ──────────────────────────────────────────────────────────
// Change this to your server address before deploying.
const WS_URL = "ws://localhost:8103";

// ─── State ───────────────────────────────────────────────────────────────────
let _socket = null;
let _reconnectTimer = null;
let _reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_DELAY = 1000; // ms

// Handler registry: message type → array of callback functions
const _handlers = {};

// Queue of messages to send once connected
const _sendQueue = [];

// ─── Public API ──────────────────────────────────────────────────────────────

const WS = {
  /**
   * Open the WebSocket connection.
   * @param {string} [token] - Optional JWT token to include in URL for auth.
   */
  connect(token) {
    if (_socket && (_socket.readyState === WebSocket.OPEN || _socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const url = token ? `${WS_URL}?token=${encodeURIComponent(token)}` : WS_URL;
    _socket = new WebSocket(url);

    _socket.addEventListener("open", _onOpen);
    _socket.addEventListener("message", _onMessage);
    _socket.addEventListener("close", _onClose);
    _socket.addEventListener("error", _onError);
  },

  /** Disconnect cleanly (no reconnect). */
  disconnect() {
    _clearReconnect();
    _reconnectAttempts = MAX_RECONNECT_ATTEMPTS; // prevent reconnect
    if (_socket) {
      _socket.close();
      _socket = null;
    }
  },

  /**
   * Send a JSON message.
   * If not connected, queues the message to send on next open.
   */
  send(msg) {
    const data = JSON.stringify(msg);
    if (_socket && _socket.readyState === WebSocket.OPEN) {
      _socket.send(data);
    } else {
      _sendQueue.push(data);
    }
  },

  /**
   * Register a handler for a message type.
   * Multiple handlers per type are supported.
   * @param {string} type - Message type string.
   * @param {function} fn - Handler function receiving the full message object.
   * @returns {function} Unsubscribe function.
   */
  on(type, fn) {
    if (!_handlers[type]) _handlers[type] = [];
    _handlers[type].push(fn);
    return () => {
      _handlers[type] = _handlers[type].filter(h => h !== fn);
    };
  },

  /** Remove all handlers for a type. */
  off(type) {
    delete _handlers[type];
  },

  /** Returns true if the socket is open. */
  get isConnected() {
    return _socket && _socket.readyState === WebSocket.OPEN;
  },
};

// ─── Internal ─────────────────────────────────────────────────────────────────

function _onOpen() {
  console.log("[WS] Connected");
  _reconnectAttempts = 0;
  _clearReconnect();

  // Flush queued messages
  while (_sendQueue.length > 0) {
    _socket.send(_sendQueue.shift());
  }

  _dispatch({ type: "_connected" });
}

function _onMessage(event) {
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch {
    console.warn("[WS] Non-JSON message received:", event.data);
    return;
  }
  _dispatch(msg);
}

function _onClose(event) {
  console.log(`[WS] Closed (code=${event.code})`);
  _dispatch({ type: "_disconnected", code: event.code });
  _scheduleReconnect();
}

function _onError(event) {
  console.warn("[WS] Error:", event);
  _dispatch({ type: "_error", event });
}

function _dispatch(msg) {
  const fns = _handlers[msg.type] || [];
  for (const fn of fns) {
    try { fn(msg); } catch (e) { console.error("[WS] Handler error:", e); }
  }
  // Also dispatch to wildcard handlers
  const wildcards = _handlers["*"] || [];
  for (const fn of wildcards) {
    try { fn(msg); } catch (e) { console.error("[WS] Wildcard handler error:", e); }
  }
}

function _scheduleReconnect() {
  if (_reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.warn("[WS] Max reconnect attempts reached");
    _dispatch({ type: "_reconnect_failed" });
    return;
  }
  const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(1.5, _reconnectAttempts), 15000);
  _reconnectAttempts++;
  console.log(`[WS] Reconnecting in ${Math.round(delay)}ms (attempt ${_reconnectAttempts})`);
  _reconnectTimer = setTimeout(() => {
    const token = localStorage.getItem("speedoku_token");
    WS.connect(token);
  }, delay);
}

function _clearReconnect() {
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
}
