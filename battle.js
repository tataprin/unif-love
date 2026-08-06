'use strict';

/* The Love Battle — two glass jars on a shelf, one for each of us. You pick who
   you are (your own password proves it), then tap YOUR jar to tumble hearts
   into it. Whoever has the most hearts when the month ends wins: on the 1st the
   jars reset and last month's winner is shown that month's secret word for the
   Memory Jar.

   Scores live in the `heart_months` table (one row per month, holding both
   counts and that month's random password). Taps are added through the
   `add_hearts` RPC so two devices tapping at once never clobber each other.
   The 3D is pure decoration — if WebGL isn't available the 2D fallback jars in
   #battleFallback take over and the game plays exactly the same. */

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

const SIDES = ['unif', 'tata'];
const JAR_X = 1.15;                 // the two jars sit this far either side of centre
const PILE_CAP = 90;                // hearts we actually model inside a jar; the number keeps counting past it
const LAYER_SIZE = 5;               // roughly this many hearts settle into each layer
const PILE_BASE_Y = 0.09;
const PILE_TOP_Y = 1.0;
const HEART_COLORS = [0xff5f8d, 0xff8fb0, 0xffb3c8, 0xff7aa2, 0xffa0c0];
const COMBO_WINDOW = 1200;          // keep tapping within this to build a combo

let MONTH = monthKey();
let started = false;

// authoritative counts from the server for the current month
const server = { unif: 0, tata: 0 };
let password = '';               // this month's secret word (once the row exists)
let history = [];                // finished months, newest first

// my own not-yet-saved taps, kept separate so realtime/reloads never lose them
let pending = 0, inFlight = 0, sending = false, flushTimer = null;

let currentWho = localStorage.getItem('battleWho') || '';   // verified with a password
let pendingWho = '';                                         // identity awaiting its password
let audioCtx = null;

// combo / juice
let combo = 0, comboTimer = null, shake = 0;

/* ===================== sound ===================== */

function tone(freq, dur, type, vol, delay) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type || 'sine';
    o.frequency.value = freq;
    const t0 = audioCtx.currentTime + (delay || 0);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol || 0.05, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + (dur || 0.15));
    o.connect(g); g.connect(audioCtx.destination);
    o.start(t0); o.stop(t0 + (dur || 0.15) + 0.05);
  } catch (e) { /* no sound is fine */ }
}
const sounds = {
  // the pitch climbs as your combo grows, so fast tapping sings
  tap(c) { tone(560 * Math.pow(1.045, Math.min(c, 24)), 0.11, 'triangle', 0.045); },
  plop() { tone(300, 0.09, 'sine', 0.045); tone(210, 0.11, 'sine', 0.035, 0.05); },
  milestone() { tone(659, 0.18, 'sine', 0.05); tone(880, 0.2, 'sine', 0.05, 0.09); tone(1175, 0.28, 'sine', 0.045, 0.18); },
  nope() { tone(200, 0.13, 'square', 0.03); tone(160, 0.16, 'square', 0.03, 0.1); },
};

/* ===================== the 3D scene ===================== */

let sceneReady = false;
let renderer, scene, camera, clock, raycaster, pointer;
let heartGeo, heartMats = [], plusTex = null;
const heartTextures = [];
const jars = {};                 // side -> { group, lid, pile, glow, pileCount, squash, hover }
const drops = [];                // hearts tumbling into a jar
const particles = [];            // little sprites floating about
let crownSprite = null, crownSide = null;
let lastT = 0, lastAmbient = 0, ambientCount = 0;

function startScene() {
  try {
    const canvas = $('#battleCanvas');
    if (!canvas) return;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.set(0, 1.95, 5.1);

    makeHeartTextures();
    makePlusTexture();
    buildLights();
    buildShelf();
    heartGeo = makeHeartGeometry();
    heartMats = HEART_COLORS.map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.42 }));
    for (const side of SIDES) buildJar(side);
    buildCrown();

    raycaster = new THREE.Raycaster();
    pointer = new THREE.Vector2();
    clock = new THREE.Clock();

    window.addEventListener('resize', onResize);
    onResize();
    canvas.addEventListener('pointerdown', onCanvasTap);
    canvas.addEventListener('pointermove', onCanvasHover);

    sceneReady = true;
    $('#battleStage').classList.add('has3d');   // hides the 2D fallback jars
    animate();
  } catch (e) {
    sceneReady = false;                          // no WebGL — the 2D jars stay on
  }
}

function onResize() {
  const box = $('#battleStage');
  const w = box.clientWidth || 1, h = box.clientHeight || 1;
  const aspect = w / h;
  camera.aspect = aspect;
  // Sit exactly as far back as it takes to frame both jars — no further. Wide
  // screens are limited by the jars' height, narrow ones by their width, so on
  // every phone the jars stay big and easy to hit rather than tiny in the middle.
  const half = Math.tan((camera.fov * Math.PI) / 360);
  const forWidth = 1.9 / (half * aspect);       // the pair, side to side
  const forHeight = 1.3 / half;                 // jar foot up to the floating crown
  camera.position.z = Math.min(7.5, Math.max(3.1, Math.max(forWidth, forHeight)));
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}

function buildLights() {
  scene.add(new THREE.AmbientLight(0xfff0f5, 0.8));
  scene.add(new THREE.HemisphereLight(0xffeef3, 0xd88fa8, 0.5));
  const dir = new THREE.DirectionalLight(0xfff2e2, 0.55);
  dir.position.set(2.5, 5, 4);
  scene.add(dir);
  const warm = new THREE.PointLight(0xffc9d9, 0.45, 12, 2);
  warm.position.set(-2.5, 3, 2.5);
  scene.add(warm);
}

/* a soft wooden shelf for the two jars to stand on */
function buildShelf() {
  const shelf = new THREE.Mesh(
    new THREE.BoxGeometry(4.6, 0.16, 1.5),
    new THREE.MeshStandardMaterial({ color: 0xe7c3a0, roughness: 0.65 })
  );
  shelf.position.y = -0.08;
  scene.add(shelf);
  const lip = new THREE.Mesh(
    new THREE.BoxGeometry(4.6, 0.06, 0.1),
    new THREE.MeshStandardMaterial({ color: 0xd9a97a, roughness: 0.6 })
  );
  lip.position.set(0, 0.02, 0.75);
  scene.add(lip);
}

function makeHeartGeometry() {
  const s = new THREE.Shape();
  s.moveTo(0.25, 0.25);
  s.bezierCurveTo(0.25, 0.25, 0.2, 0, 0, 0);
  s.bezierCurveTo(-0.3, 0, -0.3, 0.35, -0.3, 0.35);
  s.bezierCurveTo(-0.3, 0.55, -0.1, 0.77, 0.25, 0.95);
  s.bezierCurveTo(0.6, 0.77, 0.8, 0.55, 0.8, 0.35);
  s.bezierCurveTo(0.8, 0.35, 0.8, 0, 0.5, 0);
  s.bezierCurveTo(0.35, 0, 0.25, 0.25, 0.25, 0.25);
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: 0.1, bevelEnabled: true, bevelSize: 0.035, bevelThickness: 0.035, bevelSegments: 2,
  });
  geo.center();
  geo.scale(0.13, 0.13, 0.13);
  geo.rotateZ(Math.PI);              // the shape draws point-up; flip it the right way round
  return geo;
}

function buildJar(side) {
  const group = new THREE.Group();
  group.position.set(side === 'unif' ? -JAR_X : JAR_X, 0, 0);

  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0xdff1f7, transparent: true, opacity: 0.24,
    roughness: 0.07, metalness: 0, side: THREE.DoubleSide, depthWrite: false,
  });

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.48, 1.15, 36, 1, true), glassMat);
  body.position.y = 0.575;
  group.add(body);
  const bottom = new THREE.Mesh(new THREE.CircleGeometry(0.48, 36), glassMat);
  bottom.rotation.x = -Math.PI / 2;
  bottom.position.y = 0.012;
  group.add(bottom);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.52, 0.12, 36, 1, true), glassMat);
  neck.position.y = 1.21;
  group.add(neck);
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(0.45, 0.028, 10, 36),
    new THREE.MeshStandardMaterial({ color: 0xcfe8ef, transparent: true, opacity: 0.55, roughness: 0.15 })
  );
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 1.27;
  group.add(rim);

  // a golden lid with a little heart knob, hovering just off the jar
  const lid = new THREE.Group();
  const lidMat = new THREE.MeshStandardMaterial({ color: 0xdcb06f, metalness: 0.5, roughness: 0.35 });
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.49, 0.49, 0.09, 36), lidMat);
  cap.position.y = 0.045;
  lid.add(cap);
  const knob = new THREE.Mesh(heartGeo, new THREE.MeshStandardMaterial({ color: 0xe0507a, roughness: 0.35 }));
  knob.position.y = 0.2;
  knob.scale.setScalar(1.3);
  lid.add(knob);
  lid.position.y = 1.3;
  group.add(lid);

  // a glowing ring under the jar marks whose it is
  const glow = new THREE.Mesh(
    new THREE.RingGeometry(0.5, 0.72, 40),
    new THREE.MeshBasicMaterial({ color: 0xff7aa8, transparent: true, opacity: 0, side: THREE.DoubleSide })
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.02;
  group.add(glow);

  const pile = new THREE.Group();
  group.add(pile);

  makeJarLabel(side, group);
  scene.add(group);
  jars[side] = { group, lid, pile, glow, knob, pileCount: 0, squash: 0, hover: false };
}

/* the name curved onto the glass in our script font */
async function makeJarLabel(side, group) {
  try { await document.fonts.load('700 46px "Dancing Script"'); } catch (e) { /* fallback font is fine */ }
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const x = c.getContext('2d');
  x.beginPath();
  if (x.roundRect) x.roundRect(14, 22, 228, 84, 16); else x.rect(14, 22, 228, 84);
  x.fillStyle = '#fffaf0';
  x.fill();
  x.strokeStyle = 'rgba(224,80,122,.55)';
  x.lineWidth = 5;
  x.stroke();
  x.fillStyle = '#8e2547';
  x.font = '700 46px "Dancing Script", cursive';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText(label(side), 128, 64);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.515, 0.515, 0.3, 24, 1, true, -0.6, 1.2),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true })
  );
  mesh.position.y = 0.62;
  group.add(mesh);
}

function buildCrown() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  x.font = '104px serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText('👑', 64, 70);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  crownSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  crownSprite.raycast = function () {};
  crownSprite.scale.setScalar(0.45);
  crownSprite.visible = false;
  scene.add(crownSprite);
}

/* ===================== hearts inside the jars ===================== */

/* stable pseudo-random so a pile never reshuffles itself */
function rand01(seed) {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function pileSpot(i) {
  const layers = Math.max(1, Math.ceil(PILE_CAP / LAYER_SIZE) - 1);
  const gap = (PILE_TOP_Y - PILE_BASE_Y) / layers;
  const layer = Math.floor(i / LAYER_SIZE);
  const a = i * GOLDEN_ANGLE + rand01(i * 3 + 1) * 0.6;
  const r = Math.sqrt((i % LAYER_SIZE + rand01(i * 3 + 2)) / LAYER_SIZE) * 0.27;
  return {
    x: Math.cos(a) * r, z: Math.sin(a) * r,
    y: PILE_BASE_Y + layer * gap + rand01(i * 3 + 3) * 0.012,
    rx: (rand01(i * 7 + 5) - 0.5) * 0.7,
    ry: rand01(i * 7 + 4) * Math.PI * 2,
    rz: (rand01(i * 7 + 6) - 0.5) * 0.7,
  };
}

function makeHeartMesh(i) {
  const m = new THREE.Mesh(heartGeo, heartMats[i % heartMats.length]);
  const s = pileSpot(i);
  m.position.set(s.x, s.y, s.z);
  m.rotation.set(s.rx, s.ry, s.rz);
  return m;
}

/* a heart tumbles in from above and settles into the pile */
function dropHeart(side) {
  const jar = jars[side];
  if (!sceneReady || !jar || jar.pileCount >= PILE_CAP) { if (jar) jar.pileCount = Math.min(jar.pileCount + 1, PILE_CAP); return; }
  const i = jar.pileCount++;
  const mesh = makeHeartMesh(i);
  const targetY = mesh.position.y;
  mesh.position.y = 2.15;
  jar.pile.add(mesh);
  drops.push({ mesh, targetY, v: 0, bounced: false, spin: (Math.random() - 0.5) * 6 });
}

/* put hearts straight into place (loading, or the other person tapped a lot) */
function fillPile(side, n) {
  const jar = jars[side];
  if (!sceneReady || !jar) { if (jar) jar.pileCount = n; return; }
  while (jar.pileCount < n) jar.pile.add(makeHeartMesh(jar.pileCount++));
}

function clearPile(side) {
  const jar = jars[side];
  if (!sceneReady || !jar) return;
  for (let i = drops.length - 1; i >= 0; i--) if (drops[i].mesh.parent === jar.pile) drops.splice(i, 1);
  for (const child of [...jar.pile.children]) jar.pile.remove(child);
  jar.pileCount = 0;
}

/* keep what's in each jar matching the score — animating small changes so you
   see the other person's hearts land live, snapping big catch-ups */
function syncPiles() {
  const c = counts();
  for (const side of SIDES) {
    const jar = jars[side];
    if (!jar) continue;
    const want = Math.min(c[side], PILE_CAP);
    if (want < jar.pileCount) { clearPile(side); fillPile(side, want); continue; }
    const diff = want - jar.pileCount;
    if (diff <= 0) continue;
    if (diff <= 5) for (let k = 0; k < diff; k++) setTimeout(() => dropHeart(side), k * 110);
    else fillPile(side, want);
  }
}

/* ===================== little sprites ===================== */

function makeHeartTextures() {
  for (const color of ['#ff6f9c', '#ffa3c0', '#ffd76b', '#ff4f7e', '#ffffff']) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x = c.getContext('2d');
    x.fillStyle = color;
    x.beginPath();
    x.moveTo(32, 54);
    x.bezierCurveTo(6, 36, 2, 18, 16, 12);
    x.bezierCurveTo(26, 8, 32, 16, 32, 22);
    x.bezierCurveTo(32, 16, 38, 8, 48, 12);
    x.bezierCurveTo(62, 18, 58, 36, 32, 54);
    x.fill();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    heartTextures.push(tex);
  }
}
function heartTex() { return heartTextures[(Math.random() * heartTextures.length) | 0]; }

function makePlusTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  const x = c.getContext('2d');
  x.font = '700 44px Quicksand, sans-serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.lineWidth = 6;
  x.strokeStyle = '#fff';
  x.strokeText('+1', 64, 34);
  x.fillStyle = '#e0507a';
  x.fillText('+1', 64, 34);
  plusTex = new THREE.CanvasTexture(c);
  plusTex.colorSpace = THREE.SRGBColorSpace;
}

function spawnSprite(tex, pos, opts) {
  if (particles.length > 150) return;             // never let the party get out of hand
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  spr.raycast = function () {};
  spr.position.copy(pos);
  spr.scale.setScalar(opts.size || 0.15);
  scene.add(spr);
  particles.push(Object.assign({ spr, vx: 0, vy: 0.3, vz: 0, life: 1, decay: 0.9, sway: 0, phase: Math.random() * 6.28, ambient: false }, opts));
}

function burstHearts(pos, n, power) {
  for (let i = 0; i < n; i++) {
    spawnSprite(heartTex(), pos, {
      size: 0.09 + Math.random() * 0.09 * (power || 1),
      vx: (Math.random() - 0.5) * 0.9 * (power || 1),
      vy: 0.5 + Math.random() * 0.6 * (power || 1),
      vz: (Math.random() - 0.5) * 0.5,
      decay: 1.15, sway: 0.02,
    });
  }
}

function spawnPlusOne(side) {
  if (!plusTex) return;
  const p = new THREE.Vector3(jars[side].group.position.x + (Math.random() - 0.5) * 0.3, 1.55, 0.35);
  spawnSprite(plusTex, p, { size: 0.34, vy: 0.85, vx: (Math.random() - 0.5) * 0.15, decay: 1.25 });
}

function spawnAmbientHeart() {
  spawnSprite(heartTex(), new THREE.Vector3(-2.6 + Math.random() * 5.2, -0.1, -0.6 + Math.random() * 1.2), {
    size: 0.09 + Math.random() * 0.09, vy: 0.16 + Math.random() * 0.1, decay: 0.13, sway: 0.09, ambient: true,
  });
  ambientCount++;
}

/* ===================== pointer ===================== */

function jarAtPointer(event) {
  const canvas = $('#battleCanvas');
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  for (const side of SIDES) {
    if (raycaster.intersectObject(jars[side].group, true).length) return side;
  }
  return null;
}

function onCanvasTap(event) {
  if (!$('#battleLock').classList.contains('hidden')) return;
  const side = jarAtPointer(event);
  if (side) { tapJar(side); return; }
  // tapping the background still sprinkles a few hearts, because why not
  const hits = raycaster.intersectObjects(scene.children, true);
  if (hits.length) burstHearts(hits[0].point.clone(), 3);
}

function onCanvasHover(event) {
  if (event.pointerType === 'touch') return;
  const side = jarAtPointer(event);
  for (const s of SIDES) jars[s].hover = (s === side);
  $('#battleCanvas').style.cursor = side ? 'pointer' : 'default';
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
  server.unif = data.unif_hearts;
  server.tata = data.tata_hearts;
  password = data.password;
  inFlight = 0; sending = false;
  render();
  if (pending) scheduleFlush();
}

function flushNow() { if (pending && !sending) flush(); }

/* ===================== tapping ===================== */

function counts() {
  return {
    unif: server.unif + (currentWho === 'unif' ? pending + inFlight : 0),
    tata: server.tata + (currentWho === 'tata' ? pending + inFlight : 0),
  };
}

function riseHeart2D(side) {
  const box = document.querySelector('.hjar-hearts[data-hearts="' + side + '"]');
  if (!box) return;
  const h = el('span', 'rise', '♥');
  h.style.left = (12 + Math.random() * 66) + '%';
  h.style.fontSize = (16 + Math.random() * 12) + 'px';
  box.appendChild(h);
  setTimeout(() => h.remove(), 1050);
}

function bumpCombo() {
  combo++;
  clearTimeout(comboTimer);
  comboTimer = setTimeout(() => { combo = 0; showCombo(); }, COMBO_WINDOW);
  showCombo();
  if (combo > 0 && combo % 10 === 0) {          // a little celebration every 10 in a row
    sounds.milestone();
    shake = 0.09;
    cheer(combo >= 50 ? 'UNSTOPPABLE 💘' : combo >= 30 ? 'so much love! 💞' : 'combo x' + combo + ' 🔥');
    if (sceneReady) burstHearts(new THREE.Vector3(jars[currentWho].group.position.x, 1.5, 0.3), 16, 1.6);
  }
}

function showCombo() {
  const box = $('#battleCombo');
  if (!box) return;
  if (combo < 3) { box.classList.remove('show'); return; }
  box.textContent = 'x' + combo;
  box.classList.add('show');
  box.classList.remove('pop');
  void box.offsetWidth;
  box.classList.add('pop');
}

let cheerTimer = null;
function cheer(text) {
  const box = $('#battleCheer');
  if (!box) return;
  box.textContent = text;
  box.classList.remove('show');
  void box.offsetWidth;
  box.classList.add('show');
  clearTimeout(cheerTimer);
  cheerTimer = setTimeout(() => box.classList.remove('show'), 1400);
}

function tapJar(side) {
  if (!currentWho) { toast('pick who you are first ♥'); sounds.nope(); return; }
  if (side !== currentWho) {
    toast('that’s ' + label(side) + '’s jar — tap your own ♥');
    sounds.nope();
    if (sceneReady && jars[side]) jars[side].squash = -0.5;    // a little "nope" wobble
    return;
  }

  pending++;
  bumpCombo();
  sounds.tap(combo);

  if (sceneReady) {
    dropHeart(side);
    jars[side].squash = 1;
    spawnPlusOne(side);
    burstHearts(new THREE.Vector3(jars[side].group.position.x, 1.4, 0.3), 3 + Math.min(combo, 6));
  } else {
    riseHeart2D(side);
  }

  const countEl = document.querySelector('.battle-count[data-count="' + side + '"]');
  if (countEl) {
    countEl.textContent = counts()[side];
    countEl.classList.remove('bump');
    void countEl.offsetWidth;
    countEl.classList.add('bump');
  }
  updateFills();
  scheduleFlush();
}

/* ===================== rendering ===================== */

function fillPct(n) {
  if (n <= 0) return 0;
  return Math.min(96, Math.max(4, 100 * (1 - 1 / (1 + n / 40))));
}

function updateFills() {
  const c = counts();
  for (const side of SIDES) {
    const fill = document.querySelector('.hjar-fill[data-fill="' + side + '"]');
    if (fill) fill.style.height = fillPct(c[side]) + '%';
    const cnt = document.querySelector('.battle-count[data-count="' + side + '"]');
    if (cnt) cnt.textContent = c[side];
  }
  // the crown goes to whoever's strictly ahead
  const leader = c.unif === c.tata ? null : (c.unif > c.tata ? 'unif' : 'tata');
  crownSide = leader;
  for (const side of SIDES) {
    const crown = document.querySelector('.hjar-crown[data-crown="' + side + '"]');
    if (crown) crown.classList.toggle('show', leader === side);
  }
  if (sceneReady && crownSprite) crownSprite.visible = !!leader;
  syncPiles();
}

function updateMine() {
  document.querySelectorAll('#view-battle [data-side]').forEach((n) => {
    n.classList.toggle('mine', n.dataset.side === currentWho);
  });
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

/* ===================== animation loop ===================== */

function animate() {
  requestAnimationFrame(animate);
  const t = clock.getElapsedTime();
  const dt = Math.min(t - lastT, 0.05);
  lastT = t;

  for (const side of SIDES) {
    const jar = jars[side];
    if (!jar) continue;
    // squash & stretch on every tap, easing back to normal
    jar.squash += (0 - jar.squash) * Math.min(1, dt * 9);
    const s = jar.squash;
    const hoverPop = jar.hover ? 0.03 : 0;
    jar.group.scale.set(1 + s * 0.09 + hoverPop, 1 - s * 0.13 + hoverPop, 1 + s * 0.09 + hoverPop);
    // your jar breathes and glows
    const mine = side === currentWho;
    jar.group.position.y = mine ? Math.sin(t * 2) * 0.02 : 0;
    jar.glow.material.opacity += ((mine ? 0.28 + Math.sin(t * 3) * 0.1 : 0) - jar.glow.material.opacity) * Math.min(1, dt * 5);
    jar.lid.position.y = 1.3 + Math.sin(t * 1.6 + (side === 'unif' ? 0 : 1.4)) * 0.02 + Math.max(0, s) * 0.16;
    jar.lid.rotation.y += dt * (0.6 + Math.max(0, s) * 5);
  }

  // hearts tumbling into a jar
  for (let i = drops.length - 1; i >= 0; i--) {
    const d = drops[i];
    d.v -= 7 * dt;
    d.mesh.position.y += d.v * dt;
    d.mesh.rotation.y += d.spin * dt;
    d.mesh.rotation.x += d.spin * 0.5 * dt;
    if (d.mesh.position.y <= d.targetY) {
      d.mesh.position.y = d.targetY;
      if (!d.bounced && d.v < -1.4) { d.bounced = true; d.v = -d.v * 0.3; }
      else { drops.splice(i, 1); sounds.plop(); }
    }
  }

  // floating hearts & +1s
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= p.decay * dt;
    if (p.life <= 0) {
      scene.remove(p.spr);
      p.spr.material.dispose();
      if (p.ambient) ambientCount--;
      particles.splice(i, 1);
      continue;
    }
    p.spr.position.x += (p.vx + Math.sin(t * 2.4 + p.phase) * p.sway) * dt;
    p.spr.position.y += p.vy * dt;
    p.spr.position.z += p.vz * dt;
    p.spr.material.opacity = Math.min(1, p.life);
  }
  if (t - lastAmbient > 1.5 && ambientCount < 6) { lastAmbient = t; spawnAmbientHeart(); }

  // the crown bobs above whoever's winning
  if (crownSprite && crownSprite.visible && crownSide && jars[crownSide]) {
    crownSprite.position.set(jars[crownSide].group.position.x, 1.75 + Math.sin(t * 2.5) * 0.06, 0.2);
    crownSprite.material.rotation = Math.sin(t * 1.6) * 0.12;
  }

  // a satisfying little shake on big combos
  shake *= Math.max(0, 1 - dt * 4);
  camera.position.x = Math.sin(t * 0.18) * 0.12 + (Math.random() - 0.5) * shake;
  camera.position.y = 1.95 + (Math.random() - 0.5) * shake * 0.6;
  camera.lookAt(0, 0.95, 0);
  renderer.render(scene, camera);
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
  if ($('#battleLockPass').value.trim().toLowerCase() === IDENTITY_PW[pendingWho]) {
    currentWho = pendingWho;
    localStorage.setItem('battleWho', currentWho);
    closeBattleLock();
    syncBattleChips();
    render();
    cheer('welcome back, ' + label(currentWho) + ' 💗');
  } else {
    const card = document.querySelector('#battleLock .lock-card');
    card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
    err.textContent = 'hmm, that’s not your password — try again ♥';
    err.classList.add('show');
    $('#battleLockPass').value = '';
    $('#battleLockPass').focus();
    sounds.nope();
  }
});
$('#battleLockClose').addEventListener('click', closeBattleLock);
$('#battleLock').addEventListener('click', (e) => { if (e.target.id === 'battleLock') closeBattleLock(); });

// the 2D fallback jars are tappable too, for devices without WebGL
document.querySelectorAll('#battleFallback .hjar').forEach((jar) => {
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

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#battleLock').classList.contains('hidden')) closeBattleLock();
});

// keep the clock honest, and roll over on the spot if the month changes mid-visit
setInterval(async () => {
  if (!started) return;
  const nowKey = monthKey();
  if (nowKey !== MONTH) {
    MONTH = nowKey;
    pending = inFlight = 0; sending = false;
    password = '';
    for (const side of SIDES) clearPile(side);
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
  startScene();
  await loadMonths();
  await ensureCurrentMonth();
  syncBattleChips();
  render();
  setupRealtime();
}

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.view === 'battle') { startBattle(); if (sceneReady) setTimeout(onResize, 50); }
  });
});

/* Let the Memory Jar accept this month's secret word too. Returns the current
   month's password if the row exists, else '' . */
window.battleMonthPassword = async function () {
  const key = monthKey();
  const { data, error } = await window.sb.from('heart_months').select('password').eq('month', key).maybeSingle();
  if (error || !data) return '';
  return data.password || '';
};

})();
