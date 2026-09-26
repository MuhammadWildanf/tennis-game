'use strict';

// Halaman alias (/): daftar → langsung ke /join (halaman queue).
// Leaderboard punya halaman sendiri: /scoreboard.

let authToken = localStorage.getItem('ct_token') || null;

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

// ─── Cek alias ───
const aliasInput = $('#alias-input');
const availEl = $('#alias-avail');
let checkTimer = null;
let lastChecked = '';

aliasInput.addEventListener('input', () => {
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

// ─── Daftar → ke halaman queue ───
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
    localStorage.setItem('ct_user', data.user.username);
    location.href = '/join';
  } catch (err) {
    if (/taken/i.test(err.message || '')) {
      await Swal.fire({ icon: 'error', title: 'Nickname already taken', text: 'Please enter a new nickname', confirmButtonText: 'CLOSE', confirmButtonColor: '#0a2a6e' });
      aliasInput.focus();
    } else {
      errEl.textContent = err.message;
      errEl.classList.add('show');
    }
  } finally {
    setLoading(btn, false);
  }
});

function setLoading(btn, loading) {
  if (!btn.dataset.label) btn.dataset.label = btn.querySelector('.btn-label').textContent;
  btn.querySelector('.btn-label').textContent = loading ? '' : btn.dataset.label;
  btn.querySelector('.btn-spinner').style.display = loading ? 'inline-block' : 'none';
  btn.disabled = loading;
}

function logout() {
  if (authToken) api('/api/logout', { method: 'POST' }).catch(() => {});
  authToken = null;
  localStorage.removeItem('ct_token');
  location.reload();
}

// ─── Toast ───
let toastTimer = null;
function showToast(text) {
  const toast = $('#toast');
  $('#toast-text').textContent = text;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3000);
}

// ─── Boot: sudah ada data tersimpan → langsung ke leaderboard ───
(function init() {
  if (!authToken) return;
  api('/api/profile')
    .then(() => location.replace('/scoreboard'))
    .catch(() => {
      localStorage.removeItem('ct_token');
      authToken = null;
    });
})();
