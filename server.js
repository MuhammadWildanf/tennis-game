const express = require('express');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

const app = express();

const PORT = process.env.PORT || 2000;

// Behind a reverse proxy / domain with HTTPS (nginx/Caddy terminating TLS):
// trust X-Forwarded-Proto/Host so QR URLs + unity/info use the public domain.
app.set('trust proxy', true);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ─── Database Setup ──────────────────────────────────────────────────────────
// DB lives in a local SQLite file. Override with DB_PATH env to put it on
// another drive/folder (must be LOCAL disk — never flashdisk/network/OneDrive).
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'tennis.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    total_matches INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    total_score INTEGER DEFAULT 0,
    best_score INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    last_played TEXT
  );

  CREATE TABLE IF NOT EXISTS match_history (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    score INTEGER DEFAULT 0,
    result TEXT NOT NULL,
    opponent TEXT,
    played_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS active_sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'waiting',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS play_clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    round INTEGER NOT NULL,
    click_at TEXT DEFAULT (datetime('now')),
    click_ms INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// Safe migration for DBs created before queue.ready_at existed
try { db.exec('ALTER TABLE queue ADD COLUMN ready_at TEXT'); } catch (_) {}
// Turn tokens are single-use: purpose='turn' dies after score submit, 'login' lives on
try { db.exec("ALTER TABLE active_sessions ADD COLUMN purpose TEXT DEFAULT 'login'"); } catch (_) {}
// Turn token stored on the queue row so Unity can claim it (usher mode)
try { db.exec('ALTER TABLE queue ADD COLUMN turn_token TEXT'); } catch (_) {}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function generateToken() {
  return uuidv4();
}

// Public-facing host/base: honors reverse-proxy headers when present,
// falls back to the direct Host (LAN IP testing). Used for QR content
// and unity/info so they always show the URL players must open.
function publicHost(req) {
  return req.get('x-forwarded-host') || req.get('host');
}
function publicBase(req) {
  return `${req.protocol}://${publicHost(req)}`;
}

function authMiddleware(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  const session = db.prepare('SELECT * FROM active_sessions WHERE token = ?').get(token);
  if (!session) return res.status(401).json({ error: 'Invalid or expired session' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
  if (!user) return res.status(401).json({ error: 'User not found' });

  req.user = user;
  req.token = token;
  next();
}

// ─── HTTP Routes ─────────────────────────────────────────────────────────────

// Signup (alias only — password is optional)
app.post('/api/signup', (req, res) => {
  try {
    let { username, display_name, password } = req.body;

    if (!username) {
      return res.status(400).json({ error: 'Alias is required' });
    }

    username = String(username).toUpperCase().trim();

    if (username.length < 2 || username.length > 12) {
      return res.status(400).json({ error: 'Alias must be 2–12 characters' });
    }

    if (!/^[A-Z0-9]+$/.test(username)) {
      return res.status(400).json({ error: 'Alias can only use letters A–Z and numbers 0–9' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      return res.status(409).json({ error: 'This alias is already taken' });
    }

    const id = uuidv4();
    let hash = '';
    let salt = '';
    if (password) {
      if (String(password).length < 4) {
        return res.status(400).json({ error: 'Password must be at least 4 characters' });
      }
      const hp = hashPassword(String(password));
      hash = hp.hash;
      salt = hp.salt;
    }
    const finalDisplayName = display_name || username;

    db.prepare(
      'INSERT INTO users (id, username, display_name, password_hash, password_salt) VALUES (?, ?, ?, ?, ?)'
    ).run(id, username, finalDisplayName, hash, salt);

    const token = generateToken();
    db.prepare('INSERT INTO active_sessions (token, user_id) VALUES (?, ?)').run(token, id);

    res.status(201).json({
      success: true,
      token,
      user: { id, username, display_name: finalDisplayName }
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Login
app.post('/api/login', (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    if (!user.password_hash) {
      return res.status(401).json({ error: 'This alias has no password. Please register it first.' });
    }

    const { hash } = hashPassword(password, user.password_salt);
    if (hash !== user.password_hash) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = generateToken();
    db.prepare('INSERT INTO active_sessions (token, user_id) VALUES (?, ?)').run(token, user.id);

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        total_matches: user.total_matches,
        wins: user.wins,
        losses: user.losses,
        total_score: user.total_score,
        best_score: user.best_score
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Logout
app.post('/api/logout', authMiddleware, (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  db.prepare('DELETE FROM active_sessions WHERE token = ?').run(token);
  res.json({ success: true });
});

// Get profile
app.get('/api/profile', authMiddleware, (req, res) => {
  const u = req.user;
  res.json({
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    total_matches: u.total_matches,
    wins: u.wins,
    losses: u.losses,
    total_score: u.total_score,
    best_score: u.best_score,
    created_at: u.created_at,
    last_played: u.last_played
  });
});

// Leaderboard
app.get('/api/leaderboard', (req, res) => {
  const sortBy = req.query.sort || 'best_score';
  const validSorts = {
    best_score: 'best_score DESC',
    total_score: 'total_score DESC',
    wins: 'wins DESC',
    win_rate: '(CASE WHEN total_matches > 0 THEN wins * 100.0 / total_matches ELSE 0 END) DESC'
  };

  const orderBy = validSorts[sortBy] || validSorts.best_score;

  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 50;
  if (limit > 50) limit = 50;

  const leaders = db.prepare(`
    SELECT
      id,
      username,
      display_name,
      total_matches,
      wins,
      losses,
      total_score,
      best_score,
      CASE WHEN total_matches > 0 THEN ROUND(wins * 100.0 / total_matches, 1) ELSE 0 END AS win_rate
    FROM users
    WHERE total_matches > 0
    ORDER BY ${orderBy}
    LIMIT ?
  `).all(limit);

  // Tambah rank agar gampang dirender Unity (# + nama + skor)
  res.json(leaders.map((p, i) => ({ rank: i + 1, ...p })));
});

// "Around me" window for the Friends tab: your rank + closest players
app.get('/api/leaderboard/around', authMiddleware, (req, res) => {
  const all = db.prepare(`
    SELECT id, username, display_name, total_matches, wins, losses, best_score
    FROM users
    WHERE total_matches > 0
    ORDER BY best_score DESC
  `).all();

  const idx = all.findIndex((p) => p.id === req.user.id);
  if (idx === -1) {
    return res.json({ rank: null, total: all.length, players: [] });
  }

  const start = Math.max(0, Math.min(idx - 4, all.length - 9));
  const slice = all.slice(start, start + 9).map((p, i) => ({ ...p, rank: start + i + 1 }));

  res.json({ rank: idx + 1, total: all.length, players: slice });
});

// Submit score — Unity calls this when the game ends (turn token burned).
app.post('/api/score', authMiddleware, (req, res) => {
  try {
    const { score, result, opponent } = req.body;
    const userId = req.user.id;

    if (score === undefined || !result) {
      return res.status(400).json({ error: 'Score and result are required' });
    }

    if (!['win', 'loss'].includes(result)) {
      return res.status(400).json({ error: 'Result must be "win" or "loss"' });
    }

    const cleanScore = parseInt(score, 10);
    if (!Number.isFinite(cleanScore) || cleanScore < 0 || cleanScore > 99999) {
      return res.status(400).json({ error: 'Score must be 0–99999' });
    }
    const cleanOpponent = String(opponent || 'AI').slice(0, 32);

    const matchId = uuidv4();
    db.prepare(
      'INSERT INTO match_history (id, user_id, score, result, opponent) VALUES (?, ?, ?, ?, ?)'
    ).run(matchId, userId, cleanScore, result, cleanOpponent);

    const isWin = result === 'win';
    db.prepare(`
      UPDATE users SET
        total_matches = total_matches + 1,
        wins = wins + ?,
        losses = losses + ?,
        total_score = total_score + ?,
        best_score = MAX(best_score, ?),
        last_played = datetime('now')
      WHERE id = ?
    `).run(isWin ? 1 : 0, isWin ? 0 : 1, cleanScore, cleanScore, userId);

    // Free the station: a recorded score ends the turn (usher sees idle).
    // next() afterwards just promotes the earliest waiting player.
    db.prepare("UPDATE queue SET status = 'done', updated_at = datetime('now') WHERE user_id = ? AND status = 'current'").run(userId);

    // End session: turn tokens are single-use, login tokens survive
    db.prepare("DELETE FROM active_sessions WHERE token = ? AND purpose = 'turn'").run(req.token);

    res.json({ success: true, match_id: matchId });
  } catch (err) {
    console.error('Score submit error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Check username availability
app.get('/api/check-username/:username', (req, res) => {
  const { username } = req.params;
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  res.json({ available: !existing, username });
});

// STATIC join QR — print this and place it OUTSIDE the game (poster/banner).
// Anyone scans -> opens /join -> alias -> queue. No code, never expires.
// IMPORTANT: open this URL via the LAN IP (not localhost) so the encoded
// URL points to the LAN address. Server IP must be static for print.
app.get('/qr/join.png', (req, res) => {
  const joinUrl = `${publicBase(req)}/join`;
  QRCode.toBuffer(joinUrl, { width: 1024, margin: 2, errorCorrectionLevel: 'M' })
    .then((buf) => {
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'no-store');
      res.send(buf);
    })
    .catch((err) => {
      console.error('QR generation error:', err);
      res.status(500).send('QR generation failed');
    });
});

// ─── Unity API (documented contract for the Unity client) ───────────────────
// Status check — Unity calls this on boot to verify server reachability.
app.get('/api/status', (req, res) => {
  res.json({ ok: true, version: '1.1.0', server_time: new Date().toISOString() });
});

// Machine-readable integration doc — Unity devs can fetch this to see the contract.
app.get('/api/unity/info', (req, res) => {
  const base = publicBase(req);
  res.json({
    version: '1.1.0',
    http_base: base,
    recommended_flow: 'queue + staff pick (usher-driven)',
    unity_uses_only_these: [
      'GET /api/status (boot check)',
      'GET /qr/join.png (display QR, via LAN IP/domain)',
      'GET /api/queue/state every 2s (who is playing + waiting)',
      'POST /api/queue/claim-turn (take current turn token when new current appears; idempotent; save PlayerPrefs)',
      'GET /api/profile (optional: verify token, best score)',
      'POST /api/score (end of game; burns token)',
      'GET /api/leaderboard?sort=best_score&limit=10 (display, refresh 15-30s)'
    ],
    unity_never_calls: 'POST /api/queue/next, POST /api/queue/pick (staff page does that)',
    queue: {
      display_qr: `STATIC QR, no code needed: ${base}/join`,
      qr_image: 'GET /qr/join.png (request it via LAN IP so content encodes LAN URL; UnityWebRequestTexture works)',
      display_page_web_option: `${base}/display (fullscreen browser: big QR + now-playing + line + top5, auto-refresh; zero Unity UI work for QR)`,
      placements: 'inside (Unity idle screen via /qr/join.png), outside (printed poster), or BOTH at once — same URL, same queue. Concurrent scans never conflict: everyone gets a number.',
      no_wait_to_scan: 'players NEVER wait to scan. Scan anytime (even mid-game) -> join line -> usher picks via /queue.',
      usher_only: 'USHER-ONLY: player does NOT press START. pick/next sets ready=1 instantly. Unity starts the game as soon as a new current appears + claim-turn succeeds.',
      usher_mode_staff_picks: 'staff page {BASE}/queue: POST /api/queue/pick {username, force?} -> picks ANY waiting player (free order). Blocked 409 with need_force when someone is playing unless force:true. With staff pick, Unity does NOT call next() — just polls state. Skip button = POST /api/queue/next (FIFO).',
      unity_poll_state: 'GET /api/queue/state every 2s -> {current:{username, ready, turn_started_at}|null, waiting:[{username, position}], total_waiting}',
      unity_auto_rule: 'every 2s: state=GET /api/queue/state; if new current appears -> POST /api/queue/claim-turn (save token, OVERWRITE old one); then START GAME IMMEDIATELY. After POST /api/score -> back to polling (usher picks next). No next() in usher mode.',
      unity_next: 'POST /api/queue/next = SKIP/FIFO fallback (staff Skip button). Usher-driven flow does NOT use next() from Unity: staff picks via /api/queue/pick, Unity claims via /api/queue/claim-turn.',
      unity_loop_usher: 'poll state 2s -> new current? claim-turn (save token, overwrite PlayerPrefs) -> START GAME IMMEDIATELY -> POST score -> back to polling (usher picks next). No HP START button. Unity never calls next/pick.',
      mobile_join: 'POST /api/queue/join (Bearer alias token) -> {status, position}',
      mobile_status: 'GET /api/queue/my-status every 3s -> position / your-turn',
      mobile_leave: 'POST /api/queue/leave'
    },
    turn_token_single_use: 'token from pick/claim is SINGLE-USE: first successful score submit burns it. Re-submit with same token -> 401. Retry rule: on 401 during submit, do NOT resubmit blindly — verify via GET /api/leaderboard.',
    http: {
      score: 'POST /api/score (Bearer <turn-token>) {score, result, opponent}',
      leaderboard: 'GET /api/leaderboard?sort=best_score&limit=10 -> [{rank, ...}]',
      profile: 'GET /api/profile (Bearer <token>)'
    }
  });
});

// ─── Queue (turn-taking for ONE Unity station) ───────────────────────────────
// Flow: player scans STATIC QR ({BASE}/join) -> alias -> join queue.
// Usher picks via /queue, Unity polls state + claim-turn, score ends turn.
// Each turn gets a FRESH turn token, so /api/score stays unchanged.
// Full catalog: /docs (HTML page).

function queuePosition(userId) {
  const me = db.prepare('SELECT * FROM queue WHERE user_id = ?').get(userId);
  if (!me) return { in_queue: false };
  // Finished/removed turns are history — phone shows thanks + play-again.
  if (me.status !== 'waiting' && me.status !== 'current') {
    return { in_queue: false, finished: true };
  }
  if (me.status === 'current') {
    const waiting = db.prepare("SELECT COUNT(*) AS c FROM queue WHERE status = 'waiting'").get().c;
    return { in_queue: true, status: 'current', position: 1, ahead: 0, waiting_behind: waiting, ready: !!me.ready_at };
  }
  const aheadWaiting = db.prepare(
    "SELECT COUNT(*) AS c FROM queue WHERE status = 'waiting' AND id < ?"
  ).get(me.id).c;
  const hasCurrent = db.prepare("SELECT 1 FROM queue WHERE status = 'current'").get();
  const ahead = aheadWaiting + (hasCurrent ? 1 : 0);
  return { in_queue: true, status: 'waiting', position: ahead + 1, ahead, station_idle: !hasCurrent };
}

// Mobile: join the queue (idempotent — same user gets existing spot back;
// finished players rejoin at the back of the line)
app.post('/api/queue/join', authMiddleware, (req, res) => {
  const ex = db.prepare('SELECT * FROM queue WHERE user_id = ?').get(req.user.id);
  if (!ex) {
    db.prepare("INSERT INTO queue (user_id, status) VALUES (?, 'waiting')").run(req.user.id);
  } else if (ex.status !== 'waiting' && ex.status !== 'current') {
    db.prepare("UPDATE queue SET status = 'waiting', ready_at = NULL, created_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ?").run(req.user.id);
  }
  res.json({
    success: true,
    user: { username: req.user.username, display_name: req.user.display_name },
    ...queuePosition(req.user.id)
  });
});

// Mobile: live position (poll every ~3s on join.html)
app.get('/api/queue/my-status', authMiddleware, (req, res) => {
  res.json(queuePosition(req.user.id));
});

// Mobile: leave the queue (waiting -> removed, current -> marked done)
app.post('/api/queue/leave', authMiddleware, (req, res) => {
  const me = db.prepare('SELECT * FROM queue WHERE user_id = ?').get(req.user.id);
  if (!me) return res.json({ success: true, in_queue: false });
  if (me.status === 'current') {
    db.prepare("UPDATE queue SET status = 'done', updated_at = datetime('now') WHERE user_id = ?").run(req.user.id);
  } else {
    db.prepare('DELETE FROM queue WHERE user_id = ?').run(req.user.id);
  }
  res.json({ success: true });
});

// Unity (public, like leaderboard): who's playing + who's waiting (show only 1 fastest when idle)
app.get('/api/queue/state', (req, res) => {
  const current = db.prepare(`
    SELECT u.username, u.display_name, u.best_score, q.created_at,
           q.updated_at AS turn_started_at, q.ready_at,
           CASE WHEN q.ready_at IS NOT NULL THEN 1 ELSE 0 END AS ready
    FROM queue q JOIN users u ON u.id = q.user_id
    WHERE q.status = 'current'
  `).get() || null;
  let waiting = db.prepare(`
    SELECT u.username, u.display_name, q.created_at
    FROM queue q JOIN users u ON u.id = q.user_id
    WHERE q.status = 'waiting'
    ORDER BY q.id ASC
  `).all().map((p, i) => ({ position: (current ? 1 : 0) + i + 1, ...p }));
  // Rebutan mode: when idle, show only 1 fastest (smallest click_ms in current round)
  if (!current && waiting.length > 1) {
    const r = currentRound;
    const winner = db.prepare('SELECT username FROM play_clicks WHERE round=? ORDER BY click_ms ASC, id ASC LIMIT 1').get(r);
    if (winner) waiting = waiting.filter(w => w.username === winner.username).slice(0,1);
  }
  res.json({ current, waiting, total_waiting: waiting.length });
});

// Unity: advance to next player. Marks current done, promotes earliest
// waiting, issues a FRESH game token for them. Call on boot (if idle),
// after score submit, or to skip a no-show.
app.post('/api/queue/next', (req, res) => {
  db.prepare("UPDATE queue SET status = 'done', updated_at = datetime('now') WHERE status = 'current'").run();
  const next = db.prepare(`
    SELECT u.id, u.username, u.display_name
    FROM queue q JOIN users u ON u.id = q.user_id
    WHERE q.status = 'waiting'
    ORDER BY q.id ASC LIMIT 1
  `).get();

  if (!next) return res.json({ current: null, waiting_count: 0 });

  db.prepare("UPDATE queue SET status = 'current', ready_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ?").run(next.id);
  const token = generateToken();
  db.prepare("INSERT INTO active_sessions (token, user_id, purpose) VALUES (?, ?, 'turn')").run(token, next.id);
  db.prepare('UPDATE queue SET turn_token = ? WHERE user_id = ?').run(token, next.id);

  const waiting_count = db.prepare("SELECT COUNT(*) AS c FROM queue WHERE status = 'waiting'").get().c;
  res.json({
    current: {
      token,
      user: { id: next.id, username: next.username, display_name: next.display_name }
    },
    waiting_count
  });
});

// ─── Queue staff pick (usher page calls pick; Unity just polls state) ───────
// USHER-ONLY MODE: pick = auto-ready. Player TIDAK perlu tekan START di HP.
// Unity langsung main begitu current baru muncul + claim-turn berhasil.
app.post('/api/queue/pick', (req, res) => {
  const { username, force } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Missing username' });

  const user = db.prepare('SELECT id, username, display_name FROM users WHERE username = ?').get(String(username).toUpperCase());
  if (!user) return res.status(404).json({ error: 'User not found' });

  const entry = db.prepare('SELECT * FROM queue WHERE user_id = ?').get(user.id);
  if (!entry || entry.status !== 'waiting') {
    return res.status(409).json({ error: `${user.username} is not waiting (already playing or finished)` });
  }

  const live = db.prepare("SELECT username, ready_at FROM queue q JOIN users u ON u.id = q.user_id WHERE q.status = 'current'").get();
  if (live && live.ready_at && !force) {
    return res.status(409).json({ error: `${live.username} is playing now — finish/skip first or force pick`, playing: live.username, need_force: true });
  }

  db.prepare("UPDATE queue SET status = 'done', updated_at = datetime('now') WHERE status = 'current'").run();
  db.prepare("UPDATE queue SET status = 'current', ready_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ?").run(user.id);
  const token = generateToken();
  db.prepare("INSERT INTO active_sessions (token, user_id, purpose) VALUES (?, ?, 'turn')").run(token, user.id);
  db.prepare('UPDATE queue SET turn_token = ? WHERE user_id = ?').run(token, user.id);

  const waiting_count = db.prepare("SELECT COUNT(*) AS c FROM queue WHERE status = 'waiting'").get().c;
  res.json({
    current: { token, user: { id: user.id, username: user.username, display_name: user.display_name } },
    waiting_count
  });
});

// Unity (usher mode): claim the current turn's token. Idempotent — same token
// returned every call while the turn is live, so a Unity restart/resume is safe.
// Save to PlayerPrefs. 409 = turn already over (score recorded), wait for next pick.
app.post('/api/queue/claim-turn', (req, res) => {
  const cur = db.prepare(`
    SELECT u.id, u.username, u.display_name, q.turn_token
    FROM queue q JOIN users u ON u.id = q.user_id
    WHERE q.status = 'current'
  `).get();
  if (!cur) return res.status(404).json({ error: 'No one is playing right now' });

  if (cur.turn_token) {
    const live = db.prepare('SELECT 1 FROM active_sessions WHERE token = ?').get(cur.turn_token);
    if (live) {
      return res.json({ token: cur.turn_token, user: { id: cur.id, username: cur.username, display_name: cur.display_name } });
    }
    return res.status(409).json({ error: 'Turn is over — score already recorded, wait for next pick' });
  }

  // Legacy row without a stored token: issue one now
  const token = generateToken();
  db.prepare("INSERT INTO active_sessions (token, user_id, purpose) VALUES (?, ?, 'turn')").run(token, cur.id);
  db.prepare('UPDATE queue SET turn_token = ? WHERE user_id = ?').run(token, cur.id);
  res.json({ token, user: { id: cur.id, username: cur.username, display_name: cur.display_name } });
});

// ─── Admin API (dashboard — OPEN on LAN, no key by request) ─────────────────

app.get('/api/admin/stats', (req, res) => {
  const users_total = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const users_played = db.prepare('SELECT COUNT(*) AS c FROM users WHERE total_matches > 0').get().c;
  const matches = db.prepare(
    "SELECT COUNT(*) AS c, COALESCE(SUM(CASE WHEN result='win' THEN 1 ELSE 0 END),0) AS wins FROM match_history"
  ).get();
  res.json({
    users_total, users_played,
    matches_total: matches.c, wins: matches.wins,
    server_time: new Date().toISOString()
  });
});

app.get('/api/admin/matches', (req, res) => {
  const rows = db.prepare(`
    SELECT m.id, m.score, m.result, m.opponent, m.played_at,
           u.username, u.display_name
    FROM match_history m JOIN users u ON u.id = m.user_id
    ORDER BY m.played_at DESC LIMIT 50
  `).all();
  res.json(rows);
});

app.get('/api/admin/queue', (req, res) => {
  const rows = db.prepare(`
    SELECT q.id, q.status, q.created_at, q.updated_at, q.ready_at,
           u.username, u.display_name
    FROM queue q JOIN users u ON u.id = q.user_id
    WHERE q.status IN ('waiting', 'current')
    ORDER BY q.id ASC
  `).all();
  res.json(rows);
});

// Rebutan PLAY after done: player clicks PLAY, fastest wins the next turn.
// Data kept in play_clicks for comparison (who clicked when).
let currentRound = 1;
try { const r = db.prepare('SELECT MAX(round) as m FROM play_clicks').get(); if (r && r.m) currentRound = r.m; } catch(_){}
function getRound() {
  const hasCurrent = db.prepare("SELECT 1 FROM queue WHERE status='current'").get();
  if (!hasCurrent) {
    const waiting = db.prepare("SELECT COUNT(*) as c FROM queue WHERE status='waiting'").get().c;
    if (waiting === 0) currentRound += 1;
  }
  return currentRound;
}
app.post('/api/queue/compete', authMiddleware, (req, res) => {
  const ms = Date.now();
  const round = getRound();
  try { db.prepare('INSERT INTO play_clicks (user_id, username, round, click_ms) VALUES (?,?,?,?)').run(req.user.id, req.user.username, round, ms); } catch(_) {}

  const hasCurrent = db.prepare("SELECT 1 FROM queue WHERE status='current'").get();
  if (hasCurrent) {
    const pos = queuePosition(req.user.id);
    return res.json({ success: false, reason: 'playing', position: pos.position || null, message: 'Someone is playing — please wait' });
  }
  // No one playing: record click, pick fastest for display (not auto current — wait usher pick)
  const ex = db.prepare('SELECT * FROM queue WHERE user_id=?').get(req.user.id);
  if (!ex) db.prepare("INSERT INTO queue (user_id, status) VALUES (?, 'waiting')").run(req.user.id);
  else if (ex.status !== 'waiting' && ex.status !== 'current') db.prepare("UPDATE queue SET status='waiting', ready_at=NULL WHERE user_id=?").run(req.user.id);
  const winner = db.prepare('SELECT user_id, username FROM play_clicks WHERE round=? ORDER BY click_ms ASC, id ASC LIMIT 1').get(round);
  const isWinner = winner && winner.user_id === req.user.id;
  if (isWinner) {
    return res.json({ success: true, winner: true, username: req.user.username, round });
  } else {
    const wname = winner ? winner.username : null;
    const pos = queuePosition(req.user.id);
    return res.json({ success: true, winner: false, winner_username: wname, position: pos.position || null, round });
  }
});
app.get('/api/queue/clicks', (req, res) => {
  const round = parseInt(req.query.round,10) || currentRound;
  const rows = db.prepare('SELECT username, click_ms, datetime(click_at) as click_at FROM play_clicks WHERE round=? ORDER BY click_ms ASC').all(round);
  res.json({ round, clicks: rows });
});
app.get('/api/admin/clicks', (req, res) => {
  const rows = db.prepare('SELECT round, username, click_ms, datetime(click_at) as at FROM play_clicks ORDER BY round DESC, click_ms ASC LIMIT 100').all();
  res.json(rows);
});

// Admin reset (temp): clear queue + clicks
app.post('/api/admin/reset', (req, res) => {
  db.prepare("DELETE FROM queue").run();
  try { db.prepare("DELETE FROM play_clicks").run(); } catch(_){}
  currentRound += 1;
  res.json({ success: true });
});
app.post('/api/admin/end-game', (req, res) => {
  db.prepare("UPDATE queue SET status='done', updated_at=datetime('now') WHERE status='current'").run();
  currentRound += 1;
  res.json({ success: true });
});
// Staff removes someone from the queue (no-show / duplicate / flood).
app.post('/api/admin/queue/remove', (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Missing username' });
  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(String(username).toUpperCase());
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare("DELETE FROM queue WHERE user_id = ?").run(user.id);
  res.json({ success: true, username: String(username).toUpperCase() });
});

// ─── Start Server ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const os = require('os');
  const lans = [];
  for (const ifs of Object.values(os.networkInterfaces())) {
    for (const nic of ifs || []) {
      if (nic.family === 'IPv4' && !nic.internal) lans.push(nic.address);
    }
  }
  console.log(`\n  🎾 Tennis Game Server`);
  console.log(`  ─────────────────────`);
  console.log(`  DB:            ${DB_PATH}`);
  console.log(`  HTTP (this PC):  http://localhost:${PORT}`);
  if (lans.length) {
    console.log(`  ── Open these from phones / Unity on the same WiFi ──`);
    for (const ip of lans) {
      console.log(`  HTTP (LAN):      http://${ip}:${PORT}`);
    }
  } else {
    console.log(`  (No LAN IPv4 found — check WiFi connection)`);
  }
  console.log(`  Admin dashboard (open, no key): see /admin on any HTTP URL above\n`);
});
