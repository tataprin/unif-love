'use strict';

/* ===================== tiny helpers ===================== */

const $ = (sel) => document.querySelector(sel);

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3400);
}

function loadImage(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('bad image'));
    im.src = url;
  });
}

/* Shrink big photos so they upload fast and flip smoothly. */
async function shrink(file, maxDim = 1600, quality = 0.85) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
    return blob || file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ===================== cloud storage (Supabase) ===================== */

const SUPABASE_URL = 'https://cipxuiszpafwhgnyprzj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNpcHh1aXN6cGFmd2hnbnlwcnpqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzMTExNTQsImV4cCI6MjA5OTg4NzE1NH0.tHvJjo0hRBoxg03Qckmme2T4L9AzfSf7aFEhmWJ_p0o';
const SHARED_EMAIL = 'hello@unif.love';
const BUCKET = 'memories';
const SIGNED_URL_TTL = 7 * 24 * 60 * 60; // 7 days — long-lived so pictures stay browser-cached between visits

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
window.sb = sb;          // shared with room.js so it doesn't need its own session
window.BUCKET = BUCKET;
window.shrink = shrink;

/* Signed URLs are kept in localStorage and reused between visits — minting a
   fresh URL every login made every photo look brand-new to the browser, so
   nothing was ever served from its cache and everything re-downloaded. */
const URL_CACHE_KEY = 'urlCache.v1';
let urlCache = {};
try {
  urlCache = JSON.parse(localStorage.getItem(URL_CACHE_KEY)) || {};
  for (const k of Object.keys(urlCache)) {
    if (!urlCache[k] || urlCache[k].exp - Date.now() < 10 * 60 * 1000) delete urlCache[k];
  }
} catch (e) { urlCache = {}; }

function getCachedUrl(path) {
  const entry = urlCache[path];
  return entry ? entry.url : null;   // expired entries were pruned at load
}

function rememberUrl(path, url) {
  urlCache[path] = { url, exp: Date.now() + SIGNED_URL_TTL * 1000 };
}

function persistUrlCache() {
  try { localStorage.setItem(URL_CACHE_KEY, JSON.stringify(urlCache)); } catch (e) { /* best effort */ }
}

window.signedUrlFor = async (path) => {
  const hit = getCachedUrl(path);
  if (hit) return hit;
  const { data } = await sb.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL);
  if (!data) return null;
  rememberUrl(path, data.signedUrl);
  persistUrlCache();
  return data.signedUrl;
};

function rowToRec(store, row) {
  const rec = {
    id: row.id,
    kind: row.kind,
    caption: row.caption || '',
    storagePath: row.storage_path,
    contentType: row.content_type,
  };
  if (store === 'book') {
    rec.fit = row.fit || 'cover';
    rec.scale = Number(row.scale) || 1;
    rec.posX = Number(row.pos_x);
    rec.posY = Number(row.pos_y);
  } else {
    rec.x = Number(row.x);
    rec.y = Number(row.y);
    rec.w = Number(row.w);
    rec.rot = Number(row.rot);
    rec.z = Number(row.z);
  }
  return rec;
}

/* realtime echoes our own writes back to us — track them briefly so we don't
   re-render (and visually "reload") something we just did ourselves */
const locallyTouched = new Set();
function markLocalTouch(id) {
  locallyTouched.add(id);
  setTimeout(() => locallyTouched.delete(id), 4000);
}

/* every image also has a small companion at `<path>_thumb` — the wall and the
   room's frame show those, and book pages paint them first while the sharp
   full picture downloads behind */
async function attachUrls(recs) {
  const wants = [];   // { rec, key: 'url'|'thumbUrl', path }
  for (const rec of recs) {
    if (!rec.storagePath) continue;
    wants.push({ rec, key: 'url', path: rec.storagePath });
    if (rec.kind === 'image') wants.push({ rec, key: 'thumbUrl', path: rec.storagePath + '_thumb' });
  }
  const missing = [];
  for (const w of wants) {
    const hit = getCachedUrl(w.path);
    if (hit) w.rec[w.key] = hit;
    else if (!missing.includes(w.path)) missing.push(w.path);
  }
  if (!missing.length) return recs;
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(missing, SIGNED_URL_TTL);
  if (error) { toast('Could not load pictures — check your connection'); return recs; }
  const byPath = new Map();
  data.forEach((d, i) => { if (!d.error && d.signedUrl) byPath.set(d.path || missing[i], d.signedUrl); });
  for (const w of wants) {
    if (w.rec[w.key]) continue;
    const url = byPath.get(w.path);
    if (url) { w.rec[w.key] = url; rememberUrl(w.path, url); }
  }
  persistUrlCache();
  return recs;
}

async function cloudAdd(store, rec) {
  const blob = rec.blob;
  const path = store + '/' + crypto.randomUUID();
  const { error: upErr } = await sb.storage.from(BUCKET).upload(path, blob, {
    contentType: blob.type || 'application/octet-stream',
    cacheControl: '31536000',   // paths are UUIDs, content never changes — cache hard
  });
  if (upErr) throw upErr;

  if (rec.thumbBlob) {          // best effort — the full image still works without it
    await sb.storage.from(BUCKET).upload(path + '_thumb', rec.thumbBlob, {
      contentType: 'image/jpeg', cacheControl: '31536000',
    });
  }

  const payload = { kind: rec.kind, caption: rec.caption || '', storage_path: path, content_type: blob.type || null };
  if (store === 'book') {
    payload.fit = rec.fit || 'cover';
    payload.scale = rec.scale || 1;
    payload.pos_x = rec.posX ?? 50;
    payload.pos_y = rec.posY ?? 50;
  } else {
    payload.x = rec.x; payload.y = rec.y; payload.w = rec.w; payload.rot = rec.rot; payload.z = rec.z;
  }

  const { data, error } = await sb.from(store).insert(payload).select().single();
  if (error) { await sb.storage.from(BUCKET).remove([path]); throw error; }

  const saved = rowToRec(store, data);
  markLocalTouch(saved.id);
  await attachUrls([saved]);
  return saved;
}

async function cloudPut(store, rec) {
  markLocalTouch(rec.id);
  const patch = { caption: rec.caption };
  if (store === 'book') {
    patch.fit = rec.fit; patch.scale = rec.scale; patch.pos_x = rec.posX; patch.pos_y = rec.posY;
  } else {
    patch.x = rec.x; patch.y = rec.y; patch.w = rec.w; patch.rot = rec.rot; patch.z = rec.z;
  }
  const { error } = await sb.from(store).update(patch).eq('id', rec.id);
  if (error) toast('Could not save that change — check your connection');
}

async function cloudDelete(store, rec) {
  markLocalTouch(rec.id);
  await sb.from(store).delete().eq('id', rec.id);
  if (rec.storagePath) {
    const paths = [rec.storagePath];
    if (rec.kind === 'image') paths.push(rec.storagePath + '_thumb');
    await sb.storage.from(BUCKET).remove(paths);
  }
}

async function cloudAll(store) {
  const { data, error } = await sb.from(store).select('*').order('created_at', { ascending: true });
  if (error) { toast('Could not load — check your connection'); return []; }
  const recs = data.map((row) => rowToRec(store, row));
  await attachUrls(recs);
  return recs;
}

/* ===================== the 3D book ===================== */

const bookEl = $('#book');
let bookPhotos = [];      // { id, kind:'image'|'video', caption, fit, scale, posX, posY, storagePath, url }
let bookEditMode = false; // photos are view-only until "Edit book" is tapped
let sheetEls = [];
let flipCount = 0;
let animCounter = 0;
const animating = new Set();

function makeCaption(rec, store, cls, placeholder) {
  const cap = el('div', cls);
  cap.contentEditable = 'true';
  cap.dataset.placeholder = placeholder;
  cap.spellcheck = false;
  cap.textContent = rec.caption || '';
  cap.addEventListener('click', (e) => e.stopPropagation());
  cap.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); cap.blur(); } });
  cap.addEventListener('blur', () => {
    const text = cap.textContent.trim();
    if (text !== (rec.caption || '')) { rec.caption = text; cloudPut(store, rec); }
  });
  return cap;
}

function pageNode(def, side) {
  const p = el('div', 'page ' + side);

  if (def.type === 'cover') {
    p.classList.add('cover');
    p.innerHTML =
      '<div class="cover-inner">' +
      '<div class="cover-name">Tata &amp; Unif</div>' +
      '<div class="cover-heart">♥</div>' +
      '</div>';

  } else if (def.type === 'backcover') {
    p.classList.add('backcover');
    p.innerHTML = '<div class="backcover-inner"></div>';

  } else if (def.type === 'text') {
    p.classList.add('text-page');
    p.appendChild(el('div', 'page-text', def.html));

  } else if (def.type === 'video') {
    p.classList.add('photo-page');
    const video = def.photo;
    const frame = el('div', 'photo-frame video-frame');
    const vid = el('video');
    vid.dataset.src = video.url;    // fetched only once the reader flips near this page
    vid.controls = true;
    vid.playsInline = true;
    vid.preload = 'none';
    frame.appendChild(vid);

    const del = el('button', 'photo-del', '✕');
    del.title = 'Remove this video';
    del.addEventListener('click', (e) => { e.stopPropagation(); removeBookPhoto(video); });
    frame.appendChild(del);

    p.appendChild(frame);
    p.appendChild(makeCaption(video, 'book', 'page-caption', 'write a caption…'));

  } else {                                          // photo page
    p.classList.add('photo-page');
    const photo = def.photo;
    photo.fit = photo.fit || 'cover';
    photo.scale = photo.scale || 1;
    photo.posX = photo.posX ?? 50;
    photo.posY = photo.posY ?? 50;

    const frame = el('div', 'photo-frame');
    const img = el('img');
    img.dataset.src = photo.url;    // fetched only once the reader flips near this page
    if (photo.thumbUrl) img.dataset.thumb = photo.thumbUrl;
    img.decoding = 'async';
    img.alt = '';
    img.draggable = false;
    frame.appendChild(img);

    function applyImgStyle() {
      frame.classList.toggle('contain', photo.fit === 'contain');
      if (photo.fit === 'contain') {
        img.style.transform = '';
        img.style.objectPosition = '';
      } else {
        img.style.transformOrigin = photo.posX + '% ' + photo.posY + '%';
        img.style.objectPosition = photo.posX + '% ' + photo.posY + '%';
        img.style.transform = 'scale(' + photo.scale + ')';
      }
    }
    applyImgStyle();

    function setScale(s) {
      photo.scale = Math.max(1, Math.min(3, Math.round(s * 100) / 100));
      applyImgStyle();
      cloudPut('book', photo);
    }

    const ctrls = el('div', 'img-controls');
    const fitBtn = el('button', 'img-ctrl', photo.fit === 'contain' ? '⤢ Fill' : '⤡ Fit');
    fitBtn.title = 'Fill = crop to frame · Fit = show the whole image';
    fitBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      photo.fit = photo.fit === 'contain' ? 'cover' : 'contain';
      fitBtn.textContent = photo.fit === 'contain' ? '⤢ Fill' : '⤡ Fit';
      applyImgStyle();
      cloudPut('book', photo);
    });
    const zoomOut = el('button', 'img-ctrl', '−');
    zoomOut.title = 'Zoom out';
    zoomOut.addEventListener('click', (e) => { e.stopPropagation(); setScale(photo.scale - 0.2); });
    const zoomIn = el('button', 'img-ctrl', '+');
    zoomIn.title = 'Zoom in';
    zoomIn.addEventListener('click', (e) => { e.stopPropagation(); setScale(photo.scale + 0.2); });
    const resetBtn = el('button', 'img-ctrl', '⟳');
    resetBtn.title = 'Reset position & zoom';
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      photo.scale = 1; photo.posX = 50; photo.posY = 50;
      applyImgStyle();
      cloudPut('book', photo);
    });
    ctrls.append(fitBtn, zoomOut, zoomIn, resetBtn);
    frame.appendChild(ctrls);

    /* drag on the photo to reposition which part shows (only matters in Fill mode) */
    let moved = false;
    frame.addEventListener('pointerdown', (e) => {
      if (!bookEditMode || photo.fit === 'contain' || e.target.closest('.img-controls, .photo-del')) return;
      frame.setPointerCapture(e.pointerId);
      const r = frame.getBoundingClientRect();
      const sx = e.clientX, sy = e.clientY, ox = photo.posX, oy = photo.posY;
      moved = false;
      const move = (ev) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (!moved && Math.hypot(dx, dy) > 3) { moved = true; frame.classList.add('panning'); }
        if (!moved) return;
        photo.posX = Math.max(0, Math.min(100, ox - (dx / r.width) * 100 / photo.scale));
        photo.posY = Math.max(0, Math.min(100, oy - (dy / r.height) * 100 / photo.scale));
        applyImgStyle();
      };
      const up = () => {
        frame.removeEventListener('pointermove', move);
        frame.classList.remove('panning');
        if (moved) cloudPut('book', photo);
      };
      frame.addEventListener('pointermove', move);
      frame.addEventListener('pointerup', up, { once: true });
      frame.addEventListener('pointercancel', up, { once: true });
    });
    frame.addEventListener('click', (e) => { if (moved) { e.stopPropagation(); moved = false; } });
    frame.addEventListener('wheel', (e) => {
      if (!bookEditMode || photo.fit === 'contain') return;
      e.preventDefault();
      setScale(photo.scale - e.deltaY * 0.0015);
    }, { passive: false });

    const del = el('button', 'photo-del', '✕');
    del.title = 'Remove this photo';
    del.addEventListener('click', (e) => { e.stopPropagation(); removeBookPhoto(photo); });
    frame.appendChild(del);

    p.appendChild(frame);
    p.appendChild(makeCaption(photo, 'book', 'page-caption', 'write a caption…'));
  }
  return p;
}

function buildBook() {
  bookEl.innerHTML = '';

  const pages = [
    { type: 'cover' },
    { type: 'text', html: '' },
  ];
  if (bookPhotos.length === 0) {
    pages.push({ type: 'text', html: 'Our book is waiting<br>for its first memory…<br><br>tap <b>“+ Add photos &amp; videos”</b> below<br>and fill these pages with us ♥' });
  } else {
    for (const ph of bookPhotos) pages.push({ type: ph.kind === 'video' ? 'video' : 'photo', photo: ph });
  }
  if (pages.length % 2 === 0) {
    pages.push({ type: 'text', html: '' });
  }
  pages.push({ type: 'backcover' });

  const N = pages.length / 2;
  sheetEls = [];
  animating.clear();

  for (let i = 0; i < N; i++) {
    const sheet = el('div', 'sheet');
    sheet.appendChild(pageNode(pages[2 * i], 'front'));
    sheet.appendChild(pageNode(pages[2 * i + 1], 'back'));
    sheet.addEventListener('transitionend', (e) => {
      if (e.target !== sheet || e.propertyName !== 'transform') return;
      animating.delete(sheet);
      applyZ();
    });
    bookEl.appendChild(sheet);
    sheetEls.push(sheet);
  }

  flipCount = Math.max(0, Math.min(flipCount, N));
  applyFlips();
}

function applyZ() {
  const N = sheetEls.length;
  sheetEls.forEach((s, i) => {
    if (animating.has(s)) return;
    s.style.zIndex = String(s.classList.contains('flipped') ? i + 1 : N - i);
  });
}

/* the whole book used to download the moment you logged in — now each page
   only fetches its picture when the reader flips within a couple of sheets */
function loadSheetMedia(sheet) {
  sheet.querySelectorAll('img[data-src], video[data-src]').forEach((m) => {
    const full = m.dataset.src;
    const thumb = m.dataset.thumb;
    delete m.dataset.src;
    delete m.dataset.thumb;
    if (m.tagName === 'VIDEO') {
      m.preload = 'metadata';
      m.src = full;
    } else if (thumb) {
      // the small version paints almost instantly; the sharp one replaces it when ready
      m.src = thumb;
      const hi = new Image();
      hi.onload = () => { m.src = full; };
      hi.src = full;
    } else {
      m.src = full;
    }
  });
}

function loadNearSheets() {
  const from = Math.max(0, flipCount - 2);
  const to = Math.min(sheetEls.length - 1, flipCount + 1);
  for (let i = from; i <= to; i++) loadSheetMedia(sheetEls[i]);
}

function applyFlips() {
  const N = sheetEls.length;
  sheetEls.forEach((s, i) => s.classList.toggle('flipped', i < flipCount));
  bookEl.classList.toggle('closed', flipCount === 0);
  bookEl.classList.toggle('finished', N > 0 && flipCount === N);
  applyZ();
  loadNearSheets();
  $('#prevBtn').disabled = flipCount === 0;
  $('#nextBtn').disabled = flipCount === N;

  // mark the two pages actually facing the reader — edit controls only ever
  // appear on these, so a flipped-away page can't leave its buttons behind
  bookEl.querySelectorAll('.page.live').forEach((p) => p.classList.remove('live'));
  if (sheetEls[flipCount]) sheetEls[flipCount].children[0].classList.add('live');
  if (flipCount > 0) sheetEls[flipCount - 1].children[1].classList.add('live');
}

/* Keep a turning sheet above everything while it moves. */
function boost(sheet) {
  animating.add(sheet);
  sheet.style.zIndex = String(2 * sheetEls.length + (++animCounter));
  setTimeout(() => {
    if (animating.has(sheet)) { animating.delete(sheet); applyZ(); }
  }, 1500);
}

function flipNext() {
  if (flipCount >= sheetEls.length) return;
  boost(sheetEls[flipCount]);
  flipCount++;
  applyFlips();
}

function flipPrev() {
  if (flipCount <= 0) return;
  flipCount--;
  boost(sheetEls[flipCount]);
  applyFlips();
}

function flipTo(target) {
  target = Math.max(0, Math.min(target, sheetEls.length));
  if (target === flipCount) return;
  if (target > flipCount) for (let i = flipCount; i < target; i++) boost(sheetEls[i]);
  else for (let i = flipCount - 1; i >= target; i--) boost(sheetEls[i]);
  flipCount = target;
  applyFlips();
}

async function removeBookPhoto(photo) {
  const label = photo.kind === 'video' ? 'video' : 'photo';
  if (!confirm('Remove this ' + label + ' from our book?')) return;
  await cloudDelete('book', photo);
  bookPhotos = bookPhotos.filter((p) => p !== photo);
  buildBook();
  toast(label[0].toUpperCase() + label.slice(1) + ' removed');
}

const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // matches the storage bucket's per-file limit

async function addBookFiles(files) {
  const list = [...files].filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/'));
  if (!list.length) return;
  const firstNew = bookPhotos.length;
  let added = 0, tooBig = 0;
  toast(list.length === 1 ? 'Uploading…' : 'Uploading ' + list.length + '…');

  for (const f of list) {
    try {
      if (f.type.startsWith('video/')) {
        if (f.size > MAX_VIDEO_BYTES) { tooBig++; continue; }
        const rec = await cloudAdd('book', { kind: 'video', blob: f, caption: '' });
        bookPhotos.push(rec);
      } else {
        const blob = await shrink(f);
        const thumbBlob = await shrink(f, 800, 0.78);
        const rec = await cloudAdd('book', { kind: 'image', blob, thumbBlob, caption: '', fit: 'cover', scale: 1, posX: 50, posY: 50 });
        bookPhotos.push(rec);
      }
      added++;
    } catch (e) {
      toast('Couldn’t add “' + f.name + '” — check your connection and try again');
    }
  }
  if (tooBig) toast(tooBig === 1 ? 'A video was over 100MB, so it was skipped' : tooBig + ' videos were over 100MB, so they were skipped');
  if (!added) return;

  buildBook();
  // flip to the first newly added item (cover=page 0, dedication=page 1, memories start at page 2)
  const pageIdx = 2 + firstNew;
  requestAnimationFrame(() => flipTo(Math.ceil(pageIdx / 2)));
  toast(added === 1 ? 'Added 1 memory to our book ♥' : 'Added ' + added + ' memories to our book ♥');
}

/* click left half = back, right half = forward.
   the photo itself is excluded — tapping a photo used to flip the page out from
   under you on phones, right when you were reaching for its edit buttons */
let lastSwipeAt = 0;
$('#scene').addEventListener('click', (e) => {
  if (e.target.closest('.page-caption, .photo-del, .img-controls, .photo-frame, video')) return;
  if (Date.now() - lastSwipeAt < 400) return;
  const r = bookEl.getBoundingClientRect();
  if (e.clientX >= r.left + r.width / 2) flipNext();
  else flipPrev();
});

/* swipe left/right anywhere outside a photo to flip — the natural phone gesture */
let swipeStart = null;
$('#scene').addEventListener('pointerdown', (e) => {
  if (e.target.closest('.photo-frame, .page-caption, button, video')) return;
  swipeStart = { x: e.clientX, y: e.clientY };
});
$('#scene').addEventListener('pointerup', (e) => {
  if (!swipeStart) return;
  const dx = e.clientX - swipeStart.x;
  const dy = e.clientY - swipeStart.y;
  swipeStart = null;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    lastSwipeAt = Date.now();
    if (dx < 0) flipNext();
    else flipPrev();
  }
});

document.addEventListener('keydown', (e) => {
  if (!$('#view-book').classList.contains('active')) return;
  if (document.activeElement && document.activeElement.isContentEditable) return;
  if (e.key === 'ArrowRight') flipNext();
  else if (e.key === 'ArrowLeft') flipPrev();
});

$('#nextBtn').addEventListener('click', flipNext);
$('#prevBtn').addEventListener('click', flipPrev);

$('#bookModeBtn').addEventListener('click', () => {
  bookEditMode = !bookEditMode;
  $('#view-book').classList.toggle('editing', bookEditMode);
  $('#bookModeBtn').textContent = bookEditMode ? '✓ Done' : '✏️ Edit book';
});

/* ===================== the wall ===================== */

const board = $('#board');
const boardCanvas = $('#boardCanvas');
let boardItems = [];      // { id, kind:'image'|'video', caption, x, y, w, rot, z, storagePath, url }
let boardMaxZ = 10;
const boardItemEls = new Map();  // rec.id -> DOM element, for layout math (e.g. sorting)
const CANVAS_PAD = 260;   // always leave this much open canvas below the lowest item
let boardEditMode = false;       // starts locked — browsing can't accidentally rearrange the wall
let boardZoom = 1;

function applyBoardMode() {
  board.classList.toggle('view-mode', !boardEditMode);
  document.querySelector('.board-bar').classList.toggle('editing', boardEditMode);
  $('#boardModeBtn').textContent = boardEditMode ? '✓ Done' : '✏️ Edit wall';
}

function applyBoardZoom() {
  boardZoom = Math.min(1.6, Math.max(0.4, boardZoom));
  boardCanvas.style.transform = 'scale(' + boardZoom + ')';
  boardCanvas.style.minWidth = (100 / boardZoom) + '%';
  boardCanvas.style.minHeight = (100 / boardZoom) + '%';
}

function updateEmpty() {
  $('#boardEmpty').style.display = boardItems.length ? 'none' : '';
}

/* how far down/right the pinned items currently reach */
function measureContentBounds() {
  let bottom = 0, right = 0;
  boardCanvas.querySelectorAll('.polaroid').forEach((it) => {
    bottom = Math.max(bottom, it.offsetTop + it.offsetHeight);
    right = Math.max(right, it.offsetLeft + it.offsetWidth);
  });
  return { bottom, right };
}
function measureLowestBottom() { return measureContentBounds().bottom; }

/* grow the canvas (never shrink) so there's always room to drop/drag things further out.
   pass either argument as null/omit to leave that dimension alone. */
function growCanvasTo(minH, minW) {
  if (!board.offsetParent) return;   // wall isn't visible right now (e.g. still on the book tab) — nothing to measure
  if (minH != null && minH > boardCanvas.offsetHeight) boardCanvas.style.height = minH + 'px';
  if (minW != null && minW > boardCanvas.offsetWidth) boardCanvas.style.width = minW + 'px';
}

function refreshCanvasSize() {
  const b = measureContentBounds();
  growCanvasTo(
    Math.max(board.clientHeight / boardZoom, b.bottom + CANVAS_PAD),
    Math.max(board.clientWidth / boardZoom, b.right + CANVAS_PAD)
  );
}

function makeBoardItem(rec) {
  const item = el('div', 'polaroid' + (rec.kind === 'video' ? ' polaroid-video' : ''));
  item.style.left = rec.x + 'px';
  item.style.top = rec.y + 'px';
  item.style.width = rec.w + 'px';
  item.style.zIndex = String(rec.z || 1);
  item.style.setProperty('--rot', (rec.rot || 0) + 'deg');

  let media;
  if (rec.kind === 'video') {
    media = el('video');
    media.src = rec.url;
    media.controls = true;
    media.playsInline = true;
    media.preload = 'metadata';
    media.addEventListener('loadedmetadata', () => growCanvasTo(rec.y + item.offsetHeight + CANVAS_PAD, rec.x + item.offsetWidth + CANVAS_PAD));
  } else {
    media = el('img');
    media.loading = 'lazy';         // pictures far down the wall wait until scrolled near
    media.decoding = 'async';
    media.src = rec.thumbUrl || rec.url;   // polaroids are small — the thumb is plenty
    media.alt = '';
    media.draggable = false;
  }
  item.appendChild(media);

  item.appendChild(makeCaption(rec, 'board', 'polaroid-caption', 'write something…'));

  const del = el('button', 'p-del', '✕');
  del.title = 'Remove this ' + (rec.kind === 'video' ? 'video' : 'picture');
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('Take this ' + (rec.kind === 'video' ? 'video' : 'picture') + ' off our wall?')) return;
    await cloudDelete('board', rec);
    boardItems = boardItems.filter((r) => r !== rec);
    boardItemEls.delete(rec.id);
    item.remove();
    updateEmpty();
  });
  const rot = el('div', 'p-rotate', '⟲');
  rot.title = 'Spin';
  const rez = el('div', 'p-resize');
  rez.title = 'Resize';
  item.append(del, rot, rez);

  /* drag to move */
  item.addEventListener('pointerdown', (e) => {
    if (!boardEditMode) return;   // view mode: fingers scroll the wall instead
    if (e.target.closest('.p-del, .p-rotate, .p-resize, .polaroid-caption, video')) return;
    e.preventDefault();
    rec.z = ++boardMaxZ;
    item.style.zIndex = String(rec.z);
    item.classList.add('lifted');
    const sx = e.clientX, sy = e.clientY, ox = rec.x, oy = rec.y;
    item.setPointerCapture(e.pointerId);
    const move = (ev) => {
      rec.x = Math.max(4, ox + (ev.clientX - sx) / boardZoom);
      rec.y = Math.max(4, oy + (ev.clientY - sy) / boardZoom);
      item.style.left = rec.x + 'px';
      item.style.top = rec.y + 'px';
      growCanvasTo(rec.y + item.offsetHeight + CANVAS_PAD, rec.x + item.offsetWidth + CANVAS_PAD);
    };
    const up = () => {
      item.removeEventListener('pointermove', move);
      item.classList.remove('lifted');
      cloudPut('board', rec);
      refreshCanvasSize();
    };
    item.addEventListener('pointermove', move);
    item.addEventListener('pointerup', up, { once: true });
    item.addEventListener('pointercancel', up, { once: true });
  });

  /* corner dot: resize (based on distance from the middle, so it works while rotated) */
  rez.addEventListener('pointerdown', (e) => {
    if (!boardEditMode) return;
    e.preventDefault();
    e.stopPropagation();
    rez.setPointerCapture(e.pointerId);
    const r = item.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const d0 = Math.max(20, Math.hypot(e.clientX - cx, e.clientY - cy));
    const w0 = rec.w;
    const move = (ev) => {
      const d = Math.hypot(ev.clientX - cx, ev.clientY - cy);
      rec.w = Math.round(Math.min(640, Math.max(110, (w0 * d) / d0)));
      item.style.width = rec.w + 'px';
      growCanvasTo(rec.y + item.offsetHeight + CANVAS_PAD, rec.x + item.offsetWidth + CANVAS_PAD);
    };
    const up = () => { rez.removeEventListener('pointermove', move); cloudPut('board', rec); refreshCanvasSize(); };
    rez.addEventListener('pointermove', move);
    rez.addEventListener('pointerup', up, { once: true });
    rez.addEventListener('pointercancel', up, { once: true });
  });

  /* top handle: rotate around the middle */
  rot.addEventListener('pointerdown', (e) => {
    if (!boardEditMode) return;
    e.preventDefault();
    e.stopPropagation();
    rot.setPointerCapture(e.pointerId);
    const r = item.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const move = (ev) => {
      let a = (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI + 90;
      if (a > 180) a -= 360;
      if (Math.abs(a) < 4) a = 0;            // gentle snap to straight
      rec.rot = Math.round(a);
      item.style.setProperty('--rot', rec.rot + 'deg');
    };
    const up = () => { rot.removeEventListener('pointermove', move); cloudPut('board', rec); };
    rot.addEventListener('pointermove', move);
    rot.addEventListener('pointerup', up, { once: true });
    rot.addEventListener('pointercancel', up, { once: true });
  });

  boardCanvas.appendChild(item);
  boardItemEls.set(rec.id, item);
  return item;
}

/* tidy every picture into a neat top-to-bottom, left-to-right flow, no more overlaps */
function sortBoard() {
  if (!boardItems.length) return;
  const gap = 22;
  const bw = board.clientWidth / boardZoom;
  let x = gap, y = gap, rowH = 0;

  for (const rec of boardItems) {
    const item = boardItemEls.get(rec.id);
    if (!item) continue;
    if (x > gap && x + rec.w + gap > bw) {
      x = gap;
      y += rowH + gap;
      rowH = 0;
    }
    rec.x = x;
    rec.y = y;
    rec.rot = 0;
    item.style.left = x + 'px';
    item.style.top = y + 'px';
    item.style.setProperty('--rot', '0deg');
    cloudPut('board', rec);
    x += rec.w + gap;
    rowH = Math.max(rowH, item.offsetHeight);
  }

  // tidying wraps everything back within view width and shrinks the used height to fit —
  // unlike normal edits, let the canvas shrink back down instead of only ever growing
  boardCanvas.style.width = '';
  boardCanvas.style.height = Math.max(board.clientHeight, y + rowH + CANVAS_PAD) + 'px';
  board.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
  toast('Tidied up ♥');
}

async function addBoardFiles(files) {
  const list = [...files].filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/'));
  if (!list.length) return;
  const bw = board.clientWidth / boardZoom;
  let cursorY = boardItems.length ? measureLowestBottom() + 24 : 24;
  let added = 0, tooBig = 0;
  toast(list.length === 1 ? 'Uploading…' : 'Uploading ' + list.length + '…');

  for (const f of list) {
    const isVideo = f.type.startsWith('video/');
    if (isVideo && f.size > MAX_VIDEO_BYTES) { tooBig++; continue; }
    try {
      const w = Math.round(180 + Math.random() * 90);
      const blob = isVideo ? f : await shrink(f, 1200, 0.85);
      const thumbBlob = isVideo ? null : await shrink(f, 520, 0.78);
      const rec = await cloudAdd('board', {
        kind: isVideo ? 'video' : 'image',
        blob,
        thumbBlob,
        caption: '',
        x: Math.round(24 + Math.random() * Math.max(1, bw - w - 60)),
        y: Math.round(cursorY + Math.random() * 40),
        w,
        rot: Math.round(-8 + Math.random() * 16),
        z: ++boardMaxZ,
      });
      boardItems.push(rec);
      makeBoardItem(rec);
      cursorY += Math.round(w * (isVideo ? 0.85 : 1.15)) + 30;
      added++;
    } catch (e) {
      toast('Couldn’t add “' + f.name + '” — check your connection and try again');
    }
  }
  if (tooBig) toast(tooBig === 1 ? 'A video was over 100MB, so it was skipped' : tooBig + ' videos were over 100MB, so they were skipped');
  if (added) {
    updateEmpty();
    refreshCanvasSize();
    requestAnimationFrame(() => board.scrollTo({ top: boardCanvas.offsetHeight, behavior: 'smooth' }));
    toast(added === 1 ? '1 memory pinned to our wall ♥' : added + ' memories pinned to our wall ♥');
  }
}

/* ===================== drag & drop files ===================== */

function makeDropZone(zone, handler) {
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drop'); });
  zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('drop'); });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drop');
    if (e.dataTransfer.files.length) handler(e.dataTransfer.files);
  });
}
makeDropZone($('#view-book'), addBookFiles);
makeDropZone(board, addBoardFiles);

/* ===================== nav / intro / hearts ===================== */

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    $('#view-' + btn.dataset.view).classList.add('active');
    // the wall was likely hidden (display:none, zero size) when it first loaded its data,
    // so its canvas size needs recomputing now that it actually has real layout dimensions
    if (btn.dataset.view === 'board') refreshCanvasSize();
  });
});

$('#introOpen').addEventListener('click', () => $('#intro').classList.add('hidden'));

const heartsBox = $('#hearts');
setInterval(() => {
  if (document.hidden || heartsBox.childElementCount > 16) return;
  const h = el('span', 'fheart', '♥');
  h.style.left = Math.random() * 100 + 'vw';
  h.style.fontSize = 10 + Math.random() * 18 + 'px';
  h.style.animationDuration = 7 + Math.random() * 7 + 's';
  h.style.setProperty('--o', (0.2 + Math.random() * 0.35).toFixed(2));
  heartsBox.appendChild(h);
  h.addEventListener('animationend', () => h.remove());
}, 900);

/* ===================== add-photo buttons ===================== */

$('#addBookPhotos').addEventListener('click', () => $('#bookFile').click());
$('#bookFile').addEventListener('change', (e) => { addBookFiles(e.target.files); e.target.value = ''; });
$('#addBoardPhotos').addEventListener('click', () => $('#boardFile').click());
$('#boardFile').addEventListener('change', (e) => { addBoardFiles(e.target.files); e.target.value = ''; });
$('#sortBoard').addEventListener('click', sortBoard);

/* ===================== wall mode & zoom ===================== */

$('#boardModeBtn').addEventListener('click', () => {
  boardEditMode = !boardEditMode;
  applyBoardMode();
});
$('#zoomInBoard').addEventListener('click', () => { boardZoom += 0.2; applyBoardZoom(); refreshCanvasSize(); });
$('#zoomOutBoard').addEventListener('click', () => { boardZoom -= 0.2; applyBoardZoom(); refreshCanvasSize(); });
applyBoardMode();

/* pinch to zoom on touch screens */
let pinchDist = 0, pinchZoom0 = 1;
board.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    pinchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    pinchZoom0 = boardZoom;
  }
}, { passive: true });
board.addEventListener('touchmove', (e) => {
  if (e.touches.length === 2 && pinchDist > 0) {
    e.preventDefault();
    const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    boardZoom = pinchZoom0 * (d / pinchDist);
    applyBoardZoom();
  }
}, { passive: false });
board.addEventListener('touchend', () => {
  if (pinchDist > 0) { pinchDist = 0; refreshCanvasSize(); }
}, { passive: true });

/* ===================== loading + live sync ===================== */

async function loadBook() {
  bookPhotos = await cloudAll('book');
  buildBook();
}

async function loadBoard() {
  const recs = await cloudAll('board');
  boardCanvas.querySelectorAll('.polaroid').forEach((n) => n.remove());
  boardItems = [];
  boardItemEls.clear();
  boardMaxZ = 10;
  for (const rec of recs) {
    rec.x = Math.max(4, rec.x);       // the wall now scrolls sideways, so no need to squeeze items into view
    rec.y = Math.max(4, rec.y);
    boardMaxZ = Math.max(boardMaxZ, rec.z || 0);
    boardItems.push(rec);
    makeBoardItem(rec);
  }
  updateEmpty();
  refreshCanvasSize();
}

/* apply one wall change in place — no full rebuild, so an in-progress drag
   elsewhere on the board is never disturbed */
async function applyBoardChange(payload) {
  if (payload.eventType === 'DELETE') {
    const id = payload.old.id;
    const item = boardItemEls.get(id);
    if (item) item.remove();
    boardItemEls.delete(id);
    boardItems = boardItems.filter((r) => r.id !== id);
    updateEmpty();
    return;
  }

  const row = payload.new;
  const existing = boardItems.find((r) => r.id === row.id);

  if (existing) {
    existing.caption = row.caption || '';
    existing.x = Number(row.x);
    existing.y = Number(row.y);
    existing.w = Number(row.w);
    existing.rot = Number(row.rot);
    existing.z = Number(row.z);
    boardMaxZ = Math.max(boardMaxZ, existing.z);

    const item = boardItemEls.get(row.id);
    if (item) {
      item.style.left = existing.x + 'px';
      item.style.top = existing.y + 'px';
      item.style.width = existing.w + 'px';
      item.style.zIndex = String(existing.z);
      item.style.setProperty('--rot', existing.rot + 'deg');
      const capEl = item.querySelector('.polaroid-caption');
      if (capEl && document.activeElement !== capEl) capEl.textContent = existing.caption;
    }
    refreshCanvasSize();
  } else {
    const rec = rowToRec('board', row);
    await attachUrls([rec]);
    boardMaxZ = Math.max(boardMaxZ, rec.z || 0);
    boardItems.push(rec);
    makeBoardItem(rec);
    updateEmpty();
    refreshCanvasSize();
  }
}

/* keep both devices in sync — any change either of you make reaches the other's view.
   changes we just made ourselves are skipped so nothing visibly "reloads" underneath you */
function setupRealtime() {
  let bookTimer;
  sb.channel('book-sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'book' }, (payload) => {
      const id = payload.new?.id || payload.old?.id;
      if (id && locallyTouched.has(id)) return;
      clearTimeout(bookTimer);
      bookTimer = setTimeout(loadBook, 600);
    })
    .subscribe();
  sb.channel('board-sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'board' }, (payload) => {
      const id = payload.new?.id || payload.old?.id;
      if (id && locallyTouched.has(id)) return;
      applyBoardChange(payload);
    })
    .subscribe();
}

async function boot() {
  await Promise.all([loadBook(), loadBoard()]);
  setupRealtime();
}

/* ===================== passcode gate ===================== */

function hideGate() {
  $('#gate').classList.add('hidden');
}

$('#gateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pass = $('#gatePass').value;
  const btn = $('#gateSubmit');
  const err = $('#gateError');
  btn.disabled = true;
  err.classList.remove('show');
  const { error } = await sb.auth.signInWithPassword({ email: SHARED_EMAIL, password: pass });
  btn.disabled = false;
  if (error) {
    err.textContent = 'wrong passcode — try again';
    err.classList.add('show');
    $('#gatePass').value = '';
    $('#gatePass').focus();
    return;
  }
  hideGate();
  boot();
});

(async () => {
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    hideGate();
    boot();
  } else {
    $('#gatePass').focus();
  }
})();
