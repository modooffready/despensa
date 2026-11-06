/* Service worker: guarda la app en el móvil para que abra sin conexión.
 * Estrategia: con red, siempre la versión nueva (espera máx. 3 s); sin red, la guardada.
 * Si cambias archivos, cambia VERSION aquí y en index.html (app.js?v=...). */
const VERSION = '2.7.0';
const CACHE = 'despensa-v' + VERSION;
const ARCHIVOS = ['./', './index.html', './app.js?v=' + VERSION, './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // cache: 'reload' → ignora la caché del navegador y baja los archivos de verdad
      return Promise.all(ARCHIVOS.map(function (u) {
        return fetch(new Request(u, { cache: 'reload' })).then(function (r) {
          if (!r.ok) throw new Error(u + ' ' + r.status);
          return c.put(u, r);
        });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (ks) {
      return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function conLimite(promesa, ms) {
  return new Promise(function (res, rej) {
    const t = setTimeout(function () { rej(new Error('timeout')); }, ms);
    promesa.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); });
  });
}

// Solo archivos de la propia app. Las llamadas a Google no pasan por aquí.
self.addEventListener('fetch', function (e) {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  const esPagina = req.mode === 'navigate';
  e.respondWith(
    caches.open(CACHE).then(function (cache) {
      return conLimite(fetch(req, { cache: 'no-cache' }), 3000).then(function (resp) {
        if (resp && resp.ok) cache.put(esPagina ? './index.html' : req, resp.clone());
        return resp;
      }).catch(function () {
        return cache.match(esPagina ? './index.html' : req).then(function (r) {
          return r || cache.match(req, { ignoreSearch: true });
        });
      });
    })
  );
});
