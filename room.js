'use strict';

(function () {
const $ = (sel) => document.querySelector(sel);

let started = false;
let renderer, scene, camera, clock;
let cardMesh, candleLight, candleGroup, candleFlameMesh, candleLit = true;
let raycaster, pointer;
let cardOpened = false;
let framePreviewOpen = false;
let currentFramePhotoUrl = null;

async function startRoom() {
  if (started) return;
  started = true;

  const canvas = $('#roomCanvas');
  const container = $('#roomScene');

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xfbdce6);
  scene.fog = new THREE.Fog(0xfbdce6, 7, 15);

  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(0, 2.5, 4.4);

  buildRoom();
  buildTable();
  buildChairs();
  buildCandle();
  buildDecor();
  buildCard();
  await buildFrame();

  raycaster = new THREE.Raycaster();
  pointer = new THREE.Vector2();
  clock = new THREE.Clock();

  window.addEventListener('resize', onResize);
  onResize();

  canvas.addEventListener('click', onCanvasClick);
  // no click-outside-to-close on purpose — Yes is the only way out

  $('#roomLoading').classList.add('hidden');
  animate();
}

function onResize() {
  const container = $('#roomScene');
  const w = container.clientWidth || 1, h = container.clientHeight || 1;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

function buildRoom() {
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(6.5, 48),
    new THREE.MeshStandardMaterial({ color: 0xf3c6d3, roughness: 0.95 })
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const wall = new THREE.Mesh(
    new THREE.PlaneGeometry(16, 7),
    new THREE.MeshStandardMaterial({ color: 0xffe6ee, roughness: 1 })
  );
  wall.position.set(0, 3.2, -3.2);
  scene.add(wall);

  scene.add(new THREE.AmbientLight(0xfff0f5, 0.7));
  const hemi = new THREE.HemisphereLight(0xffeef3, 0xd88fa8, 0.55);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xfff2e2, 0.45);
  dir.position.set(3, 5, 4);
  scene.add(dir);

  // fairy lights strung along the back wall
  const bulbGeo = new THREE.SphereGeometry(0.05, 8, 8);
  for (let i = 0; i < 16; i++) {
    const t = i / 15;
    const x = -3.8 + t * 7.6;
    const y = 2.15 + Math.sin(t * Math.PI * 4) * 0.28;
    const bulb = new THREE.Mesh(
      bulbGeo,
      new THREE.MeshStandardMaterial({ color: 0xffe9b0, emissive: 0xffb347, emissiveIntensity: 1.8 })
    );
    bulb.position.set(x, y, -3.05);
    scene.add(bulb);
  }
}

function buildTable() {
  const group = new THREE.Group();

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(1.7, 32),
    new THREE.MeshBasicMaterial({ color: 0x5a1e32, transparent: true, opacity: 0.15 })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.012;
  group.add(shadow);

  const legMat = new THREE.MeshStandardMaterial({ color: 0xd9a97a, roughness: 0.6 });

  const top = new THREE.Mesh(
    new THREE.CylinderGeometry(1.3, 1.3, 0.08, 40),
    new THREE.MeshStandardMaterial({ color: 0xecd9c6, roughness: 0.5 })
  );
  top.position.y = 1.0;
  group.add(top);

  const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.22, 1.0, 24), legMat);
  leg.position.y = 0.5;
  group.add(leg);

  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.06, 32), legMat);
  base.position.y = 0.03;
  group.add(base);

  const runner = new THREE.Mesh(
    new THREE.PlaneGeometry(0.5, 2.5),
    new THREE.MeshStandardMaterial({ color: 0xe0507a, roughness: 0.85, side: THREE.DoubleSide })
  );
  runner.rotation.x = -Math.PI / 2;
  runner.rotation.z = 0.55;
  runner.position.y = 1.045;
  group.add(runner);

  scene.add(group);
}

function buildChairs() {
  const mat = new THREE.MeshStandardMaterial({ color: 0xf6a9c1, roughness: 0.75 });
  const legGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.55, 8);

  function chair(x, z, rotY) {
    const g = new THREE.Group();
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 0.5), mat);
    seat.position.y = 0.55;
    g.add(seat);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.55, 0.06), mat);
    back.position.set(0, 0.85, -0.22);
    g.add(back);
    [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]].forEach(([lx, lz]) => {
      const leg = new THREE.Mesh(legGeo, mat);
      leg.position.set(lx, 0.275, lz);
      g.add(leg);
    });
    g.position.set(x, 0, z);
    g.rotation.y = rotY;
    scene.add(g);
  }

  chair(-1.85, -0.9, Math.PI * 0.28);
  chair(1.85, -0.9, -Math.PI * 0.28);
}

function buildCandle() {
  const group = new THREE.Group();

  // a little wider hit-target so the flame is easy to tap
  const catcher = new THREE.Mesh(
    new THREE.CylinderGeometry(0.14, 0.14, 0.5, 12),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  catcher.position.y = 0.2;
  group.add(catcher);

  const wax = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.055, 0.28, 16),
    new THREE.MeshStandardMaterial({ color: 0xfff3d6, roughness: 0.5 })
  );
  wax.position.y = 0.14;
  group.add(wax);

  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(0.025, 0.08, 8),
    new THREE.MeshBasicMaterial({ color: 0xffb347 })
  );
  flame.position.y = 0.32;
  group.add(flame);
  candleFlameMesh = flame;

  candleLight = new THREE.PointLight(0xffc088, 0.85, 4.5, 2);
  candleLight.position.set(0, 0.35, 0);
  group.add(candleLight);

  group.position.set(0, 1.04, -0.35);
  scene.add(group);
  candleGroup = group;
}

function toggleCandle() {
  candleLit = !candleLit;
  candleFlameMesh.visible = candleLit;
}

function buildDecor() {
  // rug under the table
  const rug = new THREE.Mesh(
    new THREE.CircleGeometry(2.3, 40),
    new THREE.MeshStandardMaterial({ color: 0xf0b8cc, roughness: 1 })
  );
  rug.rotation.x = -Math.PI / 2;
  rug.position.y = 0.004;
  scene.add(rug);
  const rugRing = new THREE.Mesh(
    new THREE.RingGeometry(2.14, 2.3, 48),
    new THREE.MeshStandardMaterial({ color: 0xe0507a, roughness: 1, side: THREE.DoubleSide })
  );
  rugRing.rotation.x = -Math.PI / 2;
  rugRing.position.y = 0.005;
  scene.add(rugRing);

  // place settings — a plate at each chair
  const plateMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xe0507a, roughness: 0.5 });
  [[-0.9, -0.44], [0.9, -0.44]].forEach(([px, pz]) => {
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.015, 32), plateMat);
    plate.position.set(px, 1.048, pz);
    scene.add(plate);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.006, 8, 32), rimMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.set(px, 1.057, pz);
    scene.add(rim);
  });

}

function buildCard() {
  const group = new THREE.Group();

  // soft glow halo under the card to draw the eye
  const glow = new THREE.Mesh(
    new THREE.CircleGeometry(0.4, 24),
    new THREE.MeshBasicMaterial({ color: 0xffb6cf, transparent: true, opacity: 0.4 })
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = -0.004;
  group.add(glow);

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.46, 0.025, 0.33),
    new THREE.MeshStandardMaterial({ color: 0xfff0f5, roughness: 0.5 })
  );
  group.add(body);

  // ribbon cross, gift-wrap style
  const ribbonMat = new THREE.MeshStandardMaterial({ color: 0xe0507a, roughness: 0.45 });
  const ribbonA = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.028, 0.33), ribbonMat);
  group.add(ribbonA);
  const ribbonB = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.028, 0.08), ribbonMat);
  group.add(ribbonB);

  const seal = new THREE.Mesh(
    new THREE.CircleGeometry(0.065, 20),
    new THREE.MeshStandardMaterial({ color: 0xb23a60, roughness: 0.3, emissive: 0x8e2547, emissiveIntensity: 0.25 })
  );
  seal.rotation.x = -Math.PI / 2;
  seal.position.y = 0.017;
  group.add(seal);

  group.position.set(0.55, 1.05, 0.35);
  group.rotation.y = -0.35;
  scene.add(group);
  cardMesh = group;
}

let frameGroup, framePhotoMesh;

async function resolveFramePhotoUrl() {
  const sb = window.sb;
  try {
    const { data: setting } = await sb.from('settings').select('value').eq('key', 'frame_photo_path').maybeSingle();
    if (setting && setting.value) {
      const { data: signed } = await sb.storage.from(window.BUCKET).createSignedUrl(setting.value, 3600);
      if (signed) return signed.signedUrl;
    }
  } catch (e) { /* no custom photo chosen yet */ }
  try {
    const { data: rows } = await sb.from('book').select('storage_path').order('created_at', { ascending: false }).limit(1);
    if (rows && rows[0]) {
      const { data: signed } = await sb.storage.from(window.BUCKET).createSignedUrl(rows[0].storage_path, 3600);
      if (signed) return signed.signedUrl;
    }
  } catch (e) { /* no book photo either */ }
  return null;
}

async function applyFrameTexture(url) {
  if (!url) return;
  const texture = await new THREE.TextureLoader().loadAsync(url);
  texture.colorSpace = THREE.SRGBColorSpace;
  if (framePhotoMesh.material.map) framePhotoMesh.material.map.dispose();
  framePhotoMesh.material.dispose();
  framePhotoMesh.material = new THREE.MeshBasicMaterial({ map: texture });
  currentFramePhotoUrl = url;
}

async function buildFrame() {
  const group = new THREE.Group();

  const border = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.62, 0.03),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 })
  );
  group.add(border);

  const url = await resolveFramePhotoUrl();
  let photoMat;
  if (url) {
    const texture = await new THREE.TextureLoader().loadAsync(url);
    texture.colorSpace = THREE.SRGBColorSpace;
    photoMat = new THREE.MeshBasicMaterial({ map: texture });
    currentFramePhotoUrl = url;
  } else {
    photoMat = new THREE.MeshStandardMaterial({ color: 0xffd9e6 });
  }
  const photo = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.54), photoMat);
  photo.position.z = 0.016;
  group.add(photo);
  framePhotoMesh = photo;

  const stand = new THREE.Mesh(
    new THREE.BoxGeometry(0.04, 0.32, 0.04),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 })
  );
  stand.position.set(0, -0.26, -0.14);
  stand.rotation.x = 0.5;
  group.add(stand);

  group.position.set(-0.55, 1.36, -0.2);
  group.rotation.y = 0.35;
  group.rotation.x = -0.08;
  scene.add(group);
  frameGroup = group;
}

async function changeFramePhoto(file) {
  try {
    const blob = await window.shrink(file, 1000, 0.85);
    const path = 'frame/' + crypto.randomUUID();
    const sb = window.sb;
    const { error: upErr } = await sb.storage.from(window.BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
    if (upErr) throw upErr;
    const { error: setErr } = await sb
      .from('settings')
      .upsert({ key: 'frame_photo_path', value: path }, { onConflict: 'key' });
    if (setErr) throw setErr;
    const { data: signed } = await sb.storage.from(window.BUCKET).createSignedUrl(path, 3600);
    if (signed) {
      await applyFrameTexture(signed.signedUrl);
      if (framePreviewOpen) $('#framePreviewImg').src = signed.signedUrl;
    }
  } catch (e) {
    // silently ignore — the frame just keeps its current photo
  }
}

function openFramePreview() {
  framePreviewOpen = true;
  $('#framePreviewImg').src = currentFramePhotoUrl || '';
  $('#framePreview').classList.remove('hidden');
}

function closeFramePreview() {
  framePreviewOpen = false;
  $('#framePreview').classList.add('hidden');
}

function onCanvasClick(event) {
  if (cardOpened || framePreviewOpen) return;
  const canvas = $('#roomCanvas');
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  if (raycaster.intersectObject(cardMesh, true).length) { openCard(); return; }
  if (frameGroup && raycaster.intersectObject(frameGroup, true).length) { openFramePreview(); return; }
  if (candleGroup && raycaster.intersectObject(candleGroup, true).length) { toggleCandle(); return; }
}

async function openCard() {
  cardOpened = true;
  await loadCardMessage();
  $('#cardOverlay').classList.remove('hidden');
  resetNoButton();
}

function closeCard() {
  cardOpened = false;
  $('#cardOverlay').classList.add('hidden');
  resetNoButton();
}

let lastSavedMessage = null;

async function loadCardMessage() {
  const el = $('#cardMessage');
  try {
    const { data } = await window.sb.from('settings').select('value').eq('key', 'card_message').maybeSingle();
    lastSavedMessage = (data && data.value) || '';
    el.textContent = lastSavedMessage;
  } catch (e) {
    // leave whatever is already there / placeholder
  }
}

const cardMessageEl = $('#cardMessage');
cardMessageEl.addEventListener('click', (e) => e.stopPropagation());
cardMessageEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); cardMessageEl.blur(); }
});
cardMessageEl.addEventListener('blur', async () => {
  const text = cardMessageEl.textContent.trim();
  if (text === lastSavedMessage) return;
  lastSavedMessage = text;
  await window.sb.from('settings').update({ value: text }).eq('key', 'card_message');
});

/* ===== the "No" button — playfully impossible to press, and free to roam
   the whole scene, not just the card ===== */

let noAwake = false;    // stays put like a normal button until the cursor first reaches it
const noBtn = $('#noBtn');
const cardOverlayEl = $('#cardOverlay');

function overlayBounds() {
  const w = cardOverlayEl.clientWidth, h = cardOverlayEl.clientHeight;
  const btnW = noBtn.offsetWidth || 90, btnH = noBtn.offsetHeight || 46;
  const pad = 14;
  return { w, h, btnW, btnH, pad };
}

function placeNoButtonPx(x, y) {
  const { w, h, btnW, btnH, pad } = overlayBounds();
  noBtn.style.left = Math.min(Math.max(x, pad), w - btnW - pad) + 'px';
  noBtn.style.top = Math.min(Math.max(y, pad), h - btnH - pad) + 'px';
}

function resetNoButton() {
  noAwake = false;
  // start out looking like a completely normal, static button, right beside Yes
  const overlayRect = cardOverlayEl.getBoundingClientRect();
  const yesRect = $('#yesBtn').getBoundingClientRect();
  placeNoButtonPx(yesRect.right - overlayRect.left + 18, yesRect.top - overlayRect.top + 5);
}

function dodgeNoButton() {
  const { w, h, btnW, btnH, pad } = overlayBounds();
  placeNoButtonPx(pad + Math.random() * Math.max(10, w - btnW - pad * 2), pad + Math.random() * Math.max(10, h - btnH - pad * 2));
}

function wakeAndDodge() {
  noAwake = true;
  dodgeNoButton();
}

// stays put until the cursor actually reaches it for the first time — only then does it "wake up"
cardOverlayEl.addEventListener('pointermove', (e) => {
  if (cardOverlayEl.classList.contains('hidden') || !noAwake) return;
  const r = noBtn.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  if (Math.hypot(e.clientX - cx, e.clientY - cy) < 95) dodgeNoButton();
});
noBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); wakeAndDodge(); });
noBtn.addEventListener('pointerenter', () => wakeAndDodge());
noBtn.addEventListener('click', (e) => { e.preventDefault(); wakeAndDodge(); });

/* ===== the "Yes" button ===== */

$('#yesBtn').addEventListener('click', () => {
  closeCard();
  launchCelebration();
});

function animate() {
  requestAnimationFrame(animate);
  const t = clock.getElapsedTime();

  if (cardMesh && !cardOpened) {
    cardMesh.position.y = 1.05 + Math.sin(t * 2) * 0.015;
    cardMesh.rotation.y = -0.35 + Math.sin(t * 0.8) * 0.06;
  }
  if (candleLight) {
    candleLight.intensity = candleLit ? 0.85 + Math.sin(t * 9) * 0.15 + Math.sin(t * 23) * 0.06 : 0;
  }

  camera.position.x = Math.sin(t * 0.15) * 0.18;
  camera.lookAt(0, 1.05, 0);

  renderer.render(scene, camera);
}

/* ===== confetti + fireworks celebration ===== */

const fxCanvas = $('#fxCanvas');
const fxCtx = fxCanvas.getContext('2d');
let fxParticles = [];
let fxRunning = false;
let fxSpawnUntil = 0;
let fxFireworkTimer = null;

const FX_COLORS = ['#e0507a', '#ffb6cf', '#ffd76b', '#ffffff', '#f6a9c1', '#b23a60'];

function resizeFx() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  fxCanvas.width = window.innerWidth * dpr;
  fxCanvas.height = window.innerHeight * dpr;
}
window.addEventListener('resize', resizeFx);
resizeFx();

function spawnConfettiBurst(count) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = fxCanvas.width;
  for (let i = 0; i < count; i++) {
    fxParticles.push({
      type: 'confetti',
      x: Math.random() * w,
      y: -20 * dpr - Math.random() * 300 * dpr,
      vx: (Math.random() - 0.5) * 2.2 * dpr,
      vy: (2 + Math.random() * 3) * dpr,
      size: (5 + Math.random() * 6) * dpr,
      rot: Math.random() * Math.PI * 2,
      vrot: (Math.random() - 0.5) * 0.3,
      color: FX_COLORS[(Math.random() * FX_COLORS.length) | 0],
    });
  }
}

function spawnFirework() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = fxCanvas.width, h = fxCanvas.height;
  const targetX = w * (0.2 + Math.random() * 0.6);
  const targetY = h * (0.16 + Math.random() * 0.3);
  const startX = targetX + (Math.random() - 0.5) * 60 * dpr;
  fxParticles.push({
    type: 'rocket',
    x: startX, y: h,
    vx: (targetX - startX) / 45,
    vy: (targetY - h) / 45,
    targetY,
    color: FX_COLORS[(Math.random() * FX_COLORS.length) | 0],
  });
}

function burstFirework(x, y, color) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const n = 46;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const speed = (1.5 + Math.random() * 2.6) * dpr;
    fxParticles.push({
      type: 'spark',
      x, y,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed,
      color,
      life: 1,
      decay: 0.012 + Math.random() * 0.01,
    });
  }
}

function launchCelebration() {
  resizeFx();
  fxSpawnUntil = performance.now() + 4200;
  spawnConfettiBurst(140);
  clearTimeout(fxFireworkTimer);
  (function scheduleFirework() {
    if (performance.now() > fxSpawnUntil) return;
    spawnFirework();
    fxFireworkTimer = setTimeout(scheduleFirework, 450 + Math.random() * 500);
  })();
  if (!fxRunning) { fxRunning = true; fxLoop(); }
}

function fxLoop() {
  const w = fxCanvas.width, h = fxCanvas.height;
  fxCtx.clearRect(0, 0, w, h);
  const now = performance.now();
  if (now < fxSpawnUntil && Math.random() < 0.5) spawnConfettiBurst(2);

  for (let i = fxParticles.length - 1; i >= 0; i--) {
    const p = fxParticles[i];
    if (p.type === 'confetti') {
      p.x += p.vx; p.y += p.vy; p.rot += p.vrot; p.vy += 0.02;
      if (p.y > h + 30) { fxParticles.splice(i, 1); continue; }
      fxCtx.save();
      fxCtx.translate(p.x, p.y);
      fxCtx.rotate(p.rot);
      fxCtx.fillStyle = p.color;
      fxCtx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      fxCtx.restore();
    } else if (p.type === 'rocket') {
      p.x += p.vx; p.y += p.vy;
      fxCtx.fillStyle = p.color;
      fxCtx.beginPath();
      fxCtx.arc(p.x, p.y, 3 * (Math.min(window.devicePixelRatio || 1, 2)), 0, Math.PI * 2);
      fxCtx.fill();
      if (p.y <= p.targetY) { burstFirework(p.x, p.y, p.color); fxParticles.splice(i, 1); }
    } else if (p.type === 'spark') {
      p.x += p.vx; p.y += p.vy; p.vy += 0.035; p.vx *= 0.985; p.vy *= 0.985; p.life -= p.decay;
      if (p.life <= 0) { fxParticles.splice(i, 1); continue; }
      fxCtx.globalAlpha = Math.max(p.life, 0);
      fxCtx.fillStyle = p.color;
      fxCtx.beginPath();
      fxCtx.arc(p.x, p.y, 2.4 * (Math.min(window.devicePixelRatio || 1, 2)), 0, Math.PI * 2);
      fxCtx.fill();
      fxCtx.globalAlpha = 1;
    }
  }

  if (fxParticles.length > 0 || now < fxSpawnUntil) {
    requestAnimationFrame(fxLoop);
  } else {
    fxRunning = false;
    fxCtx.clearRect(0, 0, w, h);
  }
}

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.view === 'surprise') startRoom();
  });
});

$('#framePhotoFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file && file.type.startsWith('image/')) changeFramePhoto(file);
});

$('#frameChangeBtn').addEventListener('click', () => $('#framePhotoFile').click());
$('#framePreviewClose').addEventListener('click', closeFramePreview);
$('#framePreview').addEventListener('click', (e) => {
  if (e.target.id === 'framePreview') closeFramePreview();
});

})();
