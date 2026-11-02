'use strict';
/* =========================================================
 * DESPENSA — app del móvil (Fase 1.2)
 * Escanear → guardar sin conexión → sincronizar con la Sheet
 * ========================================================= */

const VERSION = '1.3.1';
const ALMACENES = ['Trastero Ávila', 'Sotalbo'];
const ESTANTES = ['1', '2', '3', '4', '5', '6'];
const FORMATOS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'];
const MAX_HISTORIAL = 200;

/* ---------- Base de datos local (IndexedDB) ---------- */
let dbPromesa;
function abrirDB() {
  if (!dbPromesa) {
    dbPromesa = new Promise(function (res, rej) {
      const r = indexedDB.open('despensa', 1);
      r.onupgradeneeded = function () {
        const d = r.result;
        if (!d.objectStoreNames.contains('pendientes')) d.createObjectStore('pendientes', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('historial')) d.createObjectStore('historial', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  return dbPromesa;
}
async function operacion(almacen, modo, fn) {
  const d = await abrirDB();
  return new Promise(function (res, rej) {
    const t = d.transaction(almacen, modo);
    const req = fn(t.objectStore(almacen));
    let resultado;
    if (req) req.onsuccess = function () { resultado = req.result; };
    t.oncomplete = function () { res(resultado); };
    t.onerror = function () { rej(t.error); };
    t.onabort = function () { rej(t.error); };
  });
}
const idb = {
  get: function (a, k) { return operacion(a, 'readonly', function (s) { return s.get(k); }); },
  todos: function (a) { return operacion(a, 'readonly', function (s) { return s.getAll(); }); },
  poner: function (a, v, k) { return operacion(a, 'readwrite', function (s) { return k === undefined ? s.put(v) : s.put(v, k); }); },
  borrar: function (a, k) { return operacion(a, 'readwrite', function (s) { return s.delete(k); }); }
};

/* ---------- Estado ---------- */
let config = {};
let catalogo = {};      // codigo -> producto
let stockServidor = []; // [{codigo, caducidad, almacen, estante, stock}]
let sincronizando = false;
let ultimoError = '';
let actual = null;      // producto en el formulario
let tipoActual = 'ENTRADA';
let cadAnio = '', cadMes = '';  // caducidad elegida en el formulario
const ultimaCad = {};            // última caducidad usada por código (para la ráfaga)

const $ = function (id) { return document.getElementById(id); };
function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

let toastTimer;
function toast(msg, ms) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('oculto');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.add('oculto'); }, ms || 2500);
}

function mostrar(nombre) {
  ['inicio', 'escaner', 'formulario', 'ajustes', 'stock'].forEach(function (p) {
    $('pantalla-' + p).classList.toggle('oculto', p !== nombre);
  });
  if (nombre !== 'escaner') pararEscaner();
  window.scrollTo(0, 0);
}

async function guardarConfig() { await idb.poner('kv', config, 'config'); }

/* ---------- Arranque ---------- */
async function iniciar() {
  config = (await idb.get('kv', 'config')) || {};
  catalogo = (await idb.get('kv', 'catalogo')) || {};
  stockServidor = (await idb.get('kv', 'stock')) || [];

  // Pedir al navegador que no borre los datos locales
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn(e); });

  montarSelects();
  enlazarEventos();
  $('a-version').textContent = VERSION;

  if (!config.url || !config.token || !config.usuario) abrirAjustes();
  else mostrar('inicio');

  await refrescarEstado();
  await pintarHistorial();
  sincronizar(false);

  window.addEventListener('online', function () { refrescarEstado(); sincronizar(false); });
  window.addEventListener('offline', refrescarEstado);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') sincronizar(false);
  });
  setInterval(function () { sincronizar(false); }, 120000);
}

function opciones(select, lista, vacia) {
  select.innerHTML = (vacia ? '<option value="">' + esc(vacia) + '</option>' : '') +
    lista.map(function (o) {
      const v = typeof o === 'object' ? o.v : o, t = typeof o === 'object' ? o.t : o;
      return '<option value="' + esc(v) + '">' + esc(t) + '</option>';
    }).join('');
}

function montarSelects() {
  montarCaducidad();
  opciones($('f-almacen'), ALMACENES);
  opciones($('f-estante'), ESTANTES.map(function (e) { return { v: e, t: 'Estante ' + e }; }));
  opciones($('a-almacen'), ALMACENES);
}

function enlazarEventos() {
  $('btn-ajustes').onclick = abrirAjustes;
  $('btn-sincronizar').onclick = function () { sincronizar(true); };
  $('btn-escanear').onclick = abrirEscaner;
  $('btn-stock').onclick = abrirStock;
  $('s-buscar').oninput = pintarStock;
  $('s-volver').onclick = function () { mostrar('inicio'); };
  $('btn-codigo-manual').onclick = function () {
    const c = $('codigo-manual').value.trim();
    if (!c) { toast('Escribe un código'); return; }
    $('codigo-manual').value = '';
    abrirFormulario(c);
  };
  $('btn-cancelar-escaner').onclick = function () { mostrar('inicio'); };
  $('btn-linterna').onclick = alternarLinterna;

  $('f-entrada').onclick = function () { cambiarTipo('ENTRADA'); };
  $('f-salida').onclick = function () { cambiarTipo('SALIDA'); };
  $('f-menos').onclick = function () { cambiarCantidad(-1); };
  $('f-mas').onclick = function () { cambiarCantidad(1); };
  $('f-guardar').onclick = function () { guardarMovimiento(false); };
  $('f-guardar-seguir').onclick = function () { guardarMovimiento(true); };
  $('f-cancelar').onclick = function () { mostrar('inicio'); };

  $('a-guardar').onclick = guardarAjustes;
  $('a-probar').onclick = probarConexion;
  $('a-volver').onclick = function () {
    if (!config.url || !config.token || !config.usuario) { toast('Rellena y guarda los ajustes primero'); return; }
    mostrar('inicio');
  };
}

/* ---------- Estado e historial ---------- */
async function refrescarEstado() {
  const online = navigator.onLine;
  $('punto-red').className = 'punto ' + (online ? 'on' : 'off');
  $('txt-red').textContent = sincronizando ? 'Sincronizando…' : (online ? 'Con conexión' : 'Sin conexión');
  const pend = await idb.todos('pendientes');
  $('txt-pendientes').textContent = pend.length;
  $('txt-sync').textContent = config.ultimaSync
    ? 'Última sincronización: ' + new Date(config.ultimaSync).toLocaleString('es-ES')
    : 'Nunca sincronizado';
  $('txt-error').textContent = ultimoError ? 'Último error: ' + ultimoError : '';
}

async function pintarHistorial() {
  let h = await idb.todos('historial');
  h.sort(function (a, b) { return b.fecha.localeCompare(a.fecha); });
  if (h.length > MAX_HISTORIAL) {
    for (const viejo of h.slice(MAX_HISTORIAL)) await idb.borrar('historial', viejo.id);
    h = h.slice(0, MAX_HISTORIAL);
  }
  const lista = $('lista-historial');
  if (!h.length) { lista.innerHTML = '<li class="muted">Todavía no hay movimientos</li>'; return; }
  lista.innerHTML = h.slice(0, 25).map(function (m) {
    const icono = m.estado === 'ok' ? '✅' : (m.estado === 'pendiente' ? '⏳' : '⚠️');
    const nombre = m.nombre || (catalogo[m.codigo] && catalogo[m.codigo].nombre) || m.codigo;
    return '<li><div><span class="tag ' + esc(m.tipo) + '">' + esc(m.tipo) + '</span> ' +
      esc(m.cantidad) + ' × ' + esc(nombre) +
      '<div class="meta">' + esc(m.caducidad || 'sin cad.') + ' · ' + esc(m.almacen) + ' · est. ' + esc(m.estante) +
      ' · ' + new Date(m.fecha).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) +
      (m.estado !== 'ok' && m.estado !== 'pendiente' ? '<br><span class="error">' + esc(m.estado) + '</span>' : '') +
      '</div></div><div title="' + esc(m.estado) + '">' + icono + '</div></li>';
  }).join('');
}

async function marcarHistorial(id, estado) {
  const m = await idb.get('historial', id);
  if (m) { m.estado = estado; await idb.poner('historial', m); }
}

/* ---------- Escáner ---------- */
let stream = null, detector = null, escaneando = false, linterna = false;

async function abrirEscaner() {
  if (!('BarcodeDetector' in window)) {
    toast('Este navegador no tiene lector de códigos. Escribe el código a mano.', 4000);
    $('codigo-manual').focus();
    return;
  }
  mostrar('escaner');
  $('txt-escaner').textContent = 'Apunta al código de barras';
  try {
    const soportados = await BarcodeDetector.getSupportedFormats();
    const usar = FORMATOS.filter(function (f) { return soportados.indexOf(f) >= 0; });
    detector = new BarcodeDetector(usar.length ? { formats: usar } : undefined);
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    const video = $('video');
    video.srcObject = stream;
    await video.play();
    linterna = false;
    const pista = stream.getVideoTracks()[0];
    const caps = pista.getCapabilities ? pista.getCapabilities() : {};
    $('btn-linterna').classList.toggle('oculto', !caps.torch);
    escaneando = true;
    bucleEscaneo();
  } catch (e) {
    console.error(e);
    $('txt-escaner').textContent = 'No se pudo abrir la cámara: ' + e.message + '. Revisa los permisos de cámara.';
  }
}

async function bucleEscaneo() {
  if (!escaneando) return;
  const video = $('video');
  try {
    if (video.readyState >= 2) {
      const codigos = await detector.detect(video);
      if (codigos.length && escaneando) {
        const valor = String(codigos[0].rawValue || '').trim();
        if (valor) {
          if (navigator.vibrate) navigator.vibrate(120);
          pararEscaner();
          abrirFormulario(valor);
          return;
        }
      }
    }
  } catch (e) { console.warn(e); }
  setTimeout(bucleEscaneo, 150);
}

function pararEscaner() {
  escaneando = false;
  if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
}

async function alternarLinterna() {
  if (!stream) return;
  try {
    linterna = !linterna;
    await stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: linterna }] });
  } catch (e) { toast('No se pudo encender la linterna'); }
}

/* ---------- Formulario ---------- */
let pendientesCache = [];

async function abrirFormulario(codigo) {
  pendientesCache = await idb.todos('pendientes');
  const p = catalogo[codigo];
  actual = { codigo: codigo, conocido: !!(p && p.nombre) };

  $('f-nombre').textContent = actual.conocido ? p.nombre + (p.marca ? ' · ' + p.marca : '') : 'Producto nuevo';
  $('f-codigo').textContent = codigo;
  $('f-nuevo').classList.toggle('oculto', actual.conocido);
  $('f-nombre-nuevo').value = '';
  $('f-marca-nueva').value = '';
  $('f-cantidad').value = 1;
  $('f-nota').value = '';
  const previa = (ultimaCad[codigo] || '').split('-');
  ponerCaducidad(previa[0] || '', previa[1] || '');
  $('f-almacen').value = config.ultimoAlmacen || config.almacen || ALMACENES[0];
  $('f-estante').value = config.ultimoEstante || ESTANTES[0];

  const total = lotesDe(codigo).reduce(function (s, l) { return s + l.stock; }, 0);
  $('f-stock').textContent = 'En stock (según el último dato): ' + total;

  cambiarTipo('ENTRADA');
  mostrar('formulario');
}

// Stock por lote combinando el último dato del servidor y los movimientos pendientes del móvil
function lotesTodos(pendientes) {
  const mapa = {};
  function sumar(cod, cad, alm, est, n) {
    const k = [cod, cad || '', alm || '', est || ''].join('|');
    mapa[k] = (mapa[k] || 0) + Number(n || 0);
  }
  stockServidor.forEach(function (x) { sumar(String(x.codigo), x.caducidad, x.almacen, x.estante, x.stock); });
  pendientes.forEach(function (m) { sumar(m.codigo, m.caducidad, m.almacen, m.estante, m.tipo === 'SALIDA' ? -m.cantidad : m.cantidad); });
  const porCodigo = {};
  Object.keys(mapa).forEach(function (k) {
    if (mapa[k] <= 0) return;
    const p = k.split('|');
    (porCodigo[p[0]] = porCodigo[p[0]] || []).push({ caducidad: p[1], almacen: p[2], estante: p[3], stock: mapa[k] });
  });
  Object.keys(porCodigo).forEach(function (c) {
    porCodigo[c].sort(function (a, b) { return (a.caducidad || '9999').localeCompare(b.caducidad || '9999'); });
  });
  return porCodigo;
}

function lotesDe(codigo) { return lotesTodos(pendientesCache)[codigo] || []; }

/* ---------- Caducidad con botones ---------- */
function montarCaducidad() {
  const y = new Date().getFullYear();
  const anios = [''];
  for (let i = 0; i <= 6; i++) anios.push(String(y + i));
  $('f-anios').innerHTML = anios.map(function (a) {
    return '<button class="chip" data-a="' + a + '">' + (a || 'Sin cad.') + '</button>';
  }).join('');
  Array.prototype.forEach.call($('f-anios').children, function (b) {
    b.onclick = function () { ponerCaducidad(b.dataset.a, b.dataset.a ? cadMes : ''); };
  });
  const nombres = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  $('f-meses').innerHTML = nombres.map(function (n, i) {
    return '<button data-m="' + String(i + 1).padStart(2, '0') + '">' + n + '</button>';
  }).join('');
  Array.prototype.forEach.call($('f-meses').children, function (b) {
    b.onclick = function () { ponerCaducidad(cadAnio, b.dataset.m); };
  });
}

function ponerCaducidad(anio, mes) {
  // Años anteriores o muy lejanos (p. ej. de un lote antiguo): añadir el botón si falta
  if (anio && !$('f-anios').querySelector('[data-a="' + anio + '"]')) {
    const b = document.createElement('button');
    b.className = 'chip'; b.dataset.a = anio; b.textContent = anio;
    b.onclick = function () { ponerCaducidad(anio, cadMes); };
    $('f-anios').appendChild(b);
  }
  cadAnio = anio || '';
  cadMes = cadAnio ? (mes || '') : '';
  Array.prototype.forEach.call($('f-anios').children, function (b) { b.classList.toggle('activo', b.dataset.a === cadAnio); });
  Array.prototype.forEach.call($('f-meses').children, function (b) { b.classList.toggle('activo', b.dataset.m === cadMes); });
  $('f-meses').classList.toggle('desactivado', !cadAnio);
  $('f-cad-texto').textContent = !cadAnio ? 'sin caducidad' : (cadMes ? cadMes + '/' + cadAnio : cadAnio + ' (falta el mes)');
}

/* ---------- Consulta de stock ---------- */
async function abrirStock() {
  pendientesCache = await idb.todos('pendientes');
  $('s-buscar').value = '';
  mostrar('stock');
  pintarStock();
}

function estadoCaducidad(cad) {
  if (!cad) return '';
  const hoy = new Date();
  const actualMes = hoy.getFullYear() + '-' + String(hoy.getMonth() + 1).padStart(2, '0');
  const limite = new Date(hoy.getFullYear(), hoy.getMonth() + 3, 1);
  const pronto = limite.getFullYear() + '-' + String(limite.getMonth() + 1).padStart(2, '0');
  const c = cad.slice(0, 7);
  if (c < actualMes) return 'caducado';
  if (c <= pronto) return 'pronto';
  return '';
}

function pintarStock() {
  const porCodigo = lotesTodos(pendientesCache);
  const q = $('s-buscar').value.trim().toLowerCase();
  const filas = Object.keys(porCodigo).map(function (c) {
    const p = catalogo[c] || {};
    const lotes = porCodigo[c];
    return { codigo: c, nombre: p.nombre || '(sin nombre)', marca: p.marca || '', lotes: lotes,
             total: lotes.reduce(function (s, l) { return s + l.stock; }, 0) };
  }).filter(function (f) {
    return !q || (f.nombre + ' ' + f.marca + ' ' + f.codigo).toLowerCase().indexOf(q) >= 0;
  }).sort(function (a, b) { return a.nombre.localeCompare(b.nombre, 'es'); });

  const caducados = filas.reduce(function (n, f) { return n + f.lotes.filter(function (l) { return estadoCaducidad(l.caducidad) === 'caducado'; }).length; }, 0);
  $('s-resumen').textContent = filas.length + ' productos' + (caducados ? ' · ⚠️ ' + caducados + ' lotes caducados' : '') +
    (config.ultimaSync ? ' · datos de ' + new Date(config.ultimaSync).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');

  if (!filas.length) { $('s-lista').innerHTML = '<p class="muted">' + (q ? 'Nada coincide con la búsqueda.' : 'No hay stock registrado.') + '</p>'; return; }
  $('s-lista').innerHTML = filas.map(function (f) {
    return '<div class="prod" data-c="' + esc(f.codigo) + '"><div class="prod-cab"><span>' + esc(f.nombre) +
      (f.marca ? ' <span class="muted">· ' + esc(f.marca) + '</span>' : '') + '</span><span class="prod-total">' + f.total + '</span></div>' +
      f.lotes.map(function (l) {
        const e = estadoCaducidad(l.caducidad);
        return '<div class="lote"><span class="' + e + '">' + esc(l.caducidad || 'sin cad.') + (e === 'caducado' ? ' (caducado)' : '') +
          '</span> · ' + esc(l.almacen) + ' · est. ' + esc(l.estante) + ' · ' + l.stock + ' uds</div>';
      }).join('') + '</div>';
  }).join('');
  Array.prototype.forEach.call($('s-lista').children, function (d) {
    d.onclick = function () { abrirFormulario(d.dataset.c); };
  });
}

function cambiarTipo(tipo) {
  tipoActual = tipo;
  $('f-entrada').classList.toggle('activo', tipo === 'ENTRADA');
  $('f-salida').classList.toggle('activo', tipo === 'SALIDA');
  $('f-salida').classList.toggle('salida', tipo === 'SALIDA');
  const lotes = tipo === 'SALIDA' ? lotesDe(actual.codigo) : [];
  $('f-lotes-caja').classList.toggle('oculto', !lotes.length);
  $('f-lotes').innerHTML = lotes.map(function (l, i) {
    return '<button class="chip" data-i="' + i + '">' + esc(l.caducidad || 'sin cad.') + ' · ' +
      esc(l.almacen) + ' est. ' + esc(l.estante) + ' · ' + l.stock + ' uds</button>';
  }).join('');
  Array.prototype.forEach.call($('f-lotes').children, function (b) {
    b.onclick = function () { elegirLote(lotes[Number(b.dataset.i)], b); };
  });
  if (lotes.length) elegirLote(lotes[0], $('f-lotes').children[0]); // FEFO: el que caduca antes
}

function elegirLote(l, boton) {
  Array.prototype.forEach.call($('f-lotes').children, function (b) { b.classList.remove('activo'); });
  boton.classList.add('activo');
  const partes = (l.caducidad || '').split('-');
  ponerCaducidad(partes[0] || '', partes[1] || '');
  if (l.almacen) $('f-almacen').value = l.almacen;
  if (l.estante) $('f-estante').value = l.estante;
}

function cambiarCantidad(d) {
  const n = Math.max(1, (parseInt($('f-cantidad').value, 10) || 1) + d);
  $('f-cantidad').value = n;
}

async function guardarMovimiento(seguir) {
  const cantidad = parseInt($('f-cantidad').value, 10);
  if (!cantidad || cantidad < 1) { toast('La cantidad debe ser 1 o más'); return; }
  const anio = cadAnio, mes = cadMes;
  if (anio && !mes) { toast('Elige también el mes de caducidad'); return; }
  const caducidad = anio ? anio + '-' + mes : '';

  const mov = {
    id: (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2)),
    fecha: new Date().toISOString(),
    usuario: config.usuario || '',
    tipo: tipoActual,
    codigo: actual.codigo,
    cantidad: cantidad,
    caducidad: caducidad,
    almacen: $('f-almacen').value,
    estante: $('f-estante').value,
    nota: $('f-nota').value.trim()
  };

  let producto = null;
  const nombreNuevo = $('f-nombre-nuevo').value.trim();
  if (!actual.conocido && nombreNuevo) {
    producto = { codigo: actual.codigo, nombre: nombreNuevo, marca: $('f-marca-nueva').value.trim() };
    catalogo[actual.codigo] = Object.assign({}, catalogo[actual.codigo] || {}, producto);
    await idb.poner('kv', catalogo, 'catalogo');
  }

  await idb.poner('pendientes', Object.assign({}, mov, { _producto: producto }));
  const nombre = (catalogo[actual.codigo] && catalogo[actual.codigo].nombre) || '';
  await idb.poner('historial', Object.assign({}, mov, { nombre: nombre, estado: 'pendiente' }));

  if (mov.tipo === 'ENTRADA') ultimaCad[mov.codigo] = caducidad;
  config.ultimoAlmacen = mov.almacen;
  config.ultimoEstante = mov.estante;
  await guardarConfig();

  toast((mov.tipo === 'ENTRADA' ? 'Entrada' : 'Salida') + ' guardada: ' + cantidad + ' × ' + (nombre || mov.codigo));
  if (seguir) abrirEscaner(); else mostrar('inicio');
  await refrescarEstado();
  await pintarHistorial();
  sincronizar(false);
}

/* ---------- Sincronización ---------- */
async function llamar(metodo, datos) {
  const ctrl = new AbortController();
  const t = setTimeout(function () { ctrl.abort(); }, 30000);
  try {
    let resp;
    if (metodo === 'GET') {
      const u = new URL(config.url);
      u.searchParams.set('accion', datos.accion);
      u.searchParams.set('token', config.token);
      resp = await fetch(u.toString(), { signal: ctrl.signal });
    } else {
      resp = await fetch(config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // evita el bloqueo CORS de Apps Script
        body: JSON.stringify(Object.assign({}, datos, { token: config.token })),
        signal: ctrl.signal
      });
    }
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const json = await resp.json();
    if (!json.ok) throw new Error(json.error === 'token' ? 'token incorrecto' : (json.error || 'error del servidor'));
    return json;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('el servidor no responde');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function sincronizar(manual) {
  if (sincronizando || !config.url || !config.token) return;
  if (!navigator.onLine) {
    if (manual) toast('Sin conexión. Se sincronizará al volver la red.');
    return;
  }
  sincronizando = true;
  await refrescarEstado();
  try {
    const pendientes = await idb.todos('pendientes');
    pendientes.sort(function (a, b) { return a.fecha.localeCompare(b.fecha); });
    for (let i = 0; i < pendientes.length; i += 100) {
      const lote = pendientes.slice(i, i + 100);
      const productos = lote.filter(function (m) { return m._producto; }).map(function (m) { return m._producto; });
      const movimientos = lote.map(function (m) { const c = Object.assign({}, m); delete c._producto; return c; });
      const r = await llamar('POST', { accion: 'movimientos', movimientos: movimientos, productos: productos });
      for (const id of r.aceptados) { await idb.borrar('pendientes', id); await marcarHistorial(id, 'ok'); }
      for (const x of r.rechazados) { await idb.borrar('pendientes', x.id); await marcarHistorial(x.id, 'rechazado: ' + x.motivo); }
    }

    const d = await llamar('GET', { accion: 'datos' });
    const nuevo = {};
    (d.productos || []).forEach(function (p) { nuevo[String(p.codigo)] = p; });
    catalogo = nuevo;
    stockServidor = d.stock || [];
    await idb.poner('kv', catalogo, 'catalogo');
    await idb.poner('kv', stockServidor, 'stock');

    config.ultimaSync = new Date().toISOString();
    await guardarConfig();
    ultimoError = '';
    if (manual) toast('Sincronizado');
  } catch (e) {
    console.error(e);
    ultimoError = e.message;
    if (manual) toast('Error al sincronizar: ' + e.message, 4000);
  } finally {
    sincronizando = false;
    await refrescarEstado();
    await pintarHistorial();
  }
}

/* ---------- Ajustes ---------- */
function abrirAjustes() {
  $('a-url').value = config.url || '';
  $('a-token').value = config.token || '';
  $('a-usuario').value = config.usuario || '';
  $('a-almacen').value = config.almacen || ALMACENES[0];
  $('a-resultado').textContent = '';
  mostrar('ajustes');
}

async function guardarAjustes() {
  const url = $('a-url').value.trim(), token = $('a-token').value.trim(), usuario = $('a-usuario').value.trim();
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) { toast('La dirección debe empezar por https://script.google.com y terminar en /exec', 4000); return; }
  if (!token) { toast('Falta el token'); return; }
  if (!usuario) { toast('Escribe tu nombre'); return; }
  config.url = url; config.token = token; config.usuario = usuario; config.almacen = $('a-almacen').value;
  await guardarConfig();
  toast('Ajustes guardados');
  mostrar('inicio');
  sincronizar(true);
}

async function probarConexion() {
  const anterior = { url: config.url, token: config.token };
  config.url = $('a-url').value.trim();
  config.token = $('a-token').value.trim();
  $('a-resultado').textContent = 'Probando…';
  try {
    await llamar('GET', { accion: 'ping' });
    $('a-resultado').textContent = '✅ Conexión correcta. Pulsa Guardar.';
  } catch (e) {
    $('a-resultado').textContent = '❌ ' + e.message;
  } finally {
    config.url = anterior.url; config.token = anterior.token;
  }
}

iniciar().catch(function (e) { console.error(e); toast('Error al arrancar: ' + e.message, 5000); });
