/* HSC Hub service worker.
 *
 * TO SHIP AN UPDATE: change files, then bump VERSION below. Installed copies fetch everything fresh, show an
 * "Update available" prompt, and the old cache is deleted when the new version takes over.
 *
 * TO RECONNECT A SUBJECT: set its path in LINK in index.html. The Hub itself tells this worker to cache every
 * connected subject, so offline works automatically. Listing it in SUBJECT_FILES as well makes it download on
 * install, so it is ready the very first time, not just after the first visit.
 */
const VERSION = 'v94';
const CORE_CACHE = 'hsc-hub-core-' + VERSION;   // versioned: replaced on every update
const FONT_CACHE = 'hsc-hub-fonts-v1';          // Google font files: kept across updates, they never change
const KEEP = [CORE_CACHE, FONT_CACHE];

const CORE_FILES = [
  './', 'index.html',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'icon-180.png'
];
/* Subject modules shipped as separate files (files that do not exist are skipped quietly). All five subjects are built into index.html now, so there are none. */
const SUBJECT_FILES = [];

const abs = p => new URL(p, self.registration.scope).href;

/* add each file on its own so one missing file never blocks the install */
const addAll = (cache, files) => Promise.all(files.map(f =>
  fetch(abs(f), { cache: 'reload' })
    .then(r => { if (r && r.ok) return cache.put(abs(f), r); })
    .catch(() => {})));

/* Font Awesome (Business Studies icons): download the stylesheet and the font files it names, so icons work offline */
const FA_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css';
async function prefetchIcons() {
  try {
    const cache = await caches.open(FONT_CACHE);
    const res = await fetch(FA_CSS, { mode: 'cors' });
    if (!res || !res.ok) return;
    const css = await res.clone().text();
    await cache.put(FA_CSS, res);
    const urls = [...new Set([...css.matchAll(/url\(([^)]+)\)/g)].map(m => m[1].trim().replace(/^["']|["']$/g, ''))
      .filter(u => /\.woff2/.test(u)).map(u => new URL(u, FA_CSS).href))];
    await Promise.all(urls.map(u => fetch(u, { mode: 'cors' }).then(r => { if (r && r.ok) return cache.put(u, r); }).catch(() => {})));
  } catch (err) {}
}

self.addEventListener('install', e => {
  /* no skipWaiting here: the page decides when to switch, so an update never lands in the middle of an exam */
  e.waitUntil(Promise.all([caches.open(CORE_CACHE).then(c => addAll(c, CORE_FILES.concat(SUBJECT_FILES))), prefetchIcons()]));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('hsc-hub-') && !KEEP.includes(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener('message', e => {
  const m = e.data || {};
  if (m.type === 'SKIP_WAITING') { self.skipWaiting(); return; }
  if (Array.isArray(m.cache)) {   // the Hub lists its connected subjects and stylesheet
    e.waitUntil(Promise.all([caches.open(CORE_CACHE), caches.open(FONT_CACHE)]).then(([core, fonts]) =>
      Promise.all(m.cache.map(u => {
        const own = new URL(u, self.location.href).origin === self.location.origin;
        return fetch(u).then(r => { if (r && (r.ok || r.type === 'opaque')) return (own ? core : fonts).put(u, r); }).catch(() => {});
      }))));
  }
});

/* same-origin files: network first (always fresh when online), 4s patience, then the saved copy */
async function networkFirst(req, e) {
  const cache = await caches.open(CORE_CACHE);
  const saved = async () => (await cache.match(req, { ignoreSearch: true })) ||
    (req.mode === 'navigate'
      ? (await cache.match(abs('./'))) || (await cache.match(abs('index.html')))
      : undefined);
  try {
    const res = await Promise.race([fetch(req, { cache: 'no-cache' }), new Promise((_, no) => setTimeout(() => no(new Error('slow')), 4000))]);
    if (res.ok) { e.waitUntil(cache.put(req, res.clone()).catch(() => {})); return res; }
    return (await saved()) || res;
  } catch (err) {
    return (await saved()) || Response.error();
  }
}

/* Google fonts: saved copy first, refreshed in the background */
const staleWhileRevalidate = (req, e) => caches.open(FONT_CACHE).then(c =>
  c.match(req).then(hit => {
    const net = fetch(req).then(res => { if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone()); return res; }).catch(() => hit);
    if (hit) { e.waitUntil(net); return hit; }
    return net;
  }));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (req.headers.has('range')) return;
    e.respondWith(networkFirst(req, e));
  } else if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com' || url.hostname === 'cdnjs.cloudflare.com') {
    e.respondWith(staleWhileRevalidate(req, e));
  }
});
