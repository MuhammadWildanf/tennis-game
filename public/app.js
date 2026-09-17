'use strict';

// ─── State ──────────────────────────────────────────────────────────────────
let authToken = localStorage.getItem('ct_token') || null;
let currentUser = null;
let lbTab = 'global';

// ─── Helpers ────────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ─── Registration (alias only) ──────────────────────────────────────────────
const aliasInput = $('#alias-input');
const availEl = $('#alias-avail');
let checkTimer = null;
let lastChecked = '';

aliasInput.addEventListener('input', () => {
  // Force uppercase A–Z 0–9
  const clean = aliasInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  if (clean !== aliasInput.value) aliasInput.value = clean;

  const v = clean;
  availEl.textContent = '';
  availEl.className = 'alias-avail';
  aliasInput.classList.remove('err');
  $('#alias-error').classList.remove('show');
  lastChecked = '';

  if (v.length >= 2) {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(() => checkAlias(v), 400);
  }
});

async function checkAlias(alias) {
  if (alias === lastChecked) return;
  lastChecked = alias;
  try {
    const data = await api(`/api/check-username/${encodeURIComponent(alias)}`);
    availEl.textContent = data.available ? '✓ Alias available' : '✗ Already taken';
    availEl.className = 'alias-avail ' + (data.available ? 'ok' : 'bad');
    if (!data.available) aliasInput.classList.add('err');
  } catch (_) {
    lastChecked = '';
  }
}

$('#alias-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const alias = aliasInput.value.trim().toUpperCase();
  const errEl = $('#alias-error');

  errEl.classList.remove('show');
  if (alias.length < 2 || alias.length > 12) {
    errEl.textContent = 'Alias must be 2–12 characters.';
    errEl.classList.add('show');
    return;
  }
  if (!/^[A-Z0-9]+$/.test(alias)) {
    errEl.textContent = 'Alias can only use letters A–Z and numbers 0–9.';
    errEl.classList.add('show');
    return;
  }

  const btn = $('#ready-btn');
  setLoading(btn, true);
  try {
    const data = await api('/api/signup', { method: 'POST', body: JSON.stringify({ username: alias }) });
    authToken = data.token;
    localStorage.setItem('ct_token', authToken);
    currentUser = data.user;
    enterApp();
    showToast(`Welcome to the court, ${data.user.username}! 🎾`);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.add('show');
  } finally {
    setLoading(btn, false);
  }
});

function setLoading(btn, loading) {
  btn.querySelector('.btn-label').textContent = loading ? '' : 'Ready';
  btn.querySelector('.btn-spinner').style.display = loading ? 'inline-block' : 'none';
  btn.disabled = loading;
}

function logout() {
  if (authToken) api('/api/logout', { method: 'POST' }).catch(() => {});
  authToken = null;
  currentUser = null;
  localStorage.removeItem('ct_token');
  location.reload();
}

// ─── Enter app ──────────────────────────────────────────────────────────────
function enterApp() {
  $('#regis-section').classList.add('hidden');
  $('#join-section').classList.remove('hidden');

  $('#player-chip').classList.remove('hidden');
  $('#chip-avatar').textContent = currentUser.username.charAt(0);
  $('#chip-name').textContent = currentUser.username;
  $('#chip-best').textContent = `BEST ${currentUser.best_score ?? 0}`;

  loadLeaderboard();
}

// ─── Leaderboard (auto-refresh so Mobile shows new scores after End Game) ────
const LB_REFRESH_MS = 15000;
setInterval(() => {
  if (!document.hidden) loadLeaderboard();
}, LB_REFRESH_MS);

function switchLbTab(tab) {
  lbTab = tab;
  document.querySelectorAll('.lb-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  loadLeaderboard();
}

async function loadLeaderboard() {
  try {
    if (lbTab === 'friends') {
      if (!currentUser) {
        renderEmpty('Register your alias above to see your rank among friends.');
        return;
      }
      const data = await api('/api/leaderboard/around');
      if (!data.players.length) {
        renderEmpty('Play a match first — your rank will show up here.');
        return;
      }
      renderRows(data.players, true);
    } else {
      const data = await api('/api/leaderboard?sort=best_score');
      if (!data.length) {
        renderEmpty('No scores yet — be the first on the board!');
        return;
      }
      renderRows(data.map((p, i) => ({ ...p, rank: i + 1 })), false);
    }
  } catch (err) {
    showToast('Failed to load leaderboard: ' + err.message);
  }
}

function renderEmpty(text) {
  $('#lb-list').innerHTML = '';
  $('#lb-empty-text').textContent = text;
  $('#lb-empty').classList.remove('hidden');
}

function renderRows(players, showYou) {
  $('#lb-empty').classList.add('hidden');
  const list = $('#lb-list');
  list.innerHTML = '';

  players.forEach((p) => {
    const rank = p.rank;
    const isYou = showYou && currentUser && p.id === currentUser.id
      || !showYou && currentUser && p.username === currentUser.username;

    const li = document.createElement('li');
    li.className = 'lb-row' + (rank === 1 ? ' first' : '') + (isYou ? ' you' : '');

    const rankCell = rank === 1 ? '👑' : rank;
    li.innerHTML =
      `<span class="rank">${rankCell}</span>` +
      `<span class="name">${escapeHtml(p.display_name || p.username)}${isYou ? '<span class="you-tag">YOU</span>' : ''}</span>` +
      `<span class="score">${p.best_score}</span>`;

    list.appendChild(li);
  });
}

// ─── Toast ──────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(text) {
  const toast = $('#toast');
  $('#toast-text').textContent = text;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3000);
}

// ─── Boot ───────────────────────────────────────────────────────────────────
(function init() {
  loadLeaderboard();

  if (authToken) {
    api('/api/profile')
      .then((user) => {
        currentUser = user;
        enterApp();
      })
      .catch(() => {
        localStorage.removeItem('ct_token');
        authToken = null;
      });
  }
})();
