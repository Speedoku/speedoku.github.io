# Speedoku

Real-time competitive Sudoku. Solve the same puzzle as your opponents simultaneously. Watch their boards fill up. Win first.

---

## Quick Start

### 1. Install dependencies

```bash
pip install websockets bcrypt PyJWT
```

### 2. Generate the puzzle bank

This is a one-time step. It pre-generates 500 puzzles (easy/medium/hard) and writes them to `puzzles.json`.

```bash
python generate_puzzles.py
```

Options:
```bash
python generate_puzzles.py --count 200 --output puzzles.json
```

Generation takes a few minutes for 500 puzzles. The file is ~2–4 MB.

### 3. Run the server

```bash
python server.py
```

Options:
```bash
python server.py --port 8103 --host 0.0.0.0
```

Default: binds to `0.0.0.0:8103`.

### 4. Open the frontend

Open `index.html` directly in a browser, or serve it statically:

```bash
# Python simple server
python -m http.server 8080
# then open http://localhost:8080
```

---

## Frontend Configuration

The WebSocket URL is a single constant at the top of `ws.js`:

```js
const WS_URL = "ws://localhost:8103";
```

Change this to your server's address before deploying:

```js
const WS_URL = "wss://speedoku.net";
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SPEEDOKU_JWT_SECRET` | `change-me-in-production-please` | JWT signing secret — **always set this in production** |
| `SPEEDOKU_DB` | `speedoku.db` | Path to the SQLite database file |
| `SPEEDOKU_PUZZLES` | `puzzles.json` | Path to the puzzle bank JSON |

Example:
```bash
SPEEDOKU_JWT_SECRET=my-secret python server.py --port 8103
```

---

## File Structure

```
speedoku/
├── index.html          — Single-page frontend (all views)
├── style.css           — Precision Noir design system
├── app.js              — View routing, lobby, post-game, profile
├── game.js             — Board rendering, input, opponent boards
├── ws.js               — WebSocket client, reconnect, message routing
├── auth.js             — Login/register forms, token management
├── server.py           — Python WebSocket server (entry point)
├── db.py               — SQLite helpers (users, ELO, game history)
├── puzzles.py          — Sudoku generator, solver, validator
├── generate_puzzles.py — One-time puzzle bank generation script
├── puzzles.json        — Pre-generated puzzle bank (gitignore optional)
└── speedoku.db         — SQLite database (gitignore this)
```

---

## GitHub Pages Deployment

The frontend is pure static files — no build step required.

1. Push the repo to GitHub.
2. Go to **Settings → Pages** → set source to the `main` branch, root `/`.
3. GitHub will serve `index.html` at `https://yourusername.github.io/speedoku/`.
4. Update `WS_URL` in `ws.js` to point to your server (`wss://speedoku.net`).

**Custom domain** (`speedoku.net`):
- Add a `CNAME` file to the repo root containing `speedoku.net`.
- In your DNS provider, add a `CNAME` record pointing `www` → `yourusername.github.io`.
- For the apex domain (`speedoku.net`), add four `A` records pointing to GitHub Pages IPs:
  `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`.

---

## Cloudflare Proxy Setup

Cloudflare proxies both HTTP (for the static site, if self-hosted) and WebSocket traffic.

1. Add your domain to Cloudflare.
2. Add an **A record**: `speedoku.net` → your server IP, **orange-cloud (proxied)** enabled.
3. Cloudflare supports WebSocket proxying by default — no special config needed for WSS.
4. Set SSL/TLS mode to **Full (strict)** if your server has a certificate, or **Flexible** for HTTP origins.
5. The frontend uses `wss://speedoku.net` (Cloudflare terminates TLS, proxies to your server).
6. In **Network → WebSockets**, ensure WebSocket support is enabled (it's on by default for paid plans; free tier also supports it).

**Origin server config**: run `server.py` on port 8103 (or any port). Cloudflare's proxy handles the public-facing port 443. No need to expose port 8103 publicly — Cloudflare connects to it from their edge.

---

## Game Modes

| Mode | ELO | Lives | Players |
|---|---|---|---|
| 1v1 Ranked | Yes | No | 2 |
| 1v1 Casual | No | No | 2 |
| Private Lobby | No | Optional (0–5) | 2–8 |

---

## ELO Tiers

| Tier | ELO Range |
|---|---|
| Beginner | < 1000 |
| Intermediate | 1000–1199 |
| Advanced | 1200–1399 |
| Expert | 1400–1599 |
| Master | 1600+ |

Starting ELO: **1200**. K-factor: **32** for first 20 games, **16** thereafter.

---

## Security Notes

- The puzzle solution is **never sent to the client**. All move validation is server-side.
- Passwords are hashed with bcrypt.
- JWT tokens expire after 30 days.
- Move rate limiting: max 2 moves/second per player (excess silently dropped).
- Set `SPEEDOKU_JWT_SECRET` to a strong random value in production.
