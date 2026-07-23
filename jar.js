'use strict';

/* The virtual memory jar — a glass jar on a little table that the two of us
   drop folded notes into. Anyone can write and send a note; reading what's
   inside needs the jar's magic word. Notes live in the `jar` table with the
   date they were sent, and sync live between devices like everything else. */

(function () {
const $ = (sel) => document.querySelector(sel);

const JAR_PASSWORD = 'jar123';
const LID_Y = 1.44;
const MAX_PILE = 110;              // the 3D pile stops growing past this; the list never does
const NOTE_COLORS = [0xfffaf4, 0xffeef7, 0xfff3e2, 0xffe4ee, 0xf3ecff];

let started = false;
let sceneReady = false;            // 3D came up fine — if not, notes still work, just without the jar
let renderer, scene, camera, clock, raycaster, pointer;
let jarGroup, lidGroup, notesGroup, noteGeo;
let lidT = 0, lidTarget = 0;       // 0 = snug on the jar … 1 = lifted off to the side
let lidPeekTimer = null;
let jarHovered = false;
let unlocked = false;              // magic word entered — remembered until the page reloads

let notes = [];                    // { id, author: 'unif'|'tata', message, created_at }
const localIds = new Set();        // notes we just sent — skip their realtime echo
const drops = [];                  // notes currently falling into the jar
const particles = [];
const heartTextures = [];
let lastT = 0, lastAmbient = 0, ambientCount = 0;
let audioCtx = null;

let filterWho = 'all';
let sortDesc = true;               // newest first by default
let rangeFrom = '', rangeTo = '';  // 'YYYY-MM-DD' — empty means no limit on that side
let currentWho = localStorage.getItem('jarWho') || '';

/* ===================== scene setup ===================== */

async function startJar() {
  if (started) return;
  started = true;

  try {
    const canvas = $('#jarCanvas');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xfbdce6);
    scene.fog = new THREE.Fog(0xfbdce6, 8, 16);

    camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    camera.position.set(0, 2.1, 3.9);

    makeHeartTextures();
    buildSetting();
    buildJar();
    makeLabel();

    raycaster = new THREE.Raycaster();
    pointer = new THREE.Vector2();
    clock = new THREE.Clock();

    window.addEventListener('resize', onResize);
    onResize();
    canvas.addEventListener('click', onCanvasClick);
    canvas.addEventListener('pointermove', onCanvasHover);
    sceneReady = true;
  } catch (e) {
    // no WebGL on this device — the buttons, notes and reading still work fine
  }

  await loadNotes();
  buildNotePile();
  setupRealtime();

  $('#jarLoading').classList.add('hidden');
  if (sceneReady) animate();
}

function onResize() {
  const container = $('#jarScene');
  const w = container.clientWidth || 1, h = container.clientHeight || 1;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

function buildSetting() {
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(7, 48),
    new THREE.MeshStandardMaterial({ color: 0xf5cdd9, roughness: 0.95 })
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  scene.add(new THREE.AmbientLight(0xfff0f5, 0.75));
  const hemi = new THREE.HemisphereLight(0xffeef3, 0xd88fa8, 0.55);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xfff2e2, 0.5);
  dir.position.set(3, 5, 4);
  scene.add(dir);
  const warm = new THREE.PointLight(0xffc9d9, 0.5, 8, 2);
  warm.position.set(-2, 3, 2);
  scene.add(warm);

  // the little table the jar sits on
  const woodMat = new THREE.MeshStandardMaterial({ color: 0xd9a97a, roughness: 0.6 });
  const top = new THREE.Mesh(
    new THREE.CylinderGeometry(1.1, 1.1, 0.08, 40),
    new THREE.MeshStandardMaterial({ color: 0xecd9c6, roughness: 0.5 })
  );
  top.position.y = 0.9;
  scene.add(top);
  const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.2, 0.9, 24), woodMat);
  leg.position.y = 0.45;
  scene.add(leg);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.06, 32), woodMat);
  base.position.y = 0.03;
  scene.add(base);
}

function buildJar() {
  jarGroup = new THREE.Group();

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.85, 32),
    new THREE.MeshBasicMaterial({ color: 0x5a1e32, transparent: true, opacity: 0.16 })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.005;
  jarGroup.add(shadow);

  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0xdff1f7, transparent: true, opacity: 0.22,
    roughness: 0.08, metalness: 0, side: THREE.DoubleSide, depthWrite: false,
  });

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.56, 1.3, 40, 1, true), glassMat);
  body.position.y = 0.65;
  jarGroup.add(body);

  const bottom = new THREE.Mesh(new THREE.CircleGeometry(0.56, 40), glassMat);
  bottom.rotation.x = -Math.PI / 2;
  bottom.position.y = 0.012;
  jarGroup.add(bottom);

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.6, 0.14, 40, 1, true), glassMat);
  neck.position.y = 1.37;
  jarGroup.add(neck);

  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(0.52, 0.03, 12, 40),
    new THREE.MeshStandardMaterial({ color: 0xcfe8ef, transparent: true, opacity: 0.5, roughness: 0.15 })
  );
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 1.44;
  jarGroup.add(rim);

  // golden lid with a little heart knob — it lifts off when the jar opens
  lidGroup = new THREE.Group();
  const lidMat = new THREE.MeshStandardMaterial({ color: 0xdcb06f, metalness: 0.5, roughness: 0.35 });
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.56, 0.56, 0.1, 40), lidMat);
  cap.position.y = 0.05;
  lidGroup.add(cap);
  const capTop = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.04, 40), lidMat);
  capTop.position.y = 0.12;
  lidGroup.add(capTop);
  const heart = makeHeartMesh();
  heart.position.y = 0.26;
  lidGroup.add(heart);
  lidGroup.position.y = LID_Y;
  jarGroup.add(lidGroup);

  notesGroup = new THREE.Group();
  jarGroup.add(notesGroup);
  noteGeo = new THREE.BoxGeometry(0.21, 0.035, 0.13);

  jarGroup.position.y = 0.94;      // sitting on the tabletop
  scene.add(jarGroup);
}

function makeHeartMesh() {
  const s = new THREE.Shape();
  s.moveTo(0.25, 0.25);
  s.bezierCurveTo(0.25, 0.25, 0.2, 0, 0, 0);
  s.bezierCurveTo(-0.3, 0, -0.3, 0.35, -0.3, 0.35);
  s.bezierCurveTo(-0.3, 0.55, -0.1, 0.77, 0.25, 0.95);
  s.bezierCurveTo(0.6, 0.77, 0.8, 0.55, 0.8, 0.35);
  s.bezierCurveTo(0.8, 0.35, 0.8, 0, 0.5, 0);
  s.bezierCurveTo(0.35, 0, 0.25, 0.25, 0.25, 0.25);
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: 0.12, bevelEnabled: true, bevelSize: 0.04, bevelThickness: 0.04, bevelSegments: 2,
  });
  geo.center();
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xe0507a, roughness: 0.35 }));
  m.scale.setScalar(0.22);
  m.rotation.z = Math.PI;          // the shape draws point-up; flip it the right way round
  return m;
}

/* a cream label curved onto the glass, written in our script font */
async function makeLabel() {
  try { await document.fonts.load('600 44px "Dancing Script"'); } catch (e) { /* fallback font is fine */ }
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const x = c.getContext('2d');
  x.beginPath();
  if (x.roundRect) x.roundRect(10, 14, 236, 100, 16);
  else x.rect(10, 14, 236, 100);
  x.fillStyle = '#fffaf0';
  x.fill();
  x.strokeStyle = 'rgba(224,80,122,.55)';
  x.lineWidth = 5;
  x.stroke();
  x.fillStyle = '#8e2547';
  x.font = '600 44px "Dancing Script", cursive';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText('our memories', 128, 54);
  x.fillStyle = '#e0507a';
  x.font = '26px serif';
  x.fillText('♥', 128, 96);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const label = new THREE.Mesh(
    new THREE.CylinderGeometry(0.595, 0.595, 0.34, 24, 1, true, -0.55, 1.1),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true })
  );
  label.position.y = 0.72;
  jarGroup.add(label);
}

/* ===================== the pile of notes inside ===================== */

/* stable pseudo-random spot for the i-th note, so the pile never reshuffles */
function rand01(seed) {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function pileSpot(i) {
  const layer = Math.floor(i / 6);
  const a = rand01(i * 3 + 1) * Math.PI * 2;
  const r = Math.sqrt(rand01(i * 3 + 2)) * 0.34;
  return {
    x: Math.cos(a) * r,
    z: Math.sin(a) * r,
    y: 0.1 + layer * 0.052 + rand01(i * 3 + 3) * 0.015,
    rx: (rand01(i * 7 + 5) - 0.5) * 0.5,
    ry: rand01(i * 7 + 4) * Math.PI * 2,
    rz: (rand01(i * 7 + 6) - 0.5) * 0.5,
  };
}

function makeNoteMesh(i) {
  const mat = new THREE.MeshStandardMaterial({ color: NOTE_COLORS[i % NOTE_COLORS.length], roughness: 0.9 });
  const m = new THREE.Mesh(noteGeo, mat);
  const s = pileSpot(i);
  m.position.set(s.x, s.y, s.z);
  m.rotation.set(s.rx, s.ry, s.rz);
  return m;
}

function buildNotePile() {
  if (!sceneReady) return;
  for (const child of [...notesGroup.children]) {
    notesGroup.remove(child);
    child.material.dispose();
  }
  const n = Math.min(notes.length, MAX_PILE);
  for (let i = 0; i < n; i++) notesGroup.add(makeNoteMesh(i));
}

/* a freshly sent note tumbles in from above while the lid cracks open */
function dropNewNote() {
  if (!sceneReady) return;
  peekLid();
  if (notes.length > MAX_PILE) return;   // jar looks full — the list still has everything
  const i = notes.length - 1;
  const mesh = makeNoteMesh(i);
  const targetY = mesh.position.y;
  mesh.position.y = 2.5;
  notesGroup.add(mesh);
  drops.push({ mesh, targetY, v: 0, bounced: false, spin: (Math.random() - 0.5) * 3 });
}

function peekLid() {
  if (isReading()) return;               // lid is already off while we're reading
  lidTarget = 0.5;
  clearTimeout(lidPeekTimer);
  lidPeekTimer = setTimeout(() => { if (!isReading()) lidTarget = 0; }, 1600);
}

/* ===================== hearts & sounds ===================== */

function makeHeartTextures() {
  for (const color of ['#ff6f9c', '#ffa3c0', '#ffd76b', '#ff4f7e']) {
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

function spawnSprite(tex, pos, opts) {
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const spr = new THREE.Sprite(mat);
  spr.raycast = function () {};          // decorations never swallow clicks
  spr.position.copy(pos);
  spr.scale.setScalar(opts.size || 0.15);
  scene.add(spr);
  particles.push(Object.assign({
    spr, vx: 0, vy: 0.3, vz: 0, life: 1, decay: 0.8, sway: 0,
    phase: Math.random() * Math.PI * 2, ambient: false,
  }, opts));
}

function spawnHeartBurst(pos, n) {
  for (let i = 0; i < n; i++) {
    spawnSprite(heartTex(), pos, {
      size: 0.08 + Math.random() * 0.08,
      vx: (Math.random() - 0.5) * 0.6,
      vy: 0.45 + Math.random() * 0.4,
      vz: (Math.random() - 0.5) * 0.4,
      decay: 1.1, sway: 0.02,
    });
  }
}

function spawnAmbientHeart() {
  spawnSprite(heartTex(), new THREE.Vector3(-2 + Math.random() * 4, 0.3, -1 + Math.random() * 2), {
    size: 0.1 + Math.random() * 0.1,
    vy: 0.14 + Math.random() * 0.1,
    decay: 0.12, sway: 0.09, ambient: true,
  });
  ambientCount++;
}

function playTone(freq, dur, type, vol, delay) {
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
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start(t0);
    o.stop(t0 + (dur || 0.15) + 0.05);
  } catch (e) { /* no sound is fine */ }
}

const sounds = {
  pop() { playTone(740, 0.12, 'triangle', 0.05); },
  plop() { playTone(340, 0.1, 'sine', 0.06); playTone(230, 0.12, 'sine', 0.05, 0.06); },
  fold() { playTone(520, 0.08, 'triangle', 0.04); playTone(620, 0.08, 'triangle', 0.04, 0.09); playTone(720, 0.1, 'triangle', 0.04, 0.18); },
  chime() { playTone(523, 0.2, 'sine', 0.05); playTone(659, 0.22, 'sine', 0.05, 0.1); playTone(784, 0.3, 'sine', 0.05, 0.2); },
  no() { playTone(220, 0.15, 'square', 0.035); playTone(180, 0.2, 'square', 0.035, 0.12); },
};

/* ===================== pointer ===================== */

function setPointerFromEvent(event) {
  const canvas = $('#jarCanvas');
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
}

function overlayOpen() {
  return ['notePopup', 'jarLock', 'jarRead'].some((id) => !document.getElementById(id).classList.contains('hidden'));
}

function onCanvasClick(event) {
  if (overlayOpen()) return;
  setPointerFromEvent(event);
  if (raycaster.intersectObject(jarGroup, true).length) { requestOpenJar(); return; }
  const hits = raycaster.intersectObjects(scene.children, true);
  if (hits.length) {
    const p = hits[0].point.clone();
    p.y += 0.06;
    spawnHeartBurst(p, 5);
    sounds.pop();
  }
}

function onCanvasHover(event) {
  if (overlayOpen()) { jarHovered = false; return; }
  setPointerFromEvent(event);
  jarHovered = raycaster.intersectObject(jarGroup, true).length > 0;
  $('#jarCanvas').style.cursor = jarHovered ? 'pointer' : 'default';
}

/* ===================== cloud data ===================== */

async function loadNotes() {
  const { data, error } = await window.sb.from('jar').select('*').order('created_at', { ascending: true });
  if (error) { toast('Could not open the jar — check your connection'); notes = []; return; }
  notes = data || [];
}

function setupRealtime() {
  window.sb.channel('jar-sync')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'jar' }, (payload) => {
      const row = payload.new;
      if (localIds.has(row.id) || notes.some((n) => n.id === row.id)) return;
      notes.push(row);
      dropNewNote();
      renderList();
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'jar' }, async () => {
      await loadNotes();
      buildNotePile();
      renderList();
    })
    .subscribe();
}

/* ===================== writing a note ===================== */

function syncWhoChips() {
  document.querySelectorAll('.who-chip[data-who]').forEach((c) => c.classList.toggle('sel', c.dataset.who === currentWho));
}
document.querySelectorAll('.who-chip[data-who]').forEach((chip) => {
  chip.addEventListener('click', () => {
    currentWho = chip.dataset.who;
    localStorage.setItem('jarWho', currentWho);
    syncWhoChips();
  });
});
syncWhoChips();

async function sendNote() {
  const text = $('#noteText').value.trim();
  if (!currentWho) { toast('pick who you are first ♥'); return; }
  if (!text) { toast('write a little something first ♥'); return; }
  const btn = $('#noteSend');
  btn.disabled = true;
  const { data, error } = await window.sb.from('jar').insert({ author: currentWho, message: text }).select().single();
  btn.disabled = false;
  if (error) { toast('Couldn’t reach the jar — check your connection'); return; }
  localIds.add(data.id);
  setTimeout(() => localIds.delete(data.id), 5000);
  notes.push(data);
  renderList();
  foldAndDrop();
}

function foldAndDrop() {
  const paper = $('#notePaper');
  paper.classList.add('folding');
  sounds.fold();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    $('#notePopup').classList.add('hidden');
    paper.classList.remove('folding');
    $('#noteText').value = '';
    dropNewNote();
    toast('tucked safely into our jar ♥');
  };
  paper.addEventListener('animationend', finish, { once: true });
  setTimeout(finish, 1400);              // just in case the animation event never fires
}

/* ===================== opening & reading ===================== */

function isReading() { return !$('#jarRead').classList.contains('hidden'); }

function requestOpenJar() {
  if (isReading()) return;
  if (unlocked) { openJarRead(); return; }
  $('#jarLock').classList.remove('hidden');
  setTimeout(() => $('#jarPass').focus(), 80);
}

function openJarRead() {
  lidTarget = 1;
  clearTimeout(lidPeekTimer);
  sounds.chime();
  renderList();
  // let the lid start lifting before the notes appear
  setTimeout(() => $('#jarRead').classList.remove('hidden'), 350);
}

function closeJarRead() {
  $('#jarRead').classList.add('hidden');
  lidTarget = 0;
}

$('#jarLockForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const err = $('#jarLockError');
  if ($('#jarPass').value === JAR_PASSWORD) {
    unlocked = true;
    $('#jarPass').value = '';
    err.classList.remove('show');
    $('#jarLock').classList.add('hidden');
    openJarRead();
  } else {
    const card = document.querySelector('#jarLock .lock-card');
    card.classList.remove('shake');
    void card.offsetWidth;               // restart the shake animation
    card.classList.add('shake');
    err.textContent = 'hmm, that’s not it — try again ♥';
    err.classList.add('show');
    $('#jarPass').value = '';
    $('#jarPass').focus();
    sounds.no();
  }
});

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function renderList() {
  const list = $('#jarList');
  list.innerHTML = '';
  let rows = notes.filter((n) => filterWho === 'all' || n.author === filterWho);
  if (rangeFrom) {
    const from = new Date(rangeFrom + 'T00:00:00');
    rows = rows.filter((n) => new Date(n.created_at) >= from);
  }
  if (rangeTo) {
    const to = new Date(rangeTo + 'T23:59:59.999');
    rows = rows.filter((n) => new Date(n.created_at) <= to);
  }
  rows = rows.slice().sort((a, b) => (new Date(a.created_at) - new Date(b.created_at)) * (sortDesc ? -1 : 1));

  if (!rows.length) {
    let msg;
    if (rangeFrom || rangeTo) msg = 'no notes between those days — try different dates ♥';
    else if (filterWho === 'all') msg = 'the jar is waiting for its very first note ♥';
    else msg = 'no notes from ' + (filterWho === 'unif' ? 'Unif' : 'Tata') + ' yet ♥';
    list.appendChild(el('div', 'jar-empty', msg));
    return;
  }

  for (const n of rows) {
    const item = el('div', 'jar-note from-' + n.author);
    const txt = el('div', 'jar-note-text');
    txt.textContent = n.message;
    const meta = el('div', 'jar-note-meta');
    const who = el('span', 'jar-note-who');
    who.textContent = n.author === 'unif' ? 'Unif ♥' : 'Tata ♥';
    meta.appendChild(who);
    meta.appendChild(document.createTextNode(' · ' + fmtDate(n.created_at)));
    item.append(txt, meta);
    list.appendChild(item);
  }
}

document.querySelectorAll('.filter-chip[data-filter]').forEach((chip) => {
  chip.addEventListener('click', () => {
    filterWho = chip.dataset.filter;
    document.querySelectorAll('.filter-chip[data-filter]').forEach((c) => c.classList.toggle('sel', c === chip));
    renderList();
  });
});

$('#jarSortBtn').addEventListener('click', () => {
  sortDesc = !sortDesc;
  $('#jarSortBtn').textContent = sortDesc ? 'newest first ↓' : 'oldest first ↑';
  renderList();
});

/* pick a stretch of days to look back on — only notes from those days show */
function syncRangeClear() {
  $('#jarRangeClear').classList.toggle('show', !!(rangeFrom || rangeTo));
}
$('#jarFrom').addEventListener('change', () => { rangeFrom = $('#jarFrom').value; syncRangeClear(); renderList(); });
$('#jarTo').addEventListener('change', () => { rangeTo = $('#jarTo').value; syncRangeClear(); renderList(); });
$('#jarRangeClear').addEventListener('click', () => {
  rangeFrom = rangeTo = '';
  $('#jarFrom').value = '';
  $('#jarTo').value = '';
  syncRangeClear();
  renderList();
});

/* ===================== buttons & overlays ===================== */

$('#writeNoteBtn').addEventListener('click', () => {
  $('#notePopup').classList.remove('hidden');
  setTimeout(() => $('#noteText').focus(), 80);
});
$('#openJarBtn').addEventListener('click', requestOpenJar);
$('#noteClose').addEventListener('click', () => $('#notePopup').classList.add('hidden'));
$('#lockClose').addEventListener('click', () => $('#jarLock').classList.add('hidden'));
$('#readClose').addEventListener('click', closeJarRead);
$('#noteSend').addEventListener('click', sendNote);

$('#notePopup').addEventListener('click', (e) => {
  if (e.target.id === 'notePopup' && !$('#notePaper').classList.contains('folding')) {
    $('#notePopup').classList.add('hidden');
  }
});
$('#jarLock').addEventListener('click', (e) => {
  if (e.target.id === 'jarLock') $('#jarLock').classList.add('hidden');
});
$('#jarRead').addEventListener('click', (e) => {
  if (e.target.id === 'jarRead') closeJarRead();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !$('#view-jar').classList.contains('active')) return;
  if (!$('#notePopup').classList.contains('hidden')) $('#notePopup').classList.add('hidden');
  else if (!$('#jarLock').classList.contains('hidden')) $('#jarLock').classList.add('hidden');
  else if (isReading()) closeJarRead();
});

/* ===================== animation loop ===================== */

const worldPos = new THREE.Vector3();

function animate() {
  requestAnimationFrame(animate);
  const t = clock.getElapsedTime();
  const dt = Math.min(t - lastT, 0.05);
  lastT = t;

  // the lid glides between snug and lifted-aside
  lidT += (lidTarget - lidT) * Math.min(1, dt * 5);
  lidGroup.position.y = LID_Y + lidT * 0.6;
  lidGroup.position.x = lidT * 0.85;
  lidGroup.position.z = lidT * 0.15;
  lidGroup.rotation.z = -lidT * 0.55;

  // notes tumbling in
  for (let i = drops.length - 1; i >= 0; i--) {
    const d = drops[i];
    d.v -= 6 * dt;
    d.mesh.position.y += d.v * dt;
    d.mesh.rotation.y += d.spin * dt;
    if (d.mesh.position.y <= d.targetY) {
      d.mesh.position.y = d.targetY;
      if (!d.bounced && d.v < -1.2) {
        d.bounced = true;
        d.v = -d.v * 0.25;
      } else {
        drops.splice(i, 1);
        sounds.plop();
        d.mesh.getWorldPosition(worldPos);
        worldPos.y += 0.3;
        spawnHeartBurst(worldPos, 4);
      }
    }
  }

  // the jar leans in a little when hovered
  const target = jarHovered ? 1.03 : 1;
  jarGroup.scale.setScalar(jarGroup.scale.x + (target - jarGroup.scale.x) * Math.min(1, dt * 10));

  // floating hearts
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
  if (t - lastAmbient > 1.6 && ambientCount < 7) {
    lastAmbient = t;
    spawnAmbientHeart();
  }

  camera.position.x = Math.sin(t * 0.15) * 0.18;
  camera.lookAt(0, 1.55, 0);
  renderer.render(scene, camera);
}

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.view === 'jar') startJar();
  });
});

})();
