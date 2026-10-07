// Офлайн-кэш приложения. При изменении файлов увеличьте версию.
const CACHE = 'tgt-team-v2';
const ASSETS = [
  './', 'index.html', 'styles.css', 'app.js', 'store.js', 'util.js', 'excel.js', 'firebase-config.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/firebase/firebase-app.js', 'vendor/firebase/firebase-auth.js', 'vendor/firebase/firebase-firestore.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Сначала сеть (чтобы получать обновления), при отсутствии сети — кэш.
// Запросы к Firebase (база, вход) не трогаем — только файлы самого приложения.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
