/* Service worker: guarda la app en el móvil para que abra sin conexión.
 * Si cambias algún archivo, sube también este con el número de versión aumentado. */
const CACHE = 'despensa-v1.3.0';
const ARCHIVOS = ['./', './index.html', './app.js', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ARCHIVOS); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (ks) {
      return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

// Solo archivos de la propia app. Las llamadas a Google no pasan por aquí.
self.addEventListener('fetch', function (e) {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(e.request, { ignoreSearch: true }).then(function (guardado) {
        const red = fetch(e.request).then(function (resp) {
          if (resp && resp.ok) cache.put(e.request, resp.clone());
          return resp;
        }).catch(function () { return guardado || cache.match('./index.html'); });
        return guardado || red; // primero lo guardado (rápido y offline); se actualiza en segundo plano
      });
    })
  );
});
