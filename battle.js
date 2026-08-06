'use strict';

/* The Love Battle — two heart jars, one for each of us. You pick who you are,
   then tap your own jar to fill it with hearts. Whoever has the most hearts by
   the end of the calendar month wins that month's secret word for the Memory
   Jar (revealed only to whoever's currently ahead). When the month rolls over
   the jars start fresh — the client just writes to a new month key — and the
   month that just ended is kept as history of who won.

   Scores live in the `heart_months` table (one row per month, holding both
   counts and that month's random password). Taps are added through the
   `add_hearts` RPC so two devices tapping at once never clobber each other. */

(function () {
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt !== undefined) n.textContent = txt; return n; };

/* this device's local calendar month, e.g. "2026-08" */
function monthKey(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function monthName(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}
const label = (who) => (who === 'unif' ? 'Unif' : 'Tata');
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// each of us has our own password, so nobody can tap as the other
const IDENTITY_PW = { unif: 'uniflovetata', tata: 'tataloveunif' };

let MONTH = monthKey();
let started = false;

// authoritative counts from the server for the current month
const server = { unif: 0, tata: 0 };
let password = '';               // this month's secret word (once anyone has tapped)
let history = [];                // finished months, newest first

// my own not-yet-saved taps, kept separate so realtime/reloads never lose them
let pending = 0, inFlight = 0, sending = false, flushTimer = null;

let currentWho = localStorage.getItem('battleWho') || '';   // verified with a password
let pendingWho = '';                                         // identity awaiting its password
let audioCtx = null;

/* ===================== sound ===================== */

function playPop() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'triangle';
    o.frequency.value = 620 + Math.random() * 240;
    const t0 = audioCtx.currentTime;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.05, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.13);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(t0); o.stop(t0 + 0.18);
  } catch (e) { /* no sound is fine */ }
}

/* ===================== cloud data ===================== */

async function loadMonths() {
  const { data, error } = await window.sb.from('heart_months').select('*').order('month', { ascending: false });
  if (error) { toast('Could not load the Love Battle — check your connection'); return; }
  const rows = data || [];
  const cur = rows.find((r) => r.month === MONTH);
  server.unif = cur ? cur.unif_hearts : 0;
  server.tata = cur ? cur.tata_hearts : 0;
  password = cur ? cur.password : '';
  history = rows.filter((r) => r.month !== MONTH);
}

// Make sure this month's row (and its secret word) exists from day one, so last
// month's winner can be shown the password the moment the jars reset — even
// before anyone has tapped. Adding 0 hearts just mints the row if it's missing.
async function ensureCurrentMonth() {
  if (password) return;
  const { data, error } = await window.sb.rpc('add_hearts', { p_month: MONTH, p_author: 'unif', p_delta: 0 });
  if (!error && data) { password = data.password; server.unif = data.unif_hearts; server.tata = data.tata_hearts; }
}

// who won the most recent month that was actually played (ignoring empty months)
function lastWinner() {
  const played = history.filter((r) => r.unif_hearts + r.tata_hearts > 0);   // history is newest-first
  if (!played.length) return null;
  const r = played[0];
  if (r.unif_hearts === r.tata_hearts) return { who: null, month: r.month, tie: true };
  return { who: r.unif_hearts > r.tata_hearts ? 'unif' : 'tata', month: r.month, tie: false };
}

let reloadTimer = null;
function setupRealtime() {
  window.sb.channel('hearts-sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'heart_months' }, () => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(async () => { await loadMonths(); render(); }, 350);
    })
    .subscribe();
}

function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 500);
}

async function flush() {
  if (sending || !pending) return;
  sending = true;
  inFlight = pending; pending = 0;
  const { data, error } = await window.sb.rpc('add_hearts', { p_month: MONTH, p_author: currentWho, p_delta: inFlight });
  if (error) {
    pending += inFlight; inFlight = 0; sending = false;
    toast('Couldn’t save your hearts — check your connection');
    return;
  }
  // the row comes back with the authoritative totals (including my delta)
  server.unif = data.unif_hearts;
  server.tata = data.tata_hearts;
  password = data.password;
  inFlight = 0; sending = false;
  render();
  if (pending) scheduleFlush();
}

// best-effort save if you leave mid-battle
function flushNow() { if (pending && !sending) flush(); }

/* ===================== tapping ===================== */

function myCount() { return server[currentWho] + (currentWho ? pending + inFlight : 0); }
function oppCount() { const opp = currentWho === 'unif' ? 'tata' : 'unif'; return server[opp]; }

function riseHeart(side) {
  const box = document.querySelector('.hjar-hearts[data-hearts="' + side + '"]');
  if (!box) return;
  const h = el('span', 'rise', '♥');
  h.style.left = (12 + Math.random() * 66) + '%';
  h.style.fontSize = (16 + Math.random() * 12) + 'px';
  box.appendChild(h);
  setTimeout(() => h.remove(), 1050);
}

function tapJar(side) {
  if (!currentWho) { toast('pick who you are first ♥'); return; }
  if (side !== currentWho) { toast('that’s ' + label(side) + '’s jar — tap your own ♥'); return; }

  pending++;
  playPop();
  riseHeart(side);

  const countEl = document.querySelector('.battle-count[data-count="' + side + '"]');
  if (countEl) {
    countEl.textContent = myCount();
    countEl.classList.remove('bump');
    void countEl.offsetWidth;
    countEl.classList.add('bump');
  }
  updateFills();
  updateSecret();
  scheduleFlush();
}

/* ===================== rendering ===================== */

function fillPct(n) {
  if (n <= 0) return 0;
  return Math.min(96, Math.max(4, 100 * (1 - 1 / (1 + n / 40))));
}

function counts() {
  const u = server.unif + (currentWho === 'unif' ? pending + inFlight : 0);
  const t = server.tata + (currentWho === 'tata' ? pending + inFlight : 0);
  return { unif: u, tata: t };
}

function updateFills() {
  const c = counts();
  for (const side of ['unif', 'tata']) {
    const fill = document.querySelector('.hjar-fill[data-fill="' + side + '"]');
    if (fill) fill.style.height = fillPct(c[side]) + '%';
    const cnt = document.querySelector('.battle-count[data-count="' + side + '"]');
    if (cnt && side !== currentWho) cnt.textContent = c[side];
    if (cnt && side === currentWho) cnt.textContent = c[side];
  }
  // crown goes to whoever's strictly ahead
  const leader = c.unif === c.tata ? null : (c.unif > c.tata ? 'unif' : 'tata');
  for (const side of ['unif', 'tata']) {
    const crown = document.querySelector('.hjar-crown[data-crown="' + side + '"]');
    if (crown) crown.classList.toggle('show', leader === side);
  }
}

function updateMine() {
  document.querySelectorAll('.battle-jar-card').forEach((card) => {
    card.classList.toggle('mine', card.dataset.side === currentWho);
  });
  // little hint under each jar
  document.querySelectorAll('.battle-tap-hint').forEach((h) => {
    const side = h.dataset.taphint;
    if (!currentWho) h.textContent = '';
    else if (side === currentWho) h.textContent = 'tap to fill 💗';
    else h.textContent = label(side) + '’s jar';
  });
}

/* The secret word is the reward for winning the PREVIOUS month: when the jars
   reset, whoever won last month is shown this month's Memory-Jar password. The
   ongoing battle decides who gets NEXT month's word — nobody sees a word for a
   month they haven't already won. */
function updateSecret() {
  const box = $('#battleSecret');
  if (!box) return;
  box.className = 'battle-secret';

  if (!currentWho) { box.classList.add('locked'); box.textContent = 'pick who you are to join the battle 💗'; return; }

  const lw = lastWinner();
  const iWonLastMonth = lw && !lw.tie && lw.who === currentWho;

  if (iWonLastMonth && password) {
    box.innerHTML = '🏆 you won ' + escapeHtml(monthName(lw.month)) + '! this month’s secret word is<br>' +
      '<span class="secret-word">' + escapeHtml(password) + '</span><br>' +
      '<small>type it in the Memory Jar to open it · win again this month to keep it next month 💗</small>';
    return;
  }

  box.classList.add('locked');
  if (iWonLastMonth) {
    box.textContent = '🏆 you won ' + monthName(lw.month) + '! your secret word appears as this month’s battle begins 💗';
  } else if (lw && lw.tie) {
    box.textContent = monthName(lw.month) + ' was a sweet tie 💗 win this month to earn next month’s secret word';
  } else if (lw && lw.who) {
    box.textContent = label(lw.who) + ' won ' + monthName(lw.month) + ' and holds this month’s secret 🤫 — win this month to unlock next month’s';
  } else {
    box.textContent = 'win this month’s battle to unlock next month’s secret word 💗';
  }
}

function updateCountdown() {
  const box = $('#battleCountdown');
  if (!box) return;
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const ms = end - now;
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const left = days >= 1 ? '<b>' + days + '</b> day' + (days === 1 ? '' : 's') + ' left'
                         : '<b>' + hours + '</b> hour' + (hours === 1 ? '' : 's') + ' left';
  box.innerHTML = monthName(MONTH) + ' · ' + left;
}

function renderHistory() {
  const box = $('#battleHistory');
  if (!box) return;
  box.innerHTML = '';
  const played = history.filter((r) => r.unif_hearts + r.tata_hearts > 0);
  if (!played.length) {
    box.appendChild(el('div', 'battle-hist-empty', 'no finished months yet — this is the very first battle 💗'));
    return;
  }
  for (const r of played) {
    const row = el('div', 'battle-hist-row');
    row.appendChild(el('div', 'battle-hist-month', monthName(r.month)));
    const right = el('div');
    right.style.textAlign = 'right';
    let win;
    if (r.unif_hearts === r.tata_hearts) win = 'a sweet tie 💗';
    else win = label(r.unif_hearts > r.tata_hearts ? 'unif' : 'tata') + ' won 👑';
    right.appendChild(el('div', 'battle-hist-win', win));
    right.appendChild(el('div', 'battle-hist-score', 'Unif ' + r.unif_hearts + ' · Tata ' + r.tata_hearts));
    row.appendChild(right);
    box.appendChild(row);
  }
}

function render() {
  updateMine();
  updateFills();
  updateSecret();
  updateCountdown();
  renderHistory();
}

/* ===================== identity, buttons, startup ===================== */

// picking who you are needs your own password, so nobody can tap as the other.
// once verified it's remembered on this device (localStorage `battleWho`).
function syncBattleChips() {
  document.querySelectorAll('.battle-who .who-chip[data-bwho]').forEach((c) => {
    c.classList.toggle('sel', c.dataset.bwho === currentWho);
  });
}

function openBattleLock(who) {
  pendingWho = who;
  $('#battleLockTitle').textContent = 'is this really ' + label(who) + '?';
  $('#battleLockError').classList.remove('show');
  $('#battleLockPass').value = '';
  $('#battleLock').classList.remove('hidden');
  setTimeout(() => $('#battleLockPass').focus(), 80);
}
function closeBattleLock() { $('#battleLock').classList.add('hidden'); pendingWho = ''; }

document.querySelectorAll('.battle-who .who-chip[data-bwho]').forEach((chip) => {
  chip.addEventListener('click', () => {
    const who = chip.dataset.bwho;
    if (who === currentWho) return;      // already verified as this person
    openBattleLock(who);
  });
});

$('#battleLockForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const err = $('#battleLockError');
  if ($('#battleLockPass').value === IDENTITY_PW[pendingWho]) {
    currentWho = pendingWho;
    localStorage.setItem('battleWho', currentWho);
    closeBattleLock();
    syncBattleChips();
    render();
  } else {
    const card = document.querySelector('#battleLock .lock-card');
    card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
    err.textContent = 'hmm, that’s not your password — try again ♥';
    err.classList.add('show');
    $('#battleLockPass').value = '';
    $('#battleLockPass').focus();
  }
});
$('#battleLockClose').addEventListener('click', closeBattleLock);
$('#battleLock').addEventListener('click', (e) => { if (e.target.id === 'battleLock') closeBattleLock(); });

document.querySelectorAll('#view-battle .hjar').forEach((jar) => {
  const card = jar.closest('.battle-jar-card');
  jar.addEventListener('click', () => tapJar(card.dataset.side));
});

$('#battleHistoryBtn').addEventListener('click', () => {
  const box = $('#battleHistory');
  const shown = box.classList.toggle('hidden');
  $('#battleHistoryBtn').textContent = shown ? '🏆 Who won each month' : '🙈 Hide history';
});

document.addEventListener('visibilitychange', () => { if (document.hidden) flushNow(); });
window.addEventListener('pagehide', flushNow);

// keep the clock honest, and roll over on the spot if the month changes mid-visit
setInterval(async () => {
  if (!started) return;
  const nowKey = monthKey();
  if (nowKey !== MONTH) {
    MONTH = nowKey;
    pending = inFlight = 0; sending = false;
    password = '';
    await loadMonths();
    await ensureCurrentMonth();
    render();
  } else {
    updateCountdown();
  }
}, 30000);

async function startBattle() {
  if (started) return;
  started = true;
  currentWho = localStorage.getItem('battleWho') || '';
  await loadMonths();
  await ensureCurrentMonth();
  syncBattleChips();
  render();
  setupRealtime();
}

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => { if (btn.dataset.view === 'battle') startBattle(); });
});

/* Let the Memory Jar accept this month's secret word too. Returns the current
   month's password if someone has already started the battle, else '' . */
window.battleMonthPassword = async function () {
  const key = monthKey();
  const { data, error } = await window.sb.from('heart_months').select('password').eq('month', key).maybeSingle();
  if (error || !data) return '';
  return data.password || '';
};

})();
