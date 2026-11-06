'use strict';
/* =========================================================
 * DESPENSA — app del móvil (v2.0)
 * Escanear → guardar sin conexión → sincronizar con la Sheet
 * Listas (categorías, estancias, ubicaciones) vienen de la pestaña Config.
 * ========================================================= */

const VERSION = '2.4.2';
const FORMATOS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'];
const UNIDADES = ['uds', 'kg', 'g', 'litros', 'ml', 'rollos', 'paquetes'];
const MAX_HISTORIAL = 200;
// Solo se usan si la app aún no ha descargado la pestaña Config
const ESTANCIA_RESERVA = 'Trastero Ávila';

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
let ajustes = {};        // ajustes de este móvil (url, token, usuario…)
let catalogo = {};       // codigo -> producto
let stockServidor = [];  // [{codigo, caducidad, almacen, estante, stock}]
let listas = [];         // [{tipo, valor, estancia, activo}] (pestaña Config)
let objetivos = [];      // [{id, categoria, descripcion, almacen, …}]
let prodPend = {};       // cambios de fichas de producto aún no enviados
let fotosPend = {};      // codigo -> foto (dataURL) aún no subida
let sincronizando = false;
let ultimoError = '';
let actual = null;       // producto abierto en el formulario
let tipoActual = 'ENTRADA';
let cadAnio = '', cadMes = '';
const ultimaCad = {};
let pendientesCache = [];
let vistaStock = 'producto';
let tipoLista = 'CATEGORIA';
let stockFiltrado = true;
let resincronizar = false;
let soloIncompletos = false;
let ignorarCodigo = '', ignorarHasta = 0; // evita releer el producto anterior en la ráfaga

const $ = function (id) { return document.getElementById(id); };
function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function cada(lista, fn) { Array.prototype.forEach.call(lista, fn); }
const TILDES = { energia: 'energía', botiquin: 'botiquín', categoria: 'categoría' };
function bonito(cat) {
  return String(cat || '').replace(/_/g, ' ').toLowerCase().split(' ').map(function (w) { return TILDES[w] || w; }).join(' ')
    .replace(/^./, function (c) { return c.toUpperCase(); });
}

let toastTimer;
function toast(msg, ms) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('oculto');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.add('oculto'); }, ms || 2500);
}

function mostrar(nombre) {
  ['inicio', 'escaner', 'formulario', 'ajustes', 'stock', 'buscar'].forEach(function (p) {
    $('pantalla-' + p).classList.toggle('oculto', p !== nombre);
  });
  if (nombre !== 'escaner') pararEscaner();
  window.scrollTo(0, 0);
}

async function guardarAjustesLocales() { await idb.poner('kv', ajustes, 'config'); }

/* ---------- Listas (Config) ---------- */
function valores(tipo, estancia, incluirInactivos) {
  return listas.filter(function (x) {
    return x.tipo === tipo && (incluirInactivos || x.activo) &&
      (tipo !== 'UBICACION' || x.estancia === estancia);
  }).map(function (x) { return x.valor; });
}
function categorias() { return valores('CATEGORIA'); }
function modoDe(cat) {
  const x = listas.find(function (i) { return i.tipo === 'CATEGORIA' && i.valor === cat; });
  return x ? (x.padre || x.estancia || '') : '';
}
// Categorías del modo actual (las que no tienen modo asignado salen en los dos)
function categoriasDelModo(modo) {
  return categorias().filter(function (c) { const m = modoDe(c); return !m || m === modo; });
}
// Grupo = lo que va antes de " – " ("Mochila – Botiquín/higiene" → "Mochila")
function grupoDe(est) { return String(est || '').split(/\s[–-]\s/)[0].trim(); }
function grupos() {
  const g = [];
  estancias().forEach(function (e) { const x = grupoDe(e); if (g.indexOf(x) < 0) g.push(x); });
  return g;
}
function grupoActual() { const g = grupos(); return g.indexOf(ajustes.grupo) >= 0 ? ajustes.grupo : g[0]; }
function modoActual() { return ajustes.modo === 'MATERIAL' ? 'MATERIAL' : 'DESPENSA'; }
function estanciasDelGrupo(g) { return estancias().filter(function (e) { return grupoDe(e) === g; }); }
function estancias() { const e = valores('ESTANCIA'); return e.length ? e : [ESTANCIA_RESERVA]; }
function ubicacionesDe(est) { return valores('UBICACION', est); }

/* ---------- Arranque ---------- */
async function iniciar() {
  ajustes = (await idb.get('kv', 'config')) || {};
  catalogo = (await idb.get('kv', 'catalogo')) || {};
  stockServidor = (await idb.get('kv', 'stock')) || [];
  listas = (await idb.get('kv', 'listas')) || [];
  objetivos = (await idb.get('kv', 'objetivos')) || [];
  prodPend = (await idb.get('kv', 'prodPend')) || {};
  fotosPend = (await idb.get('kv', 'fotosPend')) || {};

  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn(e); });

  montarCaducidad();
  opciones($('p-unidad'), UNIDADES);
  enlazarEventos();
  $('a-version').textContent = VERSION;

  pintarContexto();
  if (!ajustes.url || !ajustes.token || !ajustes.usuario) abrirAjustes();
  else mostrar('inicio');

  await refrescarEstado();
  await pintarHistorial();
  sincronizar(false);

  window.addEventListener('online', function () { refrescarEstado(); sincronizar(false); });
  window.addEventListener('offline', refrescarEstado);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') sincronizar(false);
    else if (!$('pantalla-escaner').classList.contains('oculto')) mostrar('inicio'); // no dejar la cámara encendida
  });
  setInterval(function () { sincronizar(false); }, 120000);
}

function opciones(select, lista, vacia) {
  select.innerHTML = (vacia !== undefined ? '<option value="">' + esc(vacia) + '</option>' : '') +
    lista.map(function (o) {
      const v = typeof o === 'object' ? o.v : o, t = typeof o === 'object' ? o.t : o;
      return '<option value="' + esc(v) + '">' + esc(t) + '</option>';
    }).join('');
}

// Si el valor guardado ya no está en la lista (p. ej. desactivado), se añade para no perderlo
function opcionesConValor(select, lista, valor, vacia) {
  const l = lista.slice();
  if (valor && l.indexOf(valor) < 0) l.push(valor);
  opciones(select, l, vacia);
  select.value = valor || (vacia !== undefined ? '' : (l[0] || ''));
}

function enlazarEventos() {
  $('btn-ajustes').onclick = abrirAjustes;
  ['DESPENSA', 'MATERIAL'].forEach(function (m) {
    $('c-' + m).onclick = async function () { ajustes.modo = m; await guardarAjustesLocales(); pintarContexto(); };
  });
  $('s-filtro').onclick = function () { stockFiltrado = !stockFiltrado; pintarStock(); };
  $('l-modo').onchange = pintarListas;
  $('btn-sincronizar').onclick = function () { sincronizar(true); };
  $('btn-escanear').onclick = abrirEscaner;
  $('btn-stock').onclick = abrirStock;
  $('btn-buscar').onclick = function () { soloIncompletos = false; abrirBuscar(); };
  $('btn-incompletos').onclick = function () { soloIncompletos = true; abrirBuscar(); };
  $('b-solo-incompletos').onclick = function () { soloIncompletos = !soloIncompletos; pintarBuscar(); };
  $('b-buscar').oninput = pintarBuscar;
  $('b-nuevo').onclick = function () { abrirFormulario(codigoInterno(), { sinCodigo: true, nombre: $('b-buscar').value.trim() }); };
  $('b-volver').onclick = function () { mostrar('inicio'); };
  $('btn-codigo-manual').onclick = function () {
    const c = normalizarCodigo($('codigo-manual').value);
    if (!c) { toast('Escribe un código'); return; }
    $('codigo-manual').value = '';
    abrirFormulario(c);
  };
  $('btn-cancelar-escaner').onclick = function () { mostrar('inicio'); };
  $('btn-linterna').onclick = alternarLinterna;

  $('f-editar').onclick = function () { $('f-ficha').classList.toggle('oculto'); };
  $('p-guardar-ficha').onclick = guardarSoloFicha;
  $('p-linea').onchange = function () {
    if ($('p-linea').value === '__todas') { pintarLineas('__todas'); return; }
    actual.lineaTocada = true;
  };
  $('p-nombre').onchange = function () { pintarCategoriasFicha(); if (!actual.lineaTocada) pintarLineas(''); };
  $('p-foto').onclick = function () { $('p-foto-input').click(); };
  $('p-foto-input').onchange = tomarFoto;
  $('p-galeria').onclick = function () { $('p-galeria-input').click(); };
  $('p-galeria-input').onchange = tomarFoto;
  $('p-consumible').onclick = function () { ponerTipoProducto('CONSUMIBLE'); };
  $('p-equipo').onclick = function () { ponerTipoProducto('EQUIPO'); };
  $('f-entrada').onclick = function () { cambiarTipo('ENTRADA'); };
  $('f-salida').onclick = function () { cambiarTipo('SALIDA'); };
  $('f-menos').onclick = function () { cambiarCantidad(-1); };
  $('f-mas').onclick = function () { cambiarCantidad(1); };
  $('f-almacen').onchange = function () { pintarUbicaciones(''); pintarLineas(actual.lineaTocada ? undefined : ''); };
  $('f-guardar').onclick = function () { guardarMovimiento(false); };
  $('f-guardar-seguir').onclick = function () { guardarMovimiento(true); };
  $('f-cancelar').onclick = function () { mostrar('inicio'); };

  $('s-buscar').oninput = pintarStock;
  $('s-volver').onclick = function () { mostrar('inicio'); };
  ['producto', 'categoria', 'estancia'].forEach(function (v) {
    $('s-v-' + v).onclick = function () { vistaStock = v; pintarStock(); };
  });

  $('a-guardar').onclick = guardarAjustes;
  $('a-probar').onclick = probarConexion;
  $('a-volver').onclick = function () {
    if (!ajustes.url || !ajustes.token || !ajustes.usuario) { toast('Rellena y guarda los ajustes primero'); return; }
    mostrar('inicio');
  };
  ['CATEGORIA', 'ESTANCIA', 'UBICACION'].forEach(function (t) {
    $('l-t-' + t).onclick = function () { tipoLista = t; pintarListas(); };
  });
  $('l-estancia').onchange = pintarListas;
  $('l-anadir').onclick = anadirALista;
}

/* ---------- Dónde estás / qué metes ---------- */
function pintarContexto() {
  const g = grupoActual();
  $('c-grupos').innerHTML = grupos().map(function (x) {
    return '<button class="chip' + (x === g ? ' activo' : '') + '" data-g="' + esc(x) + '">' + esc(x) + '</button>';
  }).join('');
  cada($('c-grupos').children, function (b) {
    b.onclick = async function () { ajustes.grupo = b.dataset.g; await guardarAjustesLocales(); pintarContexto(); };
  });
  ['DESPENSA', 'MATERIAL'].forEach(function (m) { $('c-' + m).classList.toggle('activo', m === modoActual()); });
}

/* ---------- Estado e historial ---------- */
async function refrescarEstado() {
  const online = navigator.onLine;
  $('punto-red').className = 'punto ' + (online ? 'on' : 'off');
  $('txt-red').textContent = sincronizando ? 'Sincronizando…' : (online ? 'Con conexión' : 'Sin conexión');
  const pend = await idb.todos('pendientes');
  const nFichas = Object.keys(prodPend).length, nFotos = Object.keys(fotosPend).length;
  $('txt-pendientes').textContent = pend.length + (nFichas ? ' (+' + nFichas + ' fichas)' : '') + (nFotos ? ' (+' + nFotos + ' fotos)' : '');
  $('txt-sync').textContent = ajustes.ultimaSync
    ? 'Última sincronización: ' + new Date(ajustes.ultimaSync).toLocaleString('es-ES')
    : 'Nunca sincronizado';
  $('txt-error').textContent = ultimoError ? 'Último error: ' + ultimoError : '';
  const n = incompletos().length;
  $('btn-incompletos').classList.toggle('oculto', !n);
  $('btn-incompletos').textContent = '⚠️ ' + n + (n === 1 ? ' producto' : ' productos') + ' sin nombre o sin categoría · Completar';
}

// Productos a los que les falta el nombre o la categoría (p. ej. no estaban en Open Food Facts)
function incompletos() {
  return Object.keys(catalogo).map(function (c) { return catalogo[c]; })
    .filter(function (p) { return p && (!p.nombre || !p.categoria); });
}

function nombreDe(codigo) {
  const p = catalogo[codigo];
  return (p && p.nombre) || codigo;
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
    return '<li><div><span class="tag ' + esc(m.tipo) + '">' + esc(m.tipo) + '</span> ' +
      esc(m.cantidad) + ' × ' + esc((catalogo[m.codigo] && catalogo[m.codigo].nombre) || m.nombre || m.codigo) +
      '<div class="meta">' + esc(m.caducidad || 'sin cad.') + ' · ' + esc(m.almacen) + (m.estante ? ' · ' + esc(m.estante) : '') +
      ' · ' + new Date(m.fecha).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) +
      (m.estado !== 'ok' && m.estado !== 'pendiente' ? '<br><span class="error">' + esc(m.estado) + '</span>' : '') +
      '</div></div><div>' + icono + '</div></li>';
  }).join('');
}

async function marcarHistorial(id, estado) {
  const m = await idb.get('historial', id);
  if (m) { m.estado = estado; await idb.poner('historial', m); }
}

/* ---------- Códigos ---------- */
// Quita espacios y guiones; un UPC-A de 12 cifras se guarda como su EAN-13 (con 0 delante)
function normalizarCodigo(c) {
  c = String(c || '').trim().replace(/[\s-]/g, '');
  return /^\d{12}$/.test(c) ? '0' + c : c;
}

/* ---------- Escáner ---------- */
let stream = null, detector = null, escaneando = false, linterna = false, generacion = 0;

async function abrirEscaner() {
  if (!('BarcodeDetector' in window)) {
    toast('Este navegador no tiene lector de códigos. Escribe el código a mano.', 4000);
    mostrar('inicio');
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
    bucleEscaneo(++generacion); // cada apertura tiene su propio bucle; los anteriores se paran solos
  } catch (e) {
    console.error(e);
    $('txt-escaner').textContent = 'No se pudo abrir la cámara: ' + e.message + '. Revisa los permisos de cámara.';
  }
}

async function bucleEscaneo(gen) {
  if (!escaneando || gen !== generacion) return;
  const video = $('video');
  try {
    if (video.readyState >= 2) {
      const codigos = await detector.detect(video);
      if (codigos.length && escaneando) {
        const valor = normalizarCodigo(codigos[0].rawValue);
        if (valor === ignorarCodigo && Date.now() < ignorarHasta) {
          $('txt-escaner').textContent = 'Retira el producto anterior y enfoca el siguiente';
        } else if (valor) {
          if (navigator.vibrate) navigator.vibrate(120);
          pararEscaner();
          abrirFormulario(valor);
          return;
        }
      }
    }
  } catch (e) { console.warn(e); }
  setTimeout(function () { bucleEscaneo(gen); }, 150);
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
function codigoInterno() {
  const r = (crypto.getRandomValues ? Array.from(crypto.getRandomValues(new Uint8Array(4))) : [Math.random() * 255, Math.random() * 255, Math.random() * 255, Math.random() * 255])
    .map(function (b) { return Math.floor(b).toString(36).padStart(2, '0'); }).join('').toUpperCase().slice(0, 6);
  return 'INT-' + r;
}

async function abrirFormulario(codigo, opciones_) {
  const op = opciones_ || {};
  pendientesCache = await idb.todos('pendientes');
  const p = catalogo[codigo] || {};
  actual = { codigo: codigo, existe: !!catalogo[codigo], sinCodigo: !!op.sinCodigo || /^INT-/.test(codigo),
             tipoProducto: p.tipo || 'CONSUMIBLE', categoria: p.categoria || '', fotoUrl: '',
             offTags: [], catSugerida: false, lineaTocada: !!p.linea_objetivo, verTodasLineas: false, desdeBuscar: !!op.editar };

  pintarCabeceraProducto();
  $('f-codigo').textContent = actual.sinCodigo ? 'Sin código de barras (' + codigo + ')' : codigo;

  // Ficha del producto
  $('p-nombre').value = p.nombre || op.nombre || '';
  $('p-marca').value = p.marca || '';
  $('p-contenido').value = p.contenido === undefined || p.contenido === null ? '' : p.contenido;
  $('p-unidad').value = p.unidad || 'uds';
  pintarCategoriasFicha();
  ponerTipoProducto(actual.tipoProducto);
  const incompleta = !p.nombre || !p.categoria;
  $('f-ficha').classList.toggle('oculto', !incompleta && !op.editar);

  // Movimiento
  $('f-cantidad').value = 1;
  $('f-nota').value = '';
  const previa = (ultimaCad[codigo] || '').split('-');
  ponerCaducidad(previa[0] || '', previa[1] || '');
  const delGrupo = estanciasDelGrupo(grupoActual());
  const sitio = (ajustes.sitioPorCodigo || {})[codigo] || {};
  const preferida = [sitio.almacen, ajustes.ultimoAlmacen].find(function (e) { return e && delGrupo.indexOf(e) >= 0; }) || delGrupo[0];
  opciones($('f-almacen'), delGrupo);
  $('f-almacen').value = preferida;
  $('f-almacen-caja').classList.toggle('oculto', delGrupo.length < 2);
  pintarUbicaciones(sitio.almacen === preferida && sitio.estante ? sitio.estante : (ajustes.ultimoEstante || ''));
  pintarLineas(p.linea_objetivo || '');

  const total = lotesDe(codigo).reduce(function (s, l) { return s + l.stock; }, 0);
  $('f-stock').textContent = actual.existe ? 'En stock (según el último dato): ' + total : '';

  cambiarTipo(op.salida ? 'SALIDA' : 'ENTRADA');
  mostrar('formulario');
  pintarFoto();
  $('f-off').textContent = '';
  if (actual.sinCodigo && !p.nombre) { pintarCategoriasFicha(); setTimeout(function () { $('p-nombre').focus(); }, 100); }
  if (!actual.sinCodigo && !p.nombre) consultarOFF(codigo);
}

/* ---------- Sugerencias de categoría y de línea de objetivo ---------- */
const VACIAS = ['de', 'del', 'la', 'el', 'los', 'las', 'en', 'con', 'sin', 'y', 'o', 'para', 'por', 'al', 'lata', 'bote', 'pack', 'tarro', 'bolsa', 'caja', 'uds', 'unidad', 'unidades', 'gr', 'kg', 'ml'];
// palabra (raíz) -> grupo genérico que también se añade
const SINONIMOS = {
  garba: 'legum', lente: 'legum', alubi: 'legum', judia: 'legum', fabes: 'legum',
  atun: 'pesca', sardi: 'pesca', caball: 'pesca', bonit: 'pesca', melva: 'pesca', mejil: 'pesca', berbe: 'pesca',
  maiz: 'verdu', guisa: 'verdu', pimie: 'verdu', champ: 'verdu', espar: 'verdu', menes: 'verdu', zanah: 'verdu', judias: 'verdu',
  meloc: 'fruta', pina: 'fruta', pera: 'fruta', compo: 'fruta', almib: 'fruta',
  galle: 'galle', tosta: 'galle', crack: 'galle', biscot: 'galle',
  avena: 'cerea', copos: 'cerea', cerea: 'cerea', muesl: 'cerea',
  colac: 'cacao', nesqu: 'cacao', cacao: 'cacao', cafe: 'cafe', infus: 'cafe', manza: 'cafe', te: 'cafe',
  almen: 'fruto', nuez: 'fruto', nueces: 'fruto', cacah: 'fruto', pista: 'fruto', anacar: 'fruto',
  macar: 'pasta', espag: 'pasta', fidec: 'pasta', fideo: 'pasta', tallar: 'pasta', helic: 'pasta'
};
const REGLAS = {
  BEBIDA: ['agua', 'leche', 'zumo', 'refresco', 'vino', 'cerveza', 'bebida', 'batido', 'nectar', 'gaseosa'],
  POTABILIZAR: ['lejia', 'filtro', 'potabiliz', 'pastillas potab'],
  PLATOS_PREPARADOS: ['fabada', 'cocido', 'callos', 'oreja', 'lentejas con', 'lentejas estofadas', 'plato', 'preparad', 'guiso', 'estofad', 'albondiga', 'potaje', 'paella', 'cocinad'],
  CONSERVAS: ['atun', 'sardina', 'caballa', 'mejillon', 'berberecho', 'bonito', 'maiz', 'guisante', 'pimiento', 'champinon', 'esparrago', 'menestra', 'garbanzos cocidos', 'alubias cocidas', 'lentejas cocidas', 'legumbre', 'almibar', 'melocoton', 'compota', 'aceituna', 'conserva'],
  COCINAR: ['arroz', 'pasta', 'macarron', 'espagueti', 'spaghetti', 'fideo', 'harina', 'tallarin', 'helices', 'cuscus', 'pure de patata'],
  CONDIMENTOS: ['aceite', 'sal ', 'azucar', 'tomate', 'caldo', 'vinagre', 'especia', 'pimenton', 'oregano', 'mayonesa', 'ketchup', 'mostaza', 'pastilla de caldo'],
  DESAYUNO: ['cacao', 'cola cao', 'colacao', 'nesquik', 'cafe', 'infusion', 'manzanilla', 'magdalena', 'galleta', 'cereal', 'avena', 'miel', 'mermelada', 'crema de cacahuete', 'tostada', 'bizcocho', 'nocilla', 'nutella'],
  SNACKS: ['patatas fritas', 'gusanito', 'frutos secos', 'almendra', 'nuez', 'cacahuete', 'pistacho', 'chocolate', 'barrita', 'chips', 'palomita', 'snack'],
  MENAJE_Y_GAS: ['cartucho', 'campingaz', 'gas', 'abrelatas', 'mechero', 'cerilla', 'desechable', 'vaso', 'cubierto', 'servilleta', 'hornillo'],
  ENERGIA: ['pila', 'bateria', 'cargador', 'linterna', 'frontal', 'panel solar', 'powerbank', 'power bank'],
  HIGIENE: ['papel higienico', 'toallita', 'gel', 'champu', 'pasta de dientes', 'dentifrico', 'cepillo', 'desodorante', 'compresa', 'tampon', 'jabon', 'hidroalcoholico'],
  LIMPIEZA: ['bolsa de basura', 'bolsas de basura', 'lavavajillas', 'detergente', 'friegasuelos', 'estropajo', 'guantes', 'papel de cocina', 'amoniaco', 'bayeta'],
  BOTIQUIN: ['paracetamol', 'ibuprofeno', 'tirita', 'gasa', 'suero', 'termometro', 'betadine', 'desinfectante', 'venda', 'medicamento', 'aspirina', 'clorhexidina']
};
// Categorías de Open Food Facts (categories_tags) -> categoría propia
const REGLAS_OFF = {
  BEBIDA: ['waters', 'milks', 'juices', 'beverages', 'wines', 'sodas'],
  PLATOS_PREPARADOS: ['meals', 'prepared-', 'stews', 'canned-meals'],
  CONSERVAS: ['canned-', 'fish-in-', 'canned-fish', 'canned-vegetables', 'canned-legumes', 'fruits-in-syrup', 'olives'],
  COCINAR: ['rices', 'pastas', 'flours', 'dry-pastas'],
  CONDIMENTOS: ['oils', 'salts', 'sugars', 'tomato-sauces', 'broths', 'condiments', 'sauces', 'vinegars', 'spices'],
  DESAYUNO: ['breakfasts', 'cereals', 'biscuits', 'cocoa', 'coffees', 'teas', 'honeys', 'jams', 'spreads', 'cakes'],
  SNACKS: ['snacks', 'nuts', 'chocolates', 'chips', 'crisps']
};

function normalizar(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ñ/g, 'n').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function raices(t) {
  const set = new Set();
  normalizar(t).split(' ').forEach(function (w) {
    if (w.length < 3 || VACIAS.indexOf(w) >= 0 || /^\d/.test(w)) return;
    const r = w.slice(0, 5);
    set.add(r);
    const grupo = SINONIMOS[r] || SINONIMOS[w];
    if (grupo) set.add('#' + grupo);
  });
  return set;
}
function coincidencias(a, b) { let n = 0; a.forEach(function (x) { if (b.has(x)) n++; }); return n; }

function sugerirCategorias() {
  const activas = categoriasDelModo(modoActual());
  if (!activas.length) return [];
  const nombre = $('p-nombre').value + ' ' + $('p-marca').value;
  const texto = ' ' + normalizar(nombre) + ' ';
  const mias = raices(nombre);
  const puntos = {};
  activas.forEach(function (c) { puntos[c] = 0; });
  Object.keys(REGLAS).forEach(function (c) {
    if (!(c in puntos)) return;
    REGLAS[c].forEach(function (k) { if (texto.indexOf(normalizar(k).length < 4 ? ' ' + normalizar(k) + ' ' : normalizar(k)) >= 0) puntos[c] += 2; });
  });
  (actual.offTags || []).forEach(function (tag) {
    Object.keys(REGLAS_OFF).forEach(function (c) {
      if (c in puntos && REGLAS_OFF[c].some(function (k) { return tag.indexOf(k) >= 0; })) puntos[c] += 3;
    });
  });
  // Productos parecidos que ya tienes clasificados
  if (mias.size) {
    const mejor = {};
    Object.keys(catalogo).forEach(function (cod) {
      const p = catalogo[cod];
      if (cod === actual.codigo || !p.categoria || !(p.categoria in puntos)) return;
      const n = coincidencias(mias, raices(p.nombre));
      if (n > (mejor[p.categoria] || 0)) mejor[p.categoria] = n;
    });
    Object.keys(mejor).forEach(function (c) { puntos[c] += mejor[c] * 1.5; });
  }
  return activas.map(function (c) { return { cat: c, puntos: puntos[c] }; })
    .filter(function (x) { return x.puntos > 0; })
    .sort(function (a, b) { return b.puntos - a.puntos; });
}

function puntuarLinea(o) {
  const mias = raices($('p-nombre').value + ' ' + $('p-marca').value);
  return coincidencias(mias, raices(o.descripcion));
}

/* ---------- Open Food Facts (desde el móvil, si hay red) ---------- */
async function consultarOFF(codigo) {
  if (!navigator.onLine) { $('f-off').textContent = 'Sin conexión: se buscará en Open Food Facts al sincronizar.'; return; }
  $('f-off').textContent = 'Buscando en Open Food Facts…';
  const ctrl = new AbortController();
  const t = setTimeout(function () { ctrl.abort(); }, 6000);
  try {
    const url = 'https://world.openfoodfacts.org/api/v2/product/' + encodeURIComponent(codigo) +
      '.json?fields=product_name,product_name_es,brands,product_quantity,product_quantity_unit,image_front_small_url,categories_tags';
    const r = await fetch(url, { signal: ctrl.signal });
    const j = r.ok ? await r.json() : null;
    if (!actual || actual.codigo !== codigo) return; // el usuario ya cambió de producto
    const prod = j && j.status === 1 ? j.product : null;
    const nombre = prod ? (prod.product_name_es || prod.product_name || '') : '';
    if (!nombre) { $('f-off').textContent = 'No está en Open Food Facts. Escribe el nombre o haz una foto.'; return; }
    if (!$('p-nombre').value) $('p-nombre').value = nombre;
    const marca = String(prod.brands || '').split(',')[0].trim();
    if (!$('p-marca').value && marca) $('p-marca').value = marca;
    const cont = convertirCantidad(prod.product_quantity, prod.product_quantity_unit);
    if (!$('p-contenido').value && cont.contenido) { $('p-contenido').value = String(cont.contenido).replace('.', ','); $('p-unidad').value = cont.unidad; }
    if (prod.image_front_small_url) actual.fotoUrl = prod.image_front_small_url;
    actual.offTags = (prod.categories_tags || []).map(String);
    $('f-nombre').textContent = $('p-nombre').value + ($('p-marca').value ? ' · ' + $('p-marca').value : '');
    $('f-off').textContent = '✓ Datos de Open Food Facts. Revisa el nombre y la categoría.';
    pintarFoto();
    pintarCategoriasFicha();
    pintarLineas();
  } catch (e) {
    if (actual && actual.codigo === codigo) $('f-off').textContent = 'Open Food Facts no responde; se buscará al sincronizar.';
  } finally {
    clearTimeout(t);
  }
}

function convertirCantidad(q, u) {
  const n = Number(q);
  if (!n || n <= 0) return { contenido: '', unidad: '' };
  u = String(u || 'g').toLowerCase();
  if (u === 'g') return n >= 1000 ? { contenido: n / 1000, unidad: 'kg' } : { contenido: n, unidad: 'g' };
  if (u === 'ml') return n >= 1000 ? { contenido: n / 1000, unidad: 'litros' } : { contenido: n, unidad: 'ml' };
  if (u === 'kg') return { contenido: n, unidad: 'kg' };
  if (u === 'l') return { contenido: n, unidad: 'litros' };
  return { contenido: '', unidad: '' };
}

/* ---------- Fotos ---------- */
function pintarFoto() {
  const img = $('f-foto');
  const p = catalogo[actual.codigo] || {};
  const src = fotosPend[actual.codigo] || actual.fotoUrl ||
    (p.foto_url && /openfoodfacts/.test(p.foto_url) ? p.foto_url : '');
  img.classList.toggle('oculto', !src);
  if (src) img.src = src;
  $('p-foto').textContent = (fotosPend[actual.codigo] || (p.foto_url && !/openfoodfacts/.test(p.foto_url))) ? '📷 Repetir foto' : '📷 Hacer foto';
}

async function tomarFoto(ev) {
  const archivo = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!archivo) return;
  try {
    const dataUrl = await reducirImagen(archivo, 1000, 0.7);
    fotosPend[actual.codigo] = dataUrl;
    await idb.poner('kv', fotosPend, 'fotosPend');
    pintarFoto();
    toast('Foto guardada en el móvil; se subirá al sincronizar');
  } catch (e) {
    toast('No se pudo procesar la foto: ' + e.message, 4000);
  }
}

function reducirImagen(archivo, maxLado, calidad) {
  return new Promise(function (res, rej) {
    const url = URL.createObjectURL(archivo);
    const img = new Image();
    img.onload = function () {
      const k = Math.min(1, maxLado / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg', calidad));
    };
    img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('imagen no válida')); };
    img.src = url;
  });
}

function pintarCabeceraProducto() {
  const p = catalogo[actual.codigo] || {};
  $('f-nombre').textContent = p.nombre ? p.nombre + (p.marca ? ' · ' + p.marca : '') : (actual.sinCodigo ? 'Artículo sin código' : 'Producto nuevo');
  const cat = actual.categoria;
  $('f-etiquetas').innerHTML = (cat ? '<span class="tag-cat">' + esc(bonito(cat)) + '</span> ' : '') +
    (actual.tipoProducto === 'EQUIPO' ? '<span class="tag-cat tag-equipo">Equipo</span>' : '');
}

function pintarCategoriasFicha() {
  const todas = categoriasDelModo(modoActual());
  if (actual.categoria && todas.indexOf(actual.categoria) < 0) todas.push(actual.categoria);
  if (!todas.length) { $('p-categorias').innerHTML = '<span class="muted">Sincroniza para descargar las categorías.</span>'; return; }
  const sug = sugerirCategorias().slice(0, 3);
  // Preseleccionar la mejor si el producto aún no tiene categoría elegida por el usuario
  if (!actual.categoria || actual.catSugerida) {
    if (sug.length && sug[0].puntos >= 2) { actual.categoria = sug[0].cat; actual.catSugerida = true; }
    else if (actual.catSugerida) { actual.categoria = ''; actual.catSugerida = false; } // la sugerencia anterior ya no vale
  }
  const sugCats = sug.map(function (x) { return x.cat; });
  function chip(c) {
    return '<button class="chip' + (c === actual.categoria ? ' activo' : '') + '" data-c="' + esc(c) + '">' + esc(bonito(c)) +
      (c === actual.categoria && actual.catSugerida ? ' (sugerida)' : '') + '</button>';
  }
  let html = '';
  if (sugCats.length) {
    html += '<div class="muted" style="width:100%">Sugeridas:</div>' + sugCats.map(chip).join('') +
      '<button class="enlace" id="p-ver-cats" style="width:100%;text-align:left">' + (actual.verTodasCats ? 'Ocultar el resto' : 'Ver todas las categorías') + '</button>';
    if (actual.verTodasCats || (actual.categoria && sugCats.indexOf(actual.categoria) < 0)) {
      html += todas.filter(function (c) { return sugCats.indexOf(c) < 0; }).map(chip).join('');
    }
  } else {
    html = todas.map(chip).join('');
  }
  $('p-categorias').innerHTML = html;
  const ver = $('p-ver-cats');
  if (ver) ver.onclick = function () { actual.verTodasCats = !actual.verTodasCats; pintarCategoriasFicha(); };
  cada($('p-categorias').querySelectorAll('.chip'), function (b) {
    b.onclick = function () {
      actual.categoria = b.dataset.c;
      actual.catSugerida = false;
      pintarCategoriasFicha();
      pintarCabeceraProducto();
      if (!actual.lineaTocada) pintarLineas(''); else pintarLineas();
    };
  });
  pintarCabeceraProducto();
}

function ponerTipoProducto(t) {
  actual.tipoProducto = t;
  $('p-consumible').classList.toggle('activo', t === 'CONSUMIBLE');
  $('p-equipo').classList.toggle('activo', t === 'EQUIPO');
  pintarCabeceraProducto();
}

function pintarUbicaciones(preferida) {
  const est = $('f-almacen').value;
  $('f-sitio').textContent = '📍 ' + est + ' · ' + (modoActual() === 'MATERIAL' ? 'Material' : 'Despensa') + ' (se cambia en la pantalla principal)';
  const ubis = ubicacionesDe(est);
  $('f-estante-caja').classList.toggle('oculto', !ubis.length);
  if (!ubis.length) { opciones($('f-estante'), []); return; }
  opciones($('f-estante'), ubis);
  $('f-estante').value = ubis.indexOf(preferida) >= 0 ? preferida : ubis[0];
}

// Líneas de objetivo: solo las de la estancia y la categoría del producto, ordenadas por parecido.
function pintarLineas(valor) {
  const sel = $('p-linea');
  const est = $('f-almacen').value;
  let elegido = valor !== undefined ? valor : sel.value;
  if (elegido === '__todas') { actual.verTodasLineas = true; elegido = ''; }
  const delSitio = objetivos.filter(function (o) { return o.almacen === est; });
  const propias = delSitio.filter(function (o) { return !actual.categoria || o.categoria === actual.categoria; })
    .map(function (o) { return { o: o, p: puntuarLinea(o) }; })
    .sort(function (a, b) { return b.p - a.p || String(a.o.descripcion).localeCompare(String(b.o.descripcion)); });
  const otras = actual.verTodasLineas ? delSitio.filter(function (o) { return actual.categoria && o.categoria !== actual.categoria; }) : [];

  // Sugerir la más parecida si el usuario no ha elegido ninguna
  let sugerida = '';
  if (!elegido && !actual.lineaTocada && propias.length && (propias[0].p > 0 || propias.length === 1)) {
    elegido = propias[0].o.id;
    sugerida = elegido;
  }
  let html = '<option value="">' + (objetivos.length ? '— Ninguno —' : '— Sin objetivos descargados —') + '</option>';
  html += propias.map(function (x) {
    return '<option value="' + esc(x.o.id) + '">' + esc(x.o.descripcion) + (x.o.id === sugerida ? ' (sugerida)' : '') + '</option>';
  }).join('');
  if (otras.length) {
    html += '<optgroup label="Otras categorías">' + otras.map(function (o) {
      return '<option value="' + esc(o.id) + '">' + esc(bonito(o.categoria)) + ' · ' + esc(o.descripcion) + '</option>';
    }).join('') + '</optgroup>';
  }
  if (elegido && !delSitio.some(function (o) { return o.id === elegido; })) {
    const o = objetivos.find(function (x) { return x.id === elegido; });
    html += '<option value="' + esc(elegido) + '">' + esc(o ? o.almacen + ' · ' + o.descripcion : elegido) + '</option>';
  }
  if (!actual.verTodasLineas && delSitio.length > propias.length) html += '<option value="__todas">Ver otras categorías…</option>';
  sel.innerHTML = html;
  sel.value = elegido || '';
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

function cambiarTipo(tipo) {
  tipoActual = tipo;
  $('f-entrada').classList.toggle('activo', tipo === 'ENTRADA');
  $('f-salida').classList.toggle('activo', tipo === 'SALIDA');
  $('f-salida').classList.toggle('salida', tipo === 'SALIDA');
  const delGrupo = estanciasDelGrupo(grupoActual());
  const lotes = tipo === 'SALIDA' ? lotesDe(actual.codigo).filter(function (l) { return delGrupo.indexOf(l.almacen) >= 0; }) : [];
  $('f-lotes-caja').classList.toggle('oculto', !lotes.length);
  $('f-lotes').innerHTML = lotes.map(function (l, i) {
    return '<button class="chip" data-i="' + i + '">' + esc(l.caducidad || 'sin cad.') + ' · ' +
      esc(l.almacen) + (l.estante ? ' ' + esc(l.estante) : '') + ' · ' + l.stock + ' uds</button>';
  }).join('');
  cada($('f-lotes').children, function (b) {
    b.onclick = function () { elegirLote(lotes[Number(b.dataset.i)], b); };
  });
  if (lotes.length) elegirLote(lotes[0], $('f-lotes').children[0]); // el que caduca antes
}

function elegirLote(l, boton) {
  cada($('f-lotes').children, function (b) { b.classList.remove('activo'); });
  boton.classList.add('activo');
  const partes = (l.caducidad || '').split('-');
  ponerCaducidad(partes[0] || '', partes[1] || '');
  if (l.almacen) $('f-almacen').value = l.almacen;
  pintarUbicaciones(l.estante);
  if (l.estante && $('f-estante').value !== l.estante) {
    // ubicación antigua que ya no está en la lista
    opcionesConValor($('f-estante'), ubicacionesDe(l.almacen), l.estante);
    $('f-estante-caja').classList.remove('oculto');
  }
}

function cambiarCantidad(d) {
  $('f-cantidad').value = Math.max(1, (parseInt($('f-cantidad').value, 10) || 1) + d);
}

/* ---------- Caducidad con botones ---------- */
function montarCaducidad() {
  const y = new Date().getFullYear();
  const anios = [''];
  for (let i = 0; i <= 6; i++) anios.push(String(y + i));
  $('f-anios').innerHTML = anios.map(function (a) {
    return '<button class="chip" data-a="' + a + '">' + (a || 'Sin cad.') + '</button>';
  }).join('');
  cada($('f-anios').children, function (b) {
    b.onclick = function () { ponerCaducidad(b.dataset.a, b.dataset.a ? cadMes : ''); };
  });
  const nombres = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  $('f-meses').innerHTML = nombres.map(function (n, i) {
    return '<button data-m="' + String(i + 1).padStart(2, '0') + '">' + n + '</button>';
  }).join('');
  cada($('f-meses').children, function (b) {
    b.onclick = function () { ponerCaducidad(cadAnio, b.dataset.m); };
  });
}

function ponerCaducidad(anio, mes) {
  if (anio && !$('f-anios').querySelector('[data-a="' + anio + '"]')) {
    const b = document.createElement('button');
    b.className = 'chip'; b.dataset.a = anio; b.textContent = anio;
    b.onclick = function () { ponerCaducidad(anio, cadMes); };
    $('f-anios').appendChild(b);
  }
  cadAnio = anio || '';
  cadMes = cadAnio ? (mes || '') : '';
  cada($('f-anios').children, function (b) { b.classList.toggle('activo', b.dataset.a === cadAnio); });
  cada($('f-meses').children, function (b) { b.classList.toggle('activo', b.dataset.m === cadMes); });
  $('f-meses').classList.toggle('desactivado', !cadAnio);
  $('f-cad-texto').textContent = !cadAnio ? 'sin caducidad' : (cadMes ? cadMes + '/' + cadAnio : cadAnio + ' (falta el mes)');
}

/* ---------- Guardar ---------- */
function fichaFormulario() {
  const contenido = $('p-contenido').value.trim();
  return {
    codigo: actual.codigo,
    nombre: $('p-nombre').value.trim(),
    marca: $('p-marca').value.trim(),
    categoria: actual.categoria || '',
    tipo: actual.tipoProducto,
    contenido: contenido === '' ? '' : Number(contenido.replace(',', '.')),
    unidad: contenido === '' ? '' : $('p-unidad').value,
    linea_objetivo: $('p-linea').value,
    foto_url: actual.fotoUrl || ''
  };
}

// Valida la ficha y guarda en cola los campos que han cambiado. Devuelve false si falta algo.
async function guardarFicha() {
  const ficha = fichaFormulario();
  if (actual.sinCodigo && !ficha.nombre) { toast('Un artículo sin código necesita nombre'); $('f-ficha').classList.remove('oculto'); return false; }
  if (ficha.contenido !== '' && !(ficha.contenido > 0)) { toast('El contenido debe ser un número mayor que 0'); return false; }
  const antes = catalogo[actual.codigo] || {};
  const cambios = {};
  ['nombre', 'marca', 'categoria', 'tipo', 'contenido', 'unidad', 'linea_objetivo', 'foto_url'].forEach(function (k) {
    const nuevo = ficha[k], viejo = antes[k] === undefined || antes[k] === null ? '' : antes[k];
    if (nuevo !== '' && String(nuevo) !== String(viejo)) cambios[k] = nuevo;
  });
  if (!actual.existe && !('tipo' in cambios)) cambios.tipo = ficha.tipo;
  if (Object.keys(cambios).length) {
    prodPend[actual.codigo] = Object.assign({ codigo: actual.codigo }, prodPend[actual.codigo] || {}, cambios);
    catalogo[actual.codigo] = Object.assign({ codigo: actual.codigo }, antes, cambios);
    await idb.poner('kv', prodPend, 'prodPend');
    await idb.poner('kv', catalogo, 'catalogo');
  }
  return true;
}

async function guardarSoloFicha() {
  if (!(await guardarFicha())) return;
  toast('Ficha guardada: ' + nombreDe(actual.codigo));
  if (actual.desdeBuscar) { mostrar('buscar'); pintarBuscar(); } else mostrar('inicio');
  await refrescarEstado();
  sincronizar(false);
}

async function guardarMovimiento(seguir) {
  const cantidad = parseInt($('f-cantidad').value, 10);
  if (!cantidad || cantidad < 1) { toast('La cantidad debe ser 1 o más'); return; }
  if (cadAnio && !cadMes) { toast('Elige también el mes de caducidad'); return; }
  const almacen = $('f-almacen').value;
  const estante = $('f-estante-caja').classList.contains('oculto') ? '' : $('f-estante').value;
  const caducidad = cadAnio ? cadAnio + '-' + cadMes : '';
  if (tipoActual === 'SALIDA') {
    // No dejar sacar más de lo que hay en ese lote (evita stock negativo)
    pendientesCache = await idb.todos('pendientes');
    const lote = lotesDe(actual.codigo).find(function (l) {
      return (l.caducidad || '') === caducidad && (l.almacen || '') === almacen && (l.estante || '') === estante;
    });
    const hay = lote ? lote.stock : 0;
    if (!hay) { toast('No consta stock de ese lote aquí. Si lo hay de verdad, registra antes la entrada.', 4500); return; }
    if (cantidad > hay) { toast('En ese lote solo constan ' + hay + ' uds.', 4000); return; }
  }
  if (!(await guardarFicha())) return;

  const mov = {
    id: (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2)),
    fecha: new Date().toISOString(),
    usuario: ajustes.usuario || '',
    tipo: tipoActual,
    codigo: actual.codigo,
    cantidad: cantidad,
    caducidad: caducidad,
    almacen: almacen,
    estante: estante,
    nota: $('f-nota').value.trim()
  };
  await idb.poner('pendientes', mov);
  await idb.poner('historial', Object.assign({}, mov, { nombre: nombreDe(mov.codigo), estado: 'pendiente' }));

  if (mov.tipo === 'ENTRADA') ultimaCad[mov.codigo] = mov.caducidad;
  ajustes.ultimoAlmacen = mov.almacen;
  if (mov.estante) ajustes.ultimoEstante = mov.estante;
  if (mov.tipo === 'ENTRADA') {
    ajustes.sitioPorCodigo = ajustes.sitioPorCodigo || {};
    ajustes.sitioPorCodigo[mov.codigo] = { almacen: mov.almacen, estante: mov.estante };
  }
  await guardarAjustesLocales();

  toast((mov.tipo === 'ENTRADA' ? 'Entrada' : 'Salida') + ' guardada: ' + cantidad + ' × ' + nombreDe(mov.codigo));
  if (seguir) { ignorarCodigo = mov.codigo; ignorarHasta = Date.now() + 3000; abrirEscaner(); } else mostrar('inicio');
  await refrescarEstado();
  await pintarHistorial();
  sincronizar(false);
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

function htmlLote(l, conSitio) {
  const p = catalogo[l.codigo] || {};
  const e = p.tipo === 'EQUIPO' ? '' : estadoCaducidad(l.caducidad);
  return '<span class="' + e + '">' + esc(l.caducidad || 'sin cad.') + (e === 'caducado' ? ' (caducado)' : '') + '</span>' +
    (conSitio ? ' · ' + esc(l.almacen) + (l.estante ? ' · ' + esc(l.estante) : '') : '') + ' · ' + l.stock + ' uds';
}

function pintarStock() {
  ['producto', 'categoria', 'estancia'].forEach(function (v) { $('s-v-' + v).classList.toggle('activo', v === vistaStock); });
  const porCodigo = lotesTodos(pendientesCache);
  const q = $('s-buscar').value.trim().toLowerCase();
  const g = grupoActual(), modo = modoActual(), delGrupo = estanciasDelGrupo(g);
  $('s-filtro').textContent = stockFiltrado ? '📍 Solo ' + g + ' · ' + (modo === 'MATERIAL' ? 'Material' : 'Despensa') + '  (tocar para ver todo)' : 'Viendo todo (tocar para filtrar)';
  $('s-filtro').classList.toggle('activo', stockFiltrado);

  // Filas planas: un lote por fila
  const lotes = [];
  Object.keys(porCodigo).forEach(function (c) {
    const p = catalogo[c] || {};
    const texto = ((p.nombre || '') + ' ' + (p.marca || '') + ' ' + c).toLowerCase();
    if (q && texto.indexOf(q) < 0) return;
    if (stockFiltrado && p.categoria && modoDe(p.categoria) && modoDe(p.categoria) !== modo) return;
    porCodigo[c].forEach(function (l) {
      if (stockFiltrado && delGrupo.indexOf(l.almacen) < 0) return;
      lotes.push(Object.assign({ codigo: c }, l));
    });
  });

  const productos = {};
  lotes.forEach(function (l) { productos[l.codigo] = true; });
  const caducados = lotes.filter(function (l) {
    return (catalogo[l.codigo] || {}).tipo !== 'EQUIPO' && estadoCaducidad(l.caducidad) === 'caducado';
  }).length;
  $('s-resumen').textContent = Object.keys(productos).length + ' productos' + (caducados ? ' · ⚠️ ' + caducados + ' lotes caducados' : '') +
    (ajustes.ultimaSync ? ' · datos de ' + new Date(ajustes.ultimaSync).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');

  if (!lotes.length) { $('s-lista').innerHTML = '<p class="muted">' + (q ? 'Nada coincide con la búsqueda.' : 'No hay stock registrado.') + '</p>'; return; }

  function tarjetaProducto(codigo, susLotes, conSitio) {
    const p = catalogo[codigo] || {};
    const total = susLotes.reduce(function (s, l) { return s + l.stock; }, 0);
    return '<div class="prod" data-c="' + esc(codigo) + '"><div class="prod-cab"><span>' + esc(p.nombre || '(sin nombre)') +
      (p.marca ? ' <span class="muted">· ' + esc(p.marca) + '</span>' : '') +
      (p.tipo === 'EQUIPO' ? ' <span class="tag-cat tag-equipo">Equipo</span>' : '') +
      '</span><span class="prod-total">' + total + '</span></div>' +
      susLotes.map(function (l) { return '<div class="lote">' + htmlLote(l, conSitio) + '</div>'; }).join('') + '</div>';
  }
  function agruparPor(lista, clave) {
    const g = {};
    lista.forEach(function (l) { const k = clave(l); (g[k] = g[k] || []).push(l); });
    return g;
  }
  function porProducto(lista, conSitio) {
    const g = agruparPor(lista, function (l) { return l.codigo; });
    return Object.keys(g).sort(function (a, b) { return nombreDe(a).localeCompare(nombreDe(b), 'es'); })
      .map(function (c) { return tarjetaProducto(c, g[c], conSitio); }).join('');
  }

  let html = '';
  if (vistaStock === 'producto') {
    html = porProducto(lotes, true);
  } else if (vistaStock === 'categoria') {
    const orden = categorias();
    const g = agruparPor(lotes, function (l) { return (catalogo[l.codigo] || {}).categoria || 'SIN CATEGORÍA'; });
    Object.keys(g).sort(function (a, b) {
      const ia = orden.indexOf(a), ib = orden.indexOf(b);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b);
    }).forEach(function (cat) {
      html += '<div class="grupo">' + esc(bonito(cat)) + '</div>' + porProducto(g[cat], true);
    });
  } else {
    const ordenE = estancias();
    const g = agruparPor(lotes, function (l) { return l.almacen + '|' + (l.estante || ''); });
    Object.keys(g).sort(function (a, b) {
      const pa = a.split('|'), pb = b.split('|');
      const ia = ordenE.indexOf(pa[0]), ib = ordenE.indexOf(pb[0]);
      if (ia !== ib) return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
      const ua = ubicacionesDe(pa[0]), ja = ua.indexOf(pa[1]), jb = ua.indexOf(pb[1]);
      return (ja < 0 ? 999 : ja) - (jb < 0 ? 999 : jb) || pa[1].localeCompare(pb[1]);
    }).forEach(function (k) {
      const p = k.split('|');
      html += '<div class="grupo">' + esc(p[0]) + (p[1] ? ' · ' + esc(p[1]) : '') + '</div>' + porProducto(g[k], false);
    });
  }
  $('s-lista').innerHTML = html;
  cada($('s-lista').querySelectorAll('.prod'), function (d) {
    d.onclick = function () { abrirFormulario(d.dataset.c, { salida: true }); };
  });
}

/* ---------- Buscar producto (sin código / etiqueta rota / sin stock) ---------- */
async function abrirBuscar() {
  pendientesCache = await idb.todos('pendientes');
  $('b-buscar').value = '';
  mostrar('buscar');
  pintarBuscar();
}

function pintarBuscar() {
  const q = normalizar($('b-buscar').value);
  const porCodigo = lotesTodos(pendientesCache);
  const modo = modoActual();
  $('b-solo-incompletos').classList.toggle('activo', soloIncompletos);
  const lista = Object.keys(catalogo).map(function (c) { return catalogo[c]; }).filter(function (p) {
    const falta = !p.nombre || !p.categoria;
    if (soloIncompletos) return falta && (!q || normalizar((p.nombre || '') + ' ' + p.codigo).indexOf(q) >= 0);
    const m = p.categoria ? modoDe(p.categoria) : '';
    if (!q && m && m !== modo) return false; // sin búsqueda: solo los del modo actual
    return !q || normalizar((p.nombre || '') + ' ' + (p.marca || '') + ' ' + p.codigo).indexOf(q) >= 0;
  }).sort(function (a, b) {
    const fa = !a.nombre || !a.categoria ? 0 : 1, fb = !b.nombre || !b.categoria ? 0 : 1; // primero los incompletos
    const ia = /^INT-/.test(a.codigo) ? 0 : 1, ib = /^INT-/.test(b.codigo) ? 0 : 1;
    return fa - fb || ia - ib || (a.nombre || '').localeCompare(b.nombre || '', 'es');
  }).slice(0, 80);
  $('b-lista').innerHTML = lista.length ? lista.map(function (p) {
    const total = (porCodigo[p.codigo] || []).reduce(function (s, l) { return s + l.stock; }, 0);
    const faltas = [!p.nombre ? 'nombre' : '', !p.categoria ? 'categoría' : ''].filter(String);
    return '<div class="prod" data-c="' + esc(p.codigo) + '"><div class="prod-cab"><span>' + esc(p.nombre || '(sin nombre)') +
      (p.marca ? ' <span class="muted">· ' + esc(p.marca) + '</span>' : '') + '</span><span class="prod-total">' + total + '</span></div>' +
      '<div class="lote">' + (/^INT-/.test(p.codigo) ? 'Sin código de barras' : esc(p.codigo)) + (p.categoria ? ' · ' + esc(bonito(p.categoria)) : '') +
      (faltas.length ? ' · <span class="pronto">⚠️ falta ' + faltas.join(' y ') + '</span>' : '') + '</div></div>';
  }).join('') : '<p class="muted">' + (soloIncompletos ? '✅ No queda ningún producto por completar.' : (q ? 'No hay productos con ese nombre. Si es nuevo, créalo abajo.' : 'Todavía no hay productos de este modo.')) + '</p>';
  cada($('b-lista').querySelectorAll('.prod'), function (d) {
    d.onclick = function () { abrirFormulario(d.dataset.c, { editar: true }); };
  });
}

/* ---------- Sincronización ---------- */
async function llamar(metodo, datos) {
  const ctrl = new AbortController();
  // El servidor puede tardar al consultar Open Food Facts o guardar fotos
  const t = setTimeout(function () { ctrl.abort(); }, metodo === 'POST' ? 60000 : 30000);
  try {
    let resp;
    if (metodo === 'GET') {
      const u = new URL(ajustes.url);
      u.searchParams.set('accion', datos.accion);
      u.searchParams.set('token', ajustes.token);
      resp = await fetch(u.toString(), { signal: ctrl.signal });
    } else {
      resp = await fetch(ajustes.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({}, datos, { token: ajustes.token })),
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

function aplicarDatos(d) {
  const nuevo = {};
  (d.productos || []).forEach(function (p) { nuevo[String(p.codigo)] = p; });
  // Las fichas editadas aún sin enviar mandan sobre lo descargado
  Object.keys(prodPend).forEach(function (c) { nuevo[c] = Object.assign({}, nuevo[c] || {}, prodPend[c]); });
  catalogo = nuevo;
  stockServidor = d.stock || [];
  if (Array.isArray(d.config) && d.config.length) listas = d.config;
  objetivos = d.objetivos || [];
}

async function sincronizar(manual) {
  if (!ajustes.url || !ajustes.token) return;
  if (sincronizando) { resincronizar = true; return; } // se repetirá al terminar la actual
  if (!navigator.onLine) {
    if (manual) toast('Sin conexión. Se sincronizará al volver la red.');
    return;
  }
  sincronizando = true;
  await refrescarEstado();
  try {
    const pendientes = await idb.todos('pendientes');
    pendientes.sort(function (a, b) { return a.fecha.localeCompare(b.fecha); });
    const fichas = Object.keys(prodPend).map(function (c) { return prodPend[c]; });
    // Compatibilidad con movimientos guardados por la v1 (llevaban la ficha dentro)
    pendientes.forEach(function (m) { if (m._producto && !prodPend[m.codigo]) fichas.push(m._producto); });

    const lotes = [];
    for (let i = 0; i < pendientes.length; i += 100) lotes.push(pendientes.slice(i, i + 100));
    if (!lotes.length && (fichas.length || Object.keys(fotosPend).length)) lotes.push([]);

    for (let i = 0; i < lotes.length; i++) {
      const movimientos = lotes[i].map(function (m) { const c = Object.assign({}, m); delete c._producto; return c; });
      const productos = i === 0 ? fichas : [];
      const r = await llamar('POST', { accion: 'movimientos', movimientos: movimientos, productos: productos });
      for (const id of r.aceptados) { await idb.borrar('pendientes', id); await marcarHistorial(id, 'ok'); }
      for (const x of r.rechazados) { await idb.borrar('pendientes', x.id); await marcarHistorial(x.id, 'rechazado: ' + x.motivo); }
      if (i === 0 && productos.length) {
        // Solo se borran las fichas enviadas que no se han vuelto a editar mientras tanto
        productos.forEach(function (f) { if (prodPend[f.codigo] === f) delete prodPend[f.codigo]; });
        await idb.poner('kv', prodPend, 'prodPend');
      }
    }

    // Fotos (después de las fichas, para que el producto ya exista en la hoja)
    for (const c of Object.keys(fotosPend)) {
      const dataUrl = fotosPend[c];
      await llamar('POST', { accion: 'foto', codigo: c, datos: dataUrl.split(',')[1] });
      if (fotosPend[c] === dataUrl) delete fotosPend[c];
      await idb.poner('kv', fotosPend, 'fotosPend');
    }

    const d = await llamar('GET', { accion: 'datos' });
    aplicarDatos(d);
    await idb.poner('kv', catalogo, 'catalogo');
    await idb.poner('kv', stockServidor, 'stock');
    await idb.poner('kv', listas, 'listas');
    await idb.poner('kv', objetivos, 'objetivos');

    ajustes.ultimaSync = new Date().toISOString();
    await guardarAjustesLocales();
    ultimoError = '';
    if (manual) toast('Sincronizado');
  } catch (e) {
    console.error(e);
    ultimoError = e.message;
    if (manual) toast('Error al sincronizar: ' + e.message, 4000);
  } finally {
    sincronizando = false;
    if (resincronizar) { resincronizar = false; setTimeout(function () { sincronizar(false); }, 500); }
    await refrescarEstado();
    await pintarHistorial();
    if (!$('pantalla-ajustes').classList.contains('oculto')) pintarListas();
    pintarContexto();
  }
}

/* ---------- Ajustes ---------- */
function abrirAjustes() {
  $('a-url').value = ajustes.url || '';
  $('a-token').value = ajustes.token || '';
  $('a-usuario').value = ajustes.usuario || '';
  $('a-resultado').textContent = '';
  pintarListas();
  mostrar('ajustes');
}

async function guardarAjustes() {
  const url = $('a-url').value.trim(), token = $('a-token').value.trim(), usuario = $('a-usuario').value.trim();
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) { toast('La dirección debe empezar por https://script.google.com y terminar en /exec', 4000); return; }
  if (!token) { toast('Falta el token'); return; }
  if (!usuario) { toast('Escribe tu nombre'); return; }
  ajustes.url = url; ajustes.token = token; ajustes.usuario = usuario;
  await guardarAjustesLocales();
  toast('Ajustes guardados');
  mostrar('inicio');
  sincronizar(true);
}

async function probarConexion() {
  const anterior = { url: ajustes.url, token: ajustes.token };
  ajustes.url = $('a-url').value.trim();
  ajustes.token = $('a-token').value.trim();
  $('a-resultado').textContent = 'Probando…';
  try {
    const r = await llamar('GET', { accion: 'ping' });
    $('a-resultado').textContent = '✅ Conexión correcta' + (r.version >= 2.2 ? '' : ' (servidor antiguo: actualiza Codigo.gs a la v2.2)') + '. Pulsa Guardar.';
  } catch (e) {
    $('a-resultado').textContent = '❌ ' + e.message;
  } finally {
    ajustes.url = anterior.url; ajustes.token = anterior.token;
  }
}

/* ---------- Editar listas ---------- */
function pintarListas() {
  ['CATEGORIA', 'ESTANCIA', 'UBICACION'].forEach(function (t) { $('l-t-' + t).classList.toggle('activo', t === tipoLista); });
  const conEstancia = tipoLista === 'UBICACION';
  $('l-estancia-caja').classList.toggle('oculto', !conEstancia);
  $('l-modo-caja').classList.toggle('oculto', tipoLista !== 'CATEGORIA');
  const modoL = $('l-modo').value;
  if (conEstancia) opcionesConValor($('l-estancia'), estancias(), $('l-estancia').value || estancias()[0]);
  const est = conEstancia ? $('l-estancia').value : '';
  const items = listas.filter(function (x) {
    if (x.tipo !== tipoLista) return false;
    if (conEstancia) return x.estancia === est;
    if (tipoLista === 'CATEGORIA') { const m = x.padre || x.estancia; return !m || m === modoL; }
    return true;
  });
  if (!listas.length) { $('l-items').innerHTML = '<p class="muted">Aún no se han descargado las listas. Sincroniza con conexión (y comprueba que el servidor está en la v2).</p>'; return; }
  $('l-items').innerHTML = items.length ? items.map(function (x, i) {
    return '<div class="lista-item' + (x.activo ? '' : ' inactivo') + '"><span>' + esc(tipoLista === 'CATEGORIA' ? bonito(x.valor) : x.valor) +
      '</span><button data-i="' + i + '">' + (x.activo ? 'Desactivar' : 'Activar') + '</button></div>';
  }).join('') : '<p class="muted">Lista vacía.</p>';
  cada($('l-items').querySelectorAll('button'), function (b) {
    b.onclick = function () {
      const x = items[Number(b.dataset.i)];
      cambiarLista({ op: x.activo ? 'desactivar' : 'activar', tipo: x.tipo, valor: x.valor, estancia: x.estancia, padre: x.padre || x.estancia });
    };
  });
}

async function anadirALista() {
  let valor = $('l-nuevo').value.trim();
  if (!valor) { toast('Escribe el nuevo valor'); return; }
  if (tipoLista === 'CATEGORIA') valor = valor.toUpperCase().replace(/\s+/g, '_');
  const padre = tipoLista === 'UBICACION' ? $('l-estancia').value : (tipoLista === 'CATEGORIA' ? $('l-modo').value : '');
  const ok = await cambiarLista({ op: 'añadir', tipo: tipoLista, valor: valor, estancia: padre, padre: padre });
  if (ok) $('l-nuevo').value = '';
}

async function cambiarLista(cambio) {
  if (!navigator.onLine) { toast('Editar listas necesita conexión'); return false; }
  try {
    const r = await llamar('POST', { accion: 'config', cambio: cambio });
    listas = r.config || listas;
    await idb.poner('kv', listas, 'listas');
    pintarListas();
    toast('Lista actualizada');
    return true;
  } catch (e) {
    toast('No se pudo guardar: ' + e.message, 4000);
    return false;
  }
}

iniciar().catch(function (e) { console.error(e); toast('Error al arrancar: ' + e.message, 5000); });
