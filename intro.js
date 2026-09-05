'use strict';

/* The front door — an immersive little journey before the site opens up.
   A book floats in a soft pink space; as you scroll, the camera drifts in,
   the book turns to face you and its cover flips open while hearts and gold
   dust rise past. The last panel has the button that lets you in.

   The 3D is decoration: without WebGL (or when the visitor asks for reduced
   motion) `#intro` just gets `.no3d` and stays a pretty scrolling title page.
   Everything is procedural, so this costs no extra downloads. */

(function () {
const $ = (sel) => document.querySelector(sel);
const intro = $('#intro');
if (!intro) return;

const PANELS = [...document.querySelectorAll('.intro-panel')];
const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let renderer, scene, camera, clock, raf = null;
let world, bookGroup, coverPivot, pagePivots = [], glowSprite, heartKnob;
let heartTextures = [], dustTexture = null;
const flakes = [];                 // hearts & dust drifting upward
let sceneReady = false, running = false;
let progress = 0, shownProgress = 0;
let pointerX = 0, pointerY = 0, targetPX = 0, targetPY = 0;
let wobble = 0, lastT = 0;

/* ===================== maths helpers ===================== */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/* 0 before `a`, 1 after `b`, smoothly eased in between */
function span(p, a, b) {
  const t = clamp01((p - a) / (b - a));
  return t * t * (3 - 2 * t);
}
const mix = (a, b, t) => a + (b - a) * t;

/* ===================== scene ===================== */

function startScene() {
  if (reduceMotion) return false;
  try {
    const canvas = $('#introCanvas');
    if (!canvas || !window.THREE) return false;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);

    world = new THREE.Group();          // everything tilts together under the pointer
    scene.add(world);

    buildLights();
    makeSprites();
    buildBook();
    buildGlow();
    seedFlakes();

    clock = new THREE.Clock();
    window.addEventListener('resize', onResize);
    onResize();
    sceneReady = true;
    return true;
  } catch (e) {
    return false;                       // no WebGL — the words carry it alone
  }
}

let fitZ = 0;                       // extra camera distance for tall, narrow screens

function onResize() {
  const w = window.innerWidth || 1, h = window.innerHeight || 1;
  camera.aspect = w / h;
  // an open book is twice as wide as a closed one — on a phone, stand back enough
  // that it never runs off the sides
  fitZ = camera.aspect < 0.85 ? (0.85 - camera.aspect) * 6.5 : 0;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}

function buildLights() {
  scene.add(new THREE.AmbientLight(0xfff4f8, 1.05));
  scene.add(new THREE.HemisphereLight(0xfff3f7, 0xe8b6c8, 0.75));
  const key = new THREE.DirectionalLight(0xfff4e8, 0.8);
  key.position.set(2.5, 6, 4);
  scene.add(key);
  const rim = new THREE.PointLight(0xffb6cf, 0.7, 18, 2);
  rim.position.set(-3.5, 2.5, -2);
  scene.add(rim);
}

/* a heart, the same shape the jar and the battle use */
function heartGeometry(scale) {
  const s = new THREE.Shape();
  s.moveTo(0.25, 0.25);
  s.bezierCurveTo(0.25, 0.25, 0.2, 0, 0, 0);
  s.bezierCurveTo(-0.3, 0, -0.3, 0.35, -0.3, 0.35);
  s.bezierCurveTo(-0.3, 0.55, -0.1, 0.77, 0.25, 0.95);
  s.bezierCurveTo(0.6, 0.77, 0.8, 0.55, 0.8, 0.35);
  s.bezierCurveTo(0.8, 0.35, 0.8, 0, 0.5, 0);
  s.bezierCurveTo(0.35, 0, 0.25, 0.25, 0.25, 0.25);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.16, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.05, bevelSegments: 2,
  });
  g.center();
  g.scale(scale, scale, scale);
  g.rotateZ(Math.PI);                   // the shape draws point-up; flip it
  return g;
}

const COVER_W = 2.3, COVER_D = 3.05, COVER_T = 0.08;

function buildBook() {
  bookGroup = new THREE.Group();

  const coverMat = new THREE.MeshStandardMaterial({ color: 0x8e2547, roughness: 0.5, metalness: 0.05 });
  const goldMat = new THREE.MeshStandardMaterial({ color: 0xdcb06f, metalness: 0.6, roughness: 0.3 });
  const paperMat = new THREE.MeshStandardMaterial({ color: 0xfffdf8, roughness: 0.8 });

  // the cover that stays put, and the block of pages resting on it
  const back = new THREE.Mesh(new THREE.BoxGeometry(COVER_W, COVER_T, COVER_D), coverMat);
  back.position.set(COVER_W / 2, 0, 0);
  bookGroup.add(back);

  const block = new THREE.Mesh(new THREE.BoxGeometry(COVER_W - 0.16, 0.16, COVER_D - 0.16), paperMat);
  block.position.set(COVER_W / 2, 0.12, 0);
  bookGroup.add(block);

  const spine = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.36, COVER_D), coverMat);
  spine.position.set(0, 0.14, 0);
  bookGroup.add(spine);

  // pages that fan over as the book opens
  for (let i = 0; i < 7; i++) {
    const pivot = new THREE.Group();
    pivot.position.y = 0.14 + i * 0.008;
    const page = new THREE.Mesh(new THREE.BoxGeometry(COVER_W - 0.2, 0.006, COVER_D - 0.2), paperMat);
    page.position.set((COVER_W - 0.2) / 2 + 0.06, 0, 0);
    pivot.add(page);
    bookGroup.add(pivot);
    pagePivots.push(pivot);
  }

  // the front cover, hinged at the spine, with a gold heart on it
  coverPivot = new THREE.Group();
  coverPivot.position.set(0, 0.235, 0);
  const front = new THREE.Mesh(new THREE.BoxGeometry(COVER_W, COVER_T, COVER_D), coverMat);
  front.position.set(COVER_W / 2, 0, 0);
  coverPivot.add(front);

  const trim = new THREE.Mesh(
    new THREE.TorusGeometry(0.78, 0.018, 8, 40),
    goldMat
  );
  trim.rotation.x = Math.PI / 2;
  trim.position.set(COVER_W / 2, COVER_T / 2 + 0.005, 0);
  coverPivot.add(trim);

  heartKnob = new THREE.Mesh(heartGeometry(0.62), goldMat);
  heartKnob.position.set(COVER_W / 2, COVER_T / 2 + 0.12, 0);
  heartKnob.rotation.x = -Math.PI / 2;
  coverPivot.add(heartKnob);
  bookGroup.add(coverPivot);

  bookGroup.position.set(-COVER_W / 2, 0, 0);   // spin around the spine, not the corner
  const holder = new THREE.Group();
  holder.add(bookGroup);
  holder.name = 'holder';
  holder.scale.setScalar(0.6);                 // small enough to sit under the words
  world.add(holder);
}

function buildGlow() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, 'rgba(255,214,232,.95)');
  g.addColorStop(0.45, 'rgba(255,170,205,.35)');
  g.addColorStop(1, 'rgba(255,170,205,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  glowSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.55 }));
  glowSprite.scale.setScalar(5);
  glowSprite.position.set(0, -1.35, -0.6);
  world.add(glowSprite);
  dustTexture = tex;                     // the same soft blob makes lovely dust
}

function makeSprites() {
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

function addFlake(opts) {
  const isHeart = opts.heart !== false;
  const tex = isHeart ? heartTextures[(Math.random() * heartTextures.length) | 0] : dustTexture;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, opacity: opts.opacity || 0.85,
  }));
  spr.position.set(opts.x, opts.y, opts.z);
  spr.scale.setScalar(opts.size);
  world.add(spr);
  flakes.push({ spr, vy: opts.vy, sway: opts.sway, phase: Math.random() * 6.28, base: opts.opacity || 0.85 });
}

function seedFlakes() {
  for (let i = 0; i < 26; i++) {
    addFlake({
      x: -5 + Math.random() * 10, y: -3 + Math.random() * 8, z: -3 + Math.random() * 4,
      size: 0.12 + Math.random() * 0.16, vy: 0.12 + Math.random() * 0.22,
      sway: 0.12 + Math.random() * 0.2, opacity: 0.5 + Math.random() * 0.4,
    });
  }
  for (let i = 0; i < 18; i++) {        // gold dust motes
    addFlake({
      heart: false,
      x: -5 + Math.random() * 10, y: -3 + Math.random() * 8, z: -2 + Math.random() * 3,
      size: 0.1 + Math.random() * 0.22, vy: 0.06 + Math.random() * 0.14,
      sway: 0.2 + Math.random() * 0.25, opacity: 0.22 + Math.random() * 0.25,
    });
  }
}

/* a tap sends a little flurry up past the book */
function burst() {
  if (!sceneReady) return;
  wobble = 1;
  for (let i = 0; i < 10; i++) {
    addFlake({
      x: (Math.random() - 0.5) * 3, y: -1.4 - Math.random(), z: -1 + Math.random() * 2.5,
      size: 0.14 + Math.random() * 0.18, vy: 1.5 + Math.random() * 1.4,
      sway: 0.3 + Math.random() * 0.3, opacity: 0.9,
    });
  }
  if (flakes.length > 90) {              // keep the sky from filling up
    for (const f of flakes.splice(0, flakes.length - 90)) {
      world.remove(f.spr);
      f.spr.material.dispose();
    }
  }
}

/* ===================== the scroll story ===================== */

function readProgress() {
  const max = intro.scrollHeight - intro.clientHeight;
  progress = max > 0 ? clamp01(intro.scrollTop / max) : 0;
}

/* fade each panel's words in as it passes through the middle of the screen */
function paintPanels() {
  const h = intro.clientHeight || 1;
  for (const panel of PANELS) {
    const inner = panel.firstElementChild;
    if (!inner) continue;
    const rect = panel.getBoundingClientRect();
    const centre = rect.top + rect.height / 2;
    const away = Math.abs(centre - h / 2) / h;          // 0 = dead centre
    const vis = clamp01(1 - away * 2.1);
    inner.style.opacity = vis;
    inner.style.transform = 'translateY(' + ((centre - h / 2) * 0.07).toFixed(1) + 'px)';
  }
  // the scroll cue bows out as soon as you start
  const cue = $('#introCue');
  if (cue) cue.style.opacity = String(clamp01(1 - progress * 6));
}

function frame() {
  raf = requestAnimationFrame(frame);
  readProgress();
  paintPanels();
  if (!sceneReady) return;

  const t = clock.getElapsedTime();
  const dt = Math.min(t - lastT, 0.05);
  lastT = t;

  shownProgress += (progress - shownProgress) * Math.min(1, dt * 6);   // ease the scrub
  const p = shownProgress;

  // camera drifts in and settles as you read
  camera.position.set(
    mix(1.0, 0, span(p, 0, 0.75)) + pointerX * 0.3,
    mix(3.3, 2.3, span(p, 0, 0.8)) + pointerY * 0.2,
    mix(8.4, 6.4, span(p, 0, 0.9)) + fitZ
  );
  camera.lookAt(0, mix(0.1, -0.15, span(p, 0.3, 1)), 0);

  const holder = world.getObjectByName('holder');
  if (holder) {
    // the book turns to face you, then the cover flips wide open
    holder.rotation.y = mix(-0.85, 0.02, span(p, 0.05, 0.7));
    holder.rotation.x = mix(0.34, 0.12, span(p, 0.2, 0.85)) + Math.sin(t * 0.6) * 0.012;
    holder.position.y = -1.35 + Math.sin(t * 0.9) * 0.07 + wobble * 0.06;
    holder.rotation.z = Math.sin(t * 7) * 0.02 * wobble;
  }

  const open = span(p, 0.5, 0.95);
  // the book hinges at its spine, so as it opens it would drift left — slide it
  // back so the spread stays centred on screen the whole way through
  bookGroup.position.x = (-COVER_W / 2) * (1 - open);
  coverPivot.rotation.z = open * Math.PI * 0.86;
  for (let i = 0; i < pagePivots.length; i++) {
    const share = 0.12 + (i / pagePivots.length) * 0.8;               // pages fan, not flip as one
    pagePivots[i].rotation.z = open * Math.PI * 0.86 * share;
  }
  glowSprite.material.opacity = 0.35 + open * 0.4 + Math.sin(t * 1.4) * 0.03;
  glowSprite.scale.setScalar(mix(5, 8, open));

  wobble *= Math.max(0, 1 - dt * 3);

  // hearts and dust keep rising, wrapping round when they leave the top
  for (const f of flakes) {
    f.spr.position.y += f.vy * dt;
    f.spr.position.x += Math.sin(t * 1.3 + f.phase) * f.sway * dt;
    if (f.spr.position.y > 5.5) {
      f.spr.position.y = -3.5;
      f.spr.position.x = -5 + Math.random() * 10;
    }
    f.spr.material.opacity = f.base * (0.65 + 0.35 * Math.sin(t * 1.7 + f.phase));
  }

  pointerX += (targetPX - pointerX) * Math.min(1, dt * 3);
  pointerY += (targetPY - pointerY) * Math.min(1, dt * 3);

  renderer.render(scene, camera);
}

/* ===================== wiring ===================== */

function onPointerMove(e) {
  const w = window.innerWidth || 1, h = window.innerHeight || 1;
  targetPX = (e.clientX / w) * 2 - 1;
  targetPY = -((e.clientY / h) * 2 - 1);
}

function begin() {
  if (running || intro.classList.contains('hidden')) return;
  running = true;
  if (!startScene()) intro.classList.add('no3d');
  intro.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;          // let the buttons be buttons
    burst();
  });
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  lastT = 0;
  if (clock) clock.getElapsedTime();
  frame();
}

/* when the site opens, wind everything down so nothing keeps burning battery */
function stop() {
  running = false;
  if (raf) cancelAnimationFrame(raf);
  raf = null;
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('resize', onResize);
  if (!sceneReady) return;
  sceneReady = false;
  for (const f of flakes) f.spr.material.dispose();
  flakes.length = 0;
  scene.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
  });
  renderer.dispose();
}

// the skip link and the final button both mean "let me in"
const skip = $('#introSkip');
if (skip) skip.addEventListener('click', () => intro.classList.add('hidden'));

new MutationObserver(() => {
  if (intro.classList.contains('hidden')) setTimeout(stop, 900);      // after the fade
}).observe(intro, { attributes: true, attributeFilter: ['class'] });

// only start once the passcode gate is out of the way — no sense rendering
// a scene nobody can see while someone is typing their password
const gate = $('#gate');
if (!gate || gate.classList.contains('hidden')) begin();
else new MutationObserver((_, obs) => {
  if (gate.classList.contains('hidden')) { obs.disconnect(); begin(); }
}).observe(gate, { attributes: true, attributeFilter: ['class'] });

})();
