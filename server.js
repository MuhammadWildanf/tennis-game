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
// Halaman usher: /control. /controll (typo lama) & /queue tetap redirect ke sana.
app.get('/queue', (req, res) => res.redirect(301, '/control'));
app.get('/controll', (req, res) => res.redirect(301, '/control'));
app.get('/control', (req, res) => res.sendFile(path.join(__dirname, 'public', 'queue.html')));
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

// ─── Event log + Health (ring buffer in-memory, tampil di /admin tab Logs) ───
const SERVER_STARTED_AT = Date.now();
const EVENT_LOGS = [];
const EVENT_LOG_MAX = 500;
function logEvent(level, event, detail) {
  try {
    EVENT_LOGS.push({ ts: new Date().toISOString(), level, event, detail: detail ?? null });
    if (EVENT_LOGS.length > EVENT_LOG_MAX) EVENT_LOGS.splice(0, EVENT_LOGS.length - EVENT_LOG_MAX);
  } catch (_) {}
  if (level === 'error') { try { console.error(`[event:${event}]`, detail ?? ''); } catch (_) {} }
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
      return res.status(409).json({ error: 'Nickname already taken, please enter a new nickname' });
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
    best_score: { sql: 'best_score DESC', key: (p) => p.best_score },
    total_score: { sql: 'total_score DESC', key: (p) => p.total_score },
    wins: { sql: 'wins DESC', key: (p) => p.wins },
    win_rate: { sql: '(CASE WHEN total_matches > 0 THEN wins * 100.0 / total_matches ELSE 0 END) DESC', key: (p) => p.win_rate }
  };

  const sort = validSorts[sortBy] || validSorts.best_score;

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
    ORDER BY ${sort.sql}, total_score DESC, wins DESC, username ASC
    LIMIT ?
  `).all(limit);

  // Rank kompetisi: skor sama = rank sama (1,1,3), bukan 1,2,3
  let rank = 0;
  let prevKey = Symbol('none');
  res.json(leaders.map((p, i) => {
    const k = sort.key(p);
    if (k !== prevKey) { rank = i + 1; prevKey = k; }
    return { rank, ...p };
  }));
});

// "Around me" window for the Friends tab: your rank + closest players
app.get('/api/leaderboard/around', authMiddleware, (req, res) => {
  const all = db.prepare(`
    SELECT id, username, display_name, total_matches, wins, losses, best_score
    FROM users
    WHERE total_matches > 0
    ORDER BY best_score DESC, total_score DESC, wins DESC, username ASC
  `).all();

  const idx = all.findIndex((p) => p.id === req.user.id);
  if (idx === -1) {
    return res.json({ rank: null, total: all.length, players: [] });
  }

  const compRank = (i) => {
    let r = 1;
    for (let k = 0; k < i; k++) if (all[k].best_score !== all[i].best_score) r = k + 2 > r ? k + 2 : r;
    // rank kompetisi: 1 + yang skornya strictly lebih besar
    let better = 0;
    for (let k = 0; k < all.length && all[k].best_score > all[i].best_score; k++) better++;
    return better + 1;
  };

  const start = Math.max(0, Math.min(idx - 4, all.length - 9));
  const slice = all.slice(start, start + 9).map((p, i) => ({ ...p, rank: compRank(start + i) }));

  res.json({ rank: compRank(idx), total: all.length, players: slice });
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
      'GET /api/queue/state every 2s (who is playing + waiting + display_mode + unity_home)',
      'POST /api/unity/home every 2s ({at_home:true} while HOME screen showing — REQUIRED, READY stays locked without fresh heartbeat)',
      'GET /api/display/mode every 2-3s (game|leaderboard|howtoplay — admin forces Unity screen)',
      'POST /api/queue/claim-turn (take current turn token when new current appears; idempotent; save PlayerPrefs)',
      'GET /api/profile (optional: verify token, best score)',
      'POST /api/score (end of game; burns token)',
      'GET /api/leaderboard?sort=best_score&limit=10 (display, refresh 15-30s, fullscreen when display_mode=leaderboard)'
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
      unity_poll_state: 'GET /api/queue/state every 2s -> {current:{username, ready, turn_started_at}|null, waiting:[{username, position}], total_waiting, display_mode:"game"|"leaderboard"|"howtoplay"}',
      unity_display_mode: 'ADMIN forces Unity screen: POST /api/admin/display-mode {mode:"game"|"leaderboard"|"howtoplay"}. leaderboard = show LB fullscreen + DO NOT claim/start new game (READY locked server-side: join->409 reason=leaderboard). howtoplay = show How-To-Play fullscreen (info only, READY stays open, Unity still claims/starts). game = back to normal QR/now-playing loop.',
      unity_home_heartbeat: 'READY GATE: Unity must POST /api/unity/home {at_home:true} every ~2s while its HOME screen is showing (send false when leaving home). Server opens READY only with a heartbeat fresher than 8s; otherwise join->409 reason=unity-not-ready. State + display/mode expose unity_home so HP/admin can show "Unity getting ready".',
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

// ─── Unity display mode (controlled from Admin) ─────────────────────────────
// 'game' = normal (Unity shows QR / now-playing + player name on READY).
// 'leaderboard' = admin forces Unity to show LEADERBOARD fullscreen +
//                 all HP READY buttons are locked (no new current can appear).
// 'howtoplay' = admin forces Unity to show HOW TO PLAY fullscreen (info only,
//               does NOT lock READY — players can still join and play).
let unityDisplayMode = 'game';

// Public (Unity + HP poll this): which screen should Unity show?
app.get('/api/display/mode', (req, res) => {
  res.json({ mode: unityDisplayMode, unity_home: unityHomeFresh() });
});

// Admin: switch Unity screen. Called by the mode buttons in /admin.
app.post('/api/admin/display-mode', (req, res) => {
  const { mode } = req.body || {};
  if (!['game', 'leaderboard', 'howtoplay'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be "game", "leaderboard" or "howtoplay"' });
  }
  unityDisplayMode = mode;
  logEvent('info', 'display-mode', mode);
  res.json({ success: true, mode: unityDisplayMode });
});

// ─── Unity home heartbeat (gate for READY) ─────────────────────────────────
// Unity POSTs {at_home:true} every ~2s while its HOME/idle screen is showing.
// Players can press READY only while a FRESH home heartbeat exists (TTL 8s).
// Unity offline / playing / takeover screen / crashed => READY locked.
const UNITY_HOME_TTL_MS = 8000;
let unityHomeAtMs = 0;
function unityHomeFresh() {
  return Date.now() - unityHomeAtMs < UNITY_HOME_TTL_MS;
}

// Unity: "saya di home". No auth (LAN). Call every ~2s alongside state polling.
app.post('/api/unity/home', (req, res) => {
  const { at_home } = req.body || {};
  if (typeof at_home !== 'boolean') {
    return res.status(400).json({ error: 'at_home must be true or false' });
  }
  unityHomeAtMs = at_home ? Date.now() : 0; // false = lock READY immediately
  res.json({ success: true, at_home, unity_home: unityHomeFresh(), server_time: new Date().toISOString() });
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
  // Leaderboard takeover: lock READY for everyone (admin owns the Unity screen).
  // How-to-play is info only: does NOT lock READY.
  if (unityDisplayMode === 'leaderboard') {
    return res.status(409).json({ error: 'Leaderboard is showing — please wait', reason: 'leaderboard' });
  }
  // Unity not home (offline/playing/takeover screen): lock READY until fresh heartbeat
  if (!unityHomeFresh()) {
    return res.status(409).json({ error: 'Unity is not ready — please wait', reason: 'unity-not-ready' });
  }
  const ex = db.prepare('SELECT * FROM queue WHERE user_id = ?').get(req.user.id);
  // Gabung (baru) hanya saat stasiun bebas: tidak ada yang main & tidak ada yang antre.
  // Yang sudah di dalam (waiting/current) tetap boleh (idempotent).
  if (!ex || (ex.status !== 'waiting' && ex.status !== 'current')) {
    const busy = db.prepare("SELECT 1 FROM queue WHERE status = 'current'").get()
      || db.prepare("SELECT 1 FROM queue WHERE status = 'waiting' AND user_id != ?").get(req.user.id);
    if (busy) return res.status(409).json({ error: 'Station is busy — please try again later', reason: 'playing' });
  }
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

// Unity (public, like leaderboard): who's playing + who's waiting (idle tampil 0 sampai PLAY diklik)
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
  if (!current) {
    const r = currentRound;
    const winner = db.prepare('SELECT username FROM play_clicks WHERE round=? ORDER BY click_ms ASC, id ASC LIMIT 1').get(r);
    // Ada pemenang ronde ini: tampilkan dia. Pemenang sudah tidak antre
    // (mis. di-cancel) atau ronde basi: tampilkan semua agar tak ada yang hilang.
    if (winner) {
      const f = waiting.filter(w => w.username === winner.username).slice(0, 1);
      waiting = f.length ? f : waiting;
    }
  }
  res.json({ current, waiting, total_waiting: waiting.length, display_mode: unityDisplayMode, unity_home: unityHomeFresh() });
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

// PLAY after done: player clicks PLAY, fastest wins the next turn.
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
  // Leaderboard takeover: lock READY for everyone. How-to-play does NOT lock.
  if (unityDisplayMode === 'leaderboard') {
    return res.json({ success: false, reason: 'leaderboard', message: 'Leaderboard is showing — please wait' });
  }
  // Unity not home: lock READY until fresh heartbeat
  if (!unityHomeFresh()) {
    return res.json({ success: false, reason: 'unity-not-ready', message: 'Unity is not ready — please wait' });
  }
  // Satu waktu cuma 1 pemain: tolak kalau stasiun sibuk (ada yang main)
  // atau sudah ada yang antre (selain diri sendiri).
  const hasCurrent = db.prepare("SELECT 1 FROM queue WHERE status='current'").get();
  if (hasCurrent) {
    const pos = queuePosition(req.user.id);
    return res.json({ success: false, reason: 'playing', position: pos.position || null, message: 'Someone is playing — please wait' });
  }
  const othersWaiting = db.prepare("SELECT COUNT(*) AS c FROM queue WHERE status='waiting' AND user_id != ?").get(req.user.id).c;
  if (othersWaiting > 0) {
    return res.json({ success: false, reason: 'playing', position: null, message: 'Someone is in line — please try again later' });
  }

  const ms = Date.now();
  const round = getRound();
  try { db.prepare('INSERT INTO play_clicks (user_id, username, round, click_ms) VALUES (?,?,?,?)').run(req.user.id, req.user.username, round, ms); } catch(_) {}
  // No one playing: record click, pick fastest for display (usher-driven:
  // HP PLAY cuma antre, Unity baru mulai setelah usher klik PLAY di /queue,
  // atau usher klik X untuk batalkan pemain)
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

// Admin reset single queue
app.post('/api/admin/reset', (req, res) => {
  db.prepare("DELETE FROM queue").run();
  try { db.prepare("DELETE FROM play_clicks").run(); } catch(_){}
  currentRound += 1;
  unityDisplayMode = 'game';
  logEvent('warn', 'reset-queue', `round=${currentRound}`);
  res.json({ success: true, mode: unityDisplayMode });
});
// Admin reset all data (queue + history + leaderboard + users)
app.post('/api/admin/reset-all', (req, res) => {
  db.prepare("DELETE FROM queue").run();
  try { db.prepare("DELETE FROM play_clicks").run(); } catch(_){}
  db.prepare("DELETE FROM match_history").run();
  db.prepare("DELETE FROM active_sessions").run();
  db.prepare("DELETE FROM users").run();
  currentRound = 1;
  unityDisplayMode = 'game';
  logEvent('warn', 'reset-all', 'all data cleared');
  res.json({ success: true, mode: unityDisplayMode });
});
app.post('/api/admin/end-game', (req, res) => {
  const cur = db.prepare("SELECT user_id, username FROM queue q JOIN users u ON u.id=q.user_id WHERE q.status='current'").get();
  db.prepare("UPDATE queue SET status='done', updated_at=datetime('now') WHERE status='current'").run();
  if (cur) try { db.prepare("DELETE FROM active_sessions WHERE user_id=? AND purpose='turn'").run(cur.user_id); } catch(_){}
  // Ronde baru hanya kalau ada game yang benar-benar berakhir (idle-SKIP tidak memajukan ronde)
  if (cur) currentRound += 1;
  logEvent('info', 'end-game', cur ? cur.username : 'no-game');
  res.json({ success: true, ended: cur ? cur.username : null });
});
app.get('/api/admin/backup', (req, res) => {
  const users = db.prepare('SELECT * FROM users').all();
  const queue = db.prepare('SELECT q.*, u.username FROM queue q JOIN users u ON u.id=q.user_id').all();
  const history = db.prepare('SELECT * FROM match_history ORDER BY played_at DESC LIMIT 500').all();
  let clicks = [];
  try { clicks = db.prepare('SELECT * FROM play_clicks ORDER BY round, click_ms').all(); } catch(_){}
  res.json({ server_time: new Date().toISOString(), users, queue, history, clicks });
});
app.get('/api/admin/export', (req, res) => {
  const rows = db.prepare(`
    SELECT u.username, u.display_name, u.total_matches, u.wins, u.losses, u.best_score, u.total_score,
           (CASE WHEN u.total_matches>0 THEN ROUND(u.wins*100.0/u.total_matches,1) ELSE 0 END) as win_rate,
           u.last_played
    FROM users u ORDER BY u.best_score DESC
  `).all();
  const header = 'rank,username,display_name,total_matches,wins,losses,best_score,total_score,win_rate,last_played';
  const csv = [header, ...rows.map((r,i)=> `${i+1},${r.username},${r.display_name},${r.total_matches},${r.wins},${r.losses},${r.best_score},${r.total_score},${r.win_rate},${r.last_played||''}`)].join('\n');
  res.set('Content-Type','text/csv');
  res.set('Content-Disposition','attachment; filename="leaderboard.csv"');
  res.send(csv);
});
// Staff removes someone from the queue (no-show / duplicate / flood).
app.post('/api/admin/queue/remove', (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Missing username' });
  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(String(username).toUpperCase());
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare("DELETE FROM queue WHERE user_id = ?").run(user.id);
  // Batalkan juga token gilirannya supaya Unity langsung idle + nama hilang
  try { db.prepare("DELETE FROM active_sessions WHERE user_id = ? AND purpose = 'turn'").run(user.id); } catch (_) {}
  logEvent('warn', 'queue-remove', String(username).toUpperCase());
  res.json({ success: true, username: String(username).toUpperCase() });
});

// Admin: hapus permanen 1 user + semua datanya (queue, history, clicks, sessions).
// Dipakai dari /admin tombol 🗑 di tab Leaderboard.
app.delete('/api/admin/users/:username', (req, res) => {
  const uname = String(req.params.username || '').toUpperCase().trim();
  if (!uname) return res.status(400).json({ error: 'Missing username' });
  const user = db.prepare('SELECT id, username FROM users WHERE username = ?').get(uname);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const delAll = db.transaction((uid) => {
    db.prepare('DELETE FROM queue WHERE user_id = ?').run(uid);
    try { db.prepare('DELETE FROM play_clicks WHERE user_id = ?').run(uid); } catch (_) {}
    db.prepare('DELETE FROM match_history WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM active_sessions WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM users WHERE id = ?').run(uid);
  });
  try {
    delAll(user.id);
  } catch (err) {
    console.error('Delete user error:', err);
    return res.status(500).json({ error: 'Failed to delete user' });
  }
  logEvent('warn', 'user-delete', user.username);
  res.json({ success: true, username: user.username });
});

// ─── Health + Event log (untuk tab Logs di /admin) ───────────────────────────
app.get('/api/health', (req, res) => {
  let dbOk = false;
  try { db.prepare('SELECT 1').get(); dbOk = true; } catch (_) {}
  res.json({
    ok: dbOk,
    uptime_s: Math.floor((Date.now() - SERVER_STARTED_AT) / 1000),
    started_at: new Date(SERVER_STARTED_AT).toISOString(),
    server_time: new Date().toISOString(),
    db_ok: dbOk,
    unity_home: unityHomeFresh(),
    display_mode: unityDisplayMode,
    version: '1.1.0'
  });
});

app.get('/api/admin/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const level = req.query.level;
  const rows = (level ? EVENT_LOGS.filter((e) => e.level === level) : EVENT_LOGS).slice(-limit).reverse();
  res.json({ count: rows.length, total: EVENT_LOGS.length, logs: rows });
});

// Error handler — catat URL + body ringkas supaya log PM2 / tab Logs jelas.
// (Contoh: JSON rusak dari HP/Unity, atau SqliteError seperti u.username kemarin.)
// NOTE: harus 4 argumen + dipasang SEBELUM app.listen agar Express pakai ini.
app.use((err, req, res, _next) => {
  const where = `${req.method} ${req.originalUrl || req.url}`;
  if (err && err.type === 'entity.parse.failed') {
    logEvent('error', 'bad-json', `${where} :: ${err.message}`);
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  logEvent('error', 'unhandled', `${where} :: ${(err && err.message) || err}`);
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
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
