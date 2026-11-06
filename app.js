'use strict';
/* =========================================================
 * DESPENSA — app del móvil (v2.0)
 * Escanear → guardar sin conexión → sincronizar con la Sheet
 * Listas (categorías, estancias, ubicaciones) vienen de la pestaña Config.
 * ========================================================= */

const VERSION = '2.8.2';
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
let revision = [];       // movimientos rechazados por el servidor: [{mov, motivo, fecha}]
let miniaturas = {};     // codigo -> foto pequeña guardada en el móvil (para verla siempre)
let sincronizando = false;
let ultimoError = '';
let actual = null;       // producto abierto en el formulario
let tipoActual = 'ENTRADA';
let cadAnio = '', cadMes = '';
const ultimaCad = {};
let pendientesCache = [];
let vistaStock = 'producto';
let tipoLista = 'CATEGORIA';
// Filtros de Stock: se inician con el contexto de Registrar al abrir la pestaña, pero no lo cambian
let stockGrupo = '', stockModo = 'TODO';
let resincronizar = false;
let soloIncompletos = false;
let soloCaducan = false;
const historialCache = {}; // codigo -> movimientos del servidor (para la ficha)
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

// ---------- Navegación y botón atrás de Android ----------
// Se mantiene una entrada "trampa" en el historial: el botón atrás la consume y la app decide a dónde volver.
let pantallaActual = 'inicio', origenFormulario = 'inicio', trampa = false;
function ponerTrampa() { if (!trampa) { try { history.pushState({ despensa: 1 }, ''); trampa = true; } catch (e) { /* sin historial */ } } }
function volverA(origen) {
  if (origen === 'revision') { mostrar('revision'); pintarRevision(); return; }
  if (origen === 'stock') abrirStock();
  else if (origen === 'objetivos') abrirObjetivos();
  else if (origen === 'buscar') { mostrar('buscar'); pintarBuscar(); }
  else mostrar('inicio');
}
function atras() {
  if ($('ficha-sheet').classList.contains('on')) { cerrarFicha(); ponerTrampa(); return; }
  switch (pantallaActual) {
    case 'inicio': return; // siguiente "atrás": sale de la app
    case 'formulario': volverA(origenFormulario); break;
    case 'informe': case 'objetivos': abrirStock(); break;
    case 'ajustes':
      if (!ajustes.url || !ajustes.token || !ajustes.usuario) { toast('Rellena y guarda los ajustes primero'); ponerTrampa(); return; }
      mostrar('inicio'); break;
    default: mostrar('inicio');
  }
}
window.addEventListener('popstate', function () { trampa = false; atras(); });

function mostrar(nombre) {
  pantallaActual = nombre;
  if (nombre !== 'inicio') ponerTrampa();
  ['inicio', 'escaner', 'formulario', 'ajustes', 'stock', 'buscar', 'informe', 'revision', 'objetivos'].forEach(function (p) {
    $('pantalla-' + p).classList.toggle('oculto', p !== nombre);
  });
  if (nombre !== 'escaner') pararEscaner();
  // Pestañas Registrar / Stock: visibles en esas dos pantallas, con el color de la activa
  const conPestanas = nombre === 'inicio' || nombre === 'stock';
  $('pestanas').classList.toggle('oculto', !conPestanas);
  $('pestanas').classList.toggle('stock', nombre === 'stock');
  $('cab').style.background = nombre === 'stock' ? '#8a5a2b' : '';
  $('t-inicio').classList.toggle('activo', nombre === 'inicio');
  $('t-stock').classList.toggle('activo', nombre === 'stock');
  if ($('ficha-sheet')) $('ficha-sheet').classList.remove('on');
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
function estanciasDelGrupo(g) { return estancias().filter(function (e) { return enGrupo(e, g); }); }
// ¿Esta estancia pertenece al grupo? (compara sin tildes, mayúsculas ni espacios de más)
function enGrupo(almacen, g) { return !!g && normalizar(grupoDe(almacen)) === normalizar(g); }
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
  revision = (await idb.get('kv', 'revision')) || [];
  miniaturas = (await idb.get('kv', 'miniaturas')) || {};

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
  $('h-sync').onclick = function () {
    toast((ajustes.ultimaSync ? 'Última sincronización: ' + new Date(ajustes.ultimaSync).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'Nunca sincronizado') +
      (ultimoError ? ' · Error: ' + ultimoError : ''), 3500);
    sincronizar(true);
  };
  $('fs-cerrar').onclick = cerrarFicha;
  $('ficha-sheet').onclick = function (e) { if (e.target === $('ficha-sheet')) cerrarFicha(); };
  $('fs-ant').onclick = function () { moverFicha(-1); };
  $('fs-sig').onclick = function () { moverFicha(1); };
  $('fs-entrada').onclick = function () { const c = fichaActual.codigo; cerrarFicha(); abrirFormulario(c); };
  $('fs-salida').onclick = function () { const c = fichaActual.codigo; cerrarFicha(); abrirFormulario(c, { salida: true }); };
  $('fs-editar').onclick = function () { const c = fichaActual.codigo; cerrarFicha(); abrirFormulario(c, { editar: true }); };
  // Deslizar a izquierda/derecha para pasar de producto
  let x0 = null;
  $('fs-card').addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; }, { passive: true });
  $('fs-card').addEventListener('touchend', function (e) {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (Math.abs(dx) > 60) moverFicha(dx < 0 ? 1 : -1);
  });
  ['DESPENSA', 'MATERIAL'].forEach(function (m) {
    $('c-' + m).onclick = async function () { ajustes.modo = m; await guardarAjustesLocales(); pintarContexto(); };
  });
  ['DESPENSA', 'MATERIAL', 'TODO'].forEach(function (m) {
    $('s-m-' + m).onclick = function () { stockModo = m; pintarStock(); };
  });
  $('l-modo').onchange = pintarListas;
  $('btn-sincronizar').onclick = function () { sincronizar(true); };
  $('btn-escanear').onclick = abrirEscaner;
  $('t-inicio').onclick = function () { mostrar('inicio'); };
  $('t-stock').onclick = function () { soloCaducan = false; stockGrupo = grupoActual(); stockModo = modoActual(); abrirStock(); };
  $('btn-buscar').onclick = function () { soloIncompletos = false; abrirBuscar(); };
  $('btn-incompletos').onclick = function () { soloIncompletos = true; abrirBuscar(); };
  $('btn-revision').onclick = abrirRevision;
  $('r-volver').onclick = function () { mostrar('inicio'); };
  $('btn-caducidades').onclick = function () { soloCaducan = true; stockGrupo = ''; stockModo = 'TODO'; abrirStock(); };
  $('s-caducan').onclick = function () { soloCaducan = !soloCaducan; pintarStock(); };
  $('s-informe').onclick = abrirInforme;
  $('s-objetivos').onclick = abrirObjetivos;
  $('o-volver').onclick = abrirStock;
  $('o-m-categorias').onclick = function () { objVista.modo = 'categorias'; pintarObjetivos(); };
  $('o-m-compra').onclick = function () { objVista.modo = 'compra'; pintarObjetivos(); };
  $('o-compartir').onclick = function () { compartirLista(false); };
  $('o-keep').onclick = function () { compartirLista(true); };
  $('o-copiar').onclick = copiarLista;
  $('i-volver').onclick = abrirStock;
  $('i-imprimir').onclick = function () {
    try { window.print(); } catch (e) { toast('Este navegador no deja imprimir desde la app. Ábrela en Chrome y usa ⋮ → Compartir → Imprimir.', 5000); }
  };
  [['i-a-sitio', 'alcance', 'sitio'], ['i-a-todo', 'alcance', 'todo'], ['i-g-estancia', 'agrupar', 'estancia'], ['i-g-categoria', 'agrupar', 'categoria'],
   ['i-l-todos', 'lotes', 'todos'], ['i-l-caducan', 'lotes', 'caducan']].forEach(function (x) {
    $(x[0]).onclick = function () { informe[x[1]] = x[2]; pintarInforme(); };
  });
  $('b-solo-incompletos').onclick = function () { soloIncompletos = !soloIncompletos; pintarBuscar(); };
  $('b-buscar').oninput = pintarBuscar;
  $('b-nuevo').onclick = function () { abrirFormulario(codigoInterno(), { sinCodigo: true, nombre: $('b-buscar').value.trim() }); };
  $('b-volver').onclick = function () { mostrar('inicio'); };
  // Buscador de inicio: letras → busca por nombre (trozos: "choco" encuentra chocolate, pochocones…);
  // un número largo → se trata como código de barras escrito a mano
  function buscarDesdeInicio() {
    const t = $('codigo-manual').value.trim();
    if (!t) { soloIncompletos = false; abrirBuscar(''); return; }
    $('codigo-manual').value = '';
    if (/^[\d\s-]{8,}$/.test(t)) { abrirFormulario(normalizarCodigo(t)); return; }
    soloIncompletos = false;
    abrirBuscar(t);
  }
  $('btn-codigo-manual').onclick = buscarDesdeInicio;
  $('codigo-manual').onkeydown = function (e) { if (e.key === 'Enter') buscarDesdeInicio(); };
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
  $('f-cancelar').onclick = function () { volverA(origenFormulario); };

  $('s-buscar').oninput = pintarStock;
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
// Nombre corto para los botones: "Trastero Ávila" → "Trastero", "Peugeot 5008" → "5008", "Mazda 3" se queda igual
function nombreCorto(g) {
  const w = String(g).split(/\s+/);
  if (w.length < 2) return g;
  const ult = w[w.length - 1];
  if (/^\d{3,}$/.test(ult)) return ult;
  if (/^\d{1,2}$/.test(ult)) return g;
  return w[0];
}
function pintarContexto() {
  const g = grupoActual();
  $('c-grupos').innerHTML = grupos().map(function (x) {
    return '<button class="' + (x === g ? 'activo' : '') + '" data-g="' + esc(x) + '" title="' + esc(x) + '">' + esc(nombreCorto(x)) + '</button>';
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
  // Pastilla de la cabecera; la tarjeta grande solo aparece si hay un error
  const total = pend.length + nFichas + nFotos;
  const pas = $('h-sync');
  pas.className = 'pastilla' + (ultimoError ? ' err' : (!online ? ' off' : (total ? ' pend' : '')));
  pas.textContent = sincronizando ? '🔄 Sincronizando' : ultimoError ? '⚠️ Error' : !online ? (total ? '📴 ' + total + ' pendientes' : '📴 Sin conexión') : total ? '⏳ ' + total + ' pendientes' : '✓ Al día';
  $('tarjeta-sync').classList.toggle('oculto', !ultimoError);
  // Aviso de caducidades (solo lo que se consume, en todas las estancias)
  let cad = 0, pronto = 0;
  const todos = lotesTodos(pend);
  Object.keys(todos).forEach(function (c) {
    if ((catalogo[c] || {}).tipo === 'EQUIPO') return;
    todos[c].forEach(function (l) { const e = estadoCaducidad(l.caducidad); if (e === 'caducado') cad++; else if (e === 'pronto') pronto++; });
  });
  $('btn-caducidades').classList.toggle('oculto', !(cad + pronto));
  $('btn-caducidades').textContent = '⏰ ' + [cad ? cad + (cad === 1 ? ' lote caducado' : ' lotes caducados') : '', pronto ? pronto + ' caduca' + (pronto === 1 ? '' : 'n') + ' en 3 meses' : ''].filter(String).join(' · ') + ' · Ver';
  $('btn-revision').classList.toggle('oculto', !revision.length);
  $('btn-revision').textContent = '⚠️ ' + revision.length + (revision.length === 1 ? ' movimiento rechazado' : ' movimientos rechazados') + ' · Revisar';
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
  const ultimo = h[0];
  const sePuedeDeshacer = ultimo && !ultimo.deshecho && !ultimo.esDeshacer && (ultimo.estado === 'ok' || ultimo.estado === 'pendiente');
  lista.innerHTML = h.slice(0, 25).map(function (m) {
    const icono = m.deshecho ? '↩️' : m.estado === 'ok' ? '✅' : (m.estado === 'pendiente' ? '⏳' : '⚠️');
    return '<li><div><span class="tag ' + esc(m.tipo) + '">' + esc(m.tipo) + '</span> ' +
      esc(m.cantidad) + ' × ' + esc((catalogo[m.codigo] && catalogo[m.codigo].nombre) || m.nombre || m.codigo) +
      '<div class="meta">' + esc(m.caducidad || 'sin cad.') + ' · ' + esc(m.almacen) + (m.estante ? ' · ' + esc(m.estante) : '') +
      ' · ' + new Date(m.fecha).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) +
      (m.estado !== 'ok' && m.estado !== 'pendiente' ? '<br><span class="error">' + esc(m.estado) + '</span>' : '') +
      (m.deshecho ? '<br><span class="muted">deshecho</span>' : '') + (m.esDeshacer ? '<br><span class="muted">corrección</span>' : '') +
      (m === ultimo && sePuedeDeshacer ? '<br><button class="deshacer" data-id="' + esc(m.id) + '">↩️ Deshacer</button>' : '') +
      '</div></div><div>' + icono + '</div></li>';
  }).join('');
  const b = lista.querySelector('.deshacer');
  if (b) b.onclick = function () {
    if (!b.classList.contains('confirmar')) {
      b.classList.add('confirmar'); b.textContent = '¿Seguro? Toca otra vez';
      setTimeout(function () { b.classList.remove('confirmar'); b.textContent = '↩️ Deshacer'; }, 3500);
      return;
    }
    deshacer(b.dataset.id);
  };
}

// Deshacer el último movimiento: si no se ha enviado, se borra; si ya se envió, se registra el contrario
async function deshacer(id) {
  const m = await idb.get('historial', id);
  if (!m) return;
  const pend = await idb.get('pendientes', id);
  if (pend) {
    await idb.borrar('pendientes', id);
    await idb.borrar('historial', id);
    toast('Movimiento anulado (no se había enviado)');
  } else {
    const contrario = m.tipo === 'ENTRADA' ? 'SALIDA' : 'ENTRADA';
    if (contrario === 'SALIDA') {
      pendientesCache = await idb.todos('pendientes');
      const lote = lotesDe(m.codigo).find(function (l) { return (l.caducidad || '') === (m.caducidad || '') && l.almacen === m.almacen && (l.estante || '') === (m.estante || ''); });
      if (!lote || lote.stock < m.cantidad) { toast('No se puede deshacer: ese lote ya no tiene esas unidades.', 4000); return; }
    }
    const mov = { id: (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2)),
      fecha: new Date().toISOString(), usuario: ajustes.usuario || '', tipo: contrario, codigo: m.codigo, cantidad: m.cantidad,
      caducidad: m.caducidad || '', almacen: m.almacen, estante: m.estante || '', nota: 'Deshacer movimiento del ' + new Date(m.fecha).toLocaleString('es-ES') };
    await idb.poner('pendientes', mov);
    await idb.poner('historial', Object.assign({}, mov, { nombre: nombreDe(mov.codigo), estado: 'pendiente', esDeshacer: true }));
    m.deshecho = true;
    await idb.poner('historial', m);
    toast('Deshecho: se ha registrado una ' + (contrario === 'SALIDA' ? 'salida' : 'entrada') + ' de ' + m.cantidad);
  }
  delete historialCache[m.codigo];
  await refrescarEstado();
  await pintarHistorial();
  sincronizar(false);
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
  // De dónde venimos, para volver allí al guardar, cancelar o pulsar atrás
  if (['stock', 'buscar', 'inicio', 'objetivos'].indexOf(pantallaActual) >= 0) origenFormulario = pantallaActual;
  else if (pantallaActual === 'escaner') origenFormulario = 'inicio';
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
  let sitio = (ajustes.sitioPorCodigo || {})[codigo] || {};
  // Si no hay un sitio recordado, se usa dónde ya hay stock de ese producto en este grupo
  if (!sitio.almacen || delGrupo.indexOf(sitio.almacen) < 0) {
    const l = lotesDe(codigo).find(function (x) { return enGrupo(x.almacen, grupoActual()); });
    if (l) sitio = { almacen: l.almacen, estante: l.estante };
  }
  const preferida = [sitio.almacen, ajustes.ultimoAlmacen].find(function (e) { return e && delGrupo.indexOf(e) >= 0; }) || delGrupo[0];
  opciones($('f-almacen'), delGrupo);
  $('f-almacen').value = preferida;
  $('f-almacen-caja').classList.toggle('oculto', delGrupo.length < 2);
  pintarUbicaciones(sitio.almacen === preferida && sitio.estante ? sitio.estante : (ajustes.ultimoEstante || ''));
  pintarLineas(p.linea_objetivo || '');

  const total = lotesDe(codigo).reduce(function (s, l) { return s + l.stock; }, 0);
  $('f-stock').textContent = actual.existe ? 'En stock (según el último dato): ' + total : '';

  cambiarTipo(op.salida ? 'SALIDA' : 'ENTRADA');
  actual.corregir = op.corregir || null;
  if (op.corregir) {
    const m = op.corregir.mov;
    $('f-cantidad').value = m.cantidad;
    $('f-nota').value = m.nota || '';
    const pc = (m.caducidad || '').split('-');
    ponerCaducidad(pc[0] || '', pc[1] || '');
    if (m.almacen) opcionesConValor($('f-almacen'), estanciasDelGrupo(grupoActual()), m.almacen);
    pintarUbicaciones(m.estante || '');
    origenFormulario = 'revision';
  }
  mostrar('formulario');
  pintarFoto();
  $('f-off').textContent = op.corregir ? '⚠️ Corrigiendo un movimiento rechazado: ' + op.corregir.motivo : '';
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
  CONDIMENTOS: ['aceite', 'sal ', 'azucar', 'tomate', 'caldo', 'vinagre', 'especia', 'pimenton', 'oregano', 'pastilla de caldo'],
  SALSAS: ['salsa', 'mayonesa', 'ketchup', 'mostaza', 'alioli', 'barbacoa', 'tabasco', 'sriracha', 'kikkoman', 'teriyaki', 'pesto', 'guacamole'],
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
  CONDIMENTOS: ['oils', 'salts', 'sugars', 'tomato-sauces', 'broths', 'vinegars', 'spices'],
  SALSAS: ['mayonnaises', 'ketchup', 'mustards', 'soy-sauces', 'hot-sauces', 'barbecue-sauces', 'pestos'],
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
// Foto que se puede mostrar en el móvil: la propia (guardada aquí) o la de Open Food Facts
function fotoDe(codigo) {
  const p = catalogo[codigo] || {};
  return miniaturas[codigo] || fotosPend[codigo] || (p.foto_url && /openfoodfacts/.test(p.foto_url) ? p.foto_url : '');
}
// Si la foto está en Drive y este móvil no la tiene, se pide al servidor una vez
const pidiendoFoto = {};
async function traerMiniatura(codigo, alLlegar) {
  const p = catalogo[codigo] || {};
  if (miniaturas[codigo] || !p.foto_url || /openfoodfacts/.test(p.foto_url) || pidiendoFoto[codigo] || !navigator.onLine || !ajustes.url) return;
  pidiendoFoto[codigo] = true;
  try {
    const r = await llamar('GET', { accion: 'miniatura', codigo: codigo });
    miniaturas[codigo] = 'data:' + (r.tipo || 'image/jpeg') + ';base64,' + r.datos;
    await idb.poner('kv', miniaturas, 'miniaturas');
    if (alLlegar) alLlegar();
  } catch (e) { /* servidor antiguo o sin foto: se queda la portada simulada */ }
}

function pintarFoto() {
  const img = $('f-foto');
  const p = catalogo[actual.codigo] || {};
  const src = fotoDe(actual.codigo) || actual.fotoUrl;
  if (!src) traerMiniatura(actual.codigo, function () { if (actual && $('pantalla-formulario').classList.contains('oculto') === false) pintarFoto(); });
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
    miniaturas[actual.codigo] = await reducirImagen(archivo, 320, 0.7);
    await idb.poner('kv', miniaturas, 'miniaturas');
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
  const lotes = tipo === 'SALIDA' ? lotesDe(actual.codigo).filter(function (l) { return enGrupo(l.almacen, grupoActual()); }) : [];
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
  if (l.almacen) {
    const ests = estanciasDelGrupo(grupoActual());
    opcionesConValor($('f-almacen'), ests, l.almacen);
  }
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
  if (ficha.contenido !== '' && !(isFinite(ficha.contenido) && ficha.contenido > 0 && ficha.contenido < 100000)) { toast('El contenido debe ser un número entre 0 y 100000 (p. ej. 0,5)'); return false; }
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
  volverA(origenFormulario);
  await refrescarEstado();
  sincronizar(false);
}

async function guardarMovimiento(seguir) {
  const txtCant = String($('f-cantidad').value).trim();
  if (!/^\d+$/.test(txtCant)) { toast('La cantidad debe ser un número entero de unidades (sin decimales)'); return; }
  const cantidad = parseInt(txtCant, 10);
  if (cantidad > 9999) { toast('La cantidad máxima por movimiento es 9999'); return; }
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
  if (actual.corregir) {
    // El rechazado queda sustituido por este movimiento corregido
    const viejo = actual.corregir.mov.id;
    revision = revision.filter(function (x) { return x.mov.id !== viejo; });
    await idb.poner('kv', revision, 'revision');
    await marcarHistorial(viejo, 'corregido');
    actual.corregir = null;
  }

  if (mov.tipo === 'ENTRADA') ultimaCad[mov.codigo] = mov.caducidad;
  ajustes.ultimoAlmacen = mov.almacen;
  if (mov.estante) ajustes.ultimoEstante = mov.estante;
  if (mov.tipo === 'ENTRADA') {
    ajustes.sitioPorCodigo = ajustes.sitioPorCodigo || {};
    ajustes.sitioPorCodigo[mov.codigo] = { almacen: mov.almacen, estante: mov.estante };
  }
  await guardarAjustesLocales();

  toast((mov.tipo === 'ENTRADA' ? 'Entrada' : 'Salida') + ' guardada: ' + cantidad + ' × ' + nombreDe(mov.codigo));
  if (seguir) { ignorarCodigo = mov.codigo; ignorarHasta = Date.now() + 3000; abrirEscaner(); } else volverA(origenFormulario);
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

function pintarFiltrosStock() {
  $('s-grupos').innerHTML = ['<button class="' + (!stockGrupo ? 'activo' : '') + '" data-g="">Todas</button>'].concat(grupos().map(function (x) {
    return '<button class="' + (enGrupo(x, stockGrupo) ? 'activo' : '') + '" data-g="' + esc(x) + '" title="' + esc(x) + '">' + esc(nombreCorto(x)) + '</button>';
  })).join('');
  cada($('s-grupos').children, function (b) { b.onclick = function () { stockGrupo = b.dataset.g; pintarStock(); }; });
  ['DESPENSA', 'MATERIAL', 'TODO'].forEach(function (m) { $('s-m-' + m).classList.toggle('activo', stockModo === m); });
}

function pintarStock() {
  ['producto', 'categoria', 'estancia'].forEach(function (v) { $('s-v-' + v).classList.toggle('activo', v === vistaStock); });
  const porCodigo = lotesTodos(pendientesCache);
  const q = normalizar($('s-buscar').value);
  pintarFiltrosStock();
  $('s-caducan').classList.toggle('activo', soloCaducan);
  let total = 0, fueraSitio = 0, fueraModo = 0;

  // Filas planas: un lote por fila
  const lotes = [];
  Object.keys(porCodigo).forEach(function (c) {
    const p = catalogo[c] || {};
    const texto = normalizar((p.nombre || '') + ' ' + (p.marca || '') + ' ' + bonito(p.categoria || ''));
    if (q && texto.indexOf(q) < 0) return;
    const m = p.categoria ? modoDe(p.categoria) : '';
    porCodigo[c].forEach(function (l) {
      if (soloCaducan && (p.tipo === 'EQUIPO' || !estadoCaducidad(l.caducidad))) return;
      total++;
      if (stockGrupo && !enGrupo(l.almacen, stockGrupo)) { fueraSitio++; return; }
      if (stockModo !== 'TODO' && m && m !== stockModo) { fueraModo++; return; }
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

  if (!lotes.length) {
    // Explicar por qué sale vacío y ofrecer quitar el filtro
    let txt = q ? 'Nada coincide con la búsqueda.' : (soloCaducan ? 'No hay lotes que caduquen pronto.' : 'No hay stock registrado.');
    if (total) {
      const partes = [];
      if (fueraSitio) partes.push(fueraSitio + ' en otras estancias');
      if (fueraModo) partes.push(fueraModo + ' en ' + (stockModo === 'DESPENSA' ? 'Material' : 'Despensa'));
      txt = 'Con estos filtros no sale nada. Hay ' + total + ' lotes: ' + partes.join(' y ') + '.';
    }
    $('s-lista').innerHTML = '<p class="muted">' + esc(txt) + '</p>' + (total ? '<button class="btn btn-sec" id="s-ver-todo">Ver todo</button>' : '');
    if ($('s-ver-todo')) $('s-ver-todo').onclick = function () { stockGrupo = ''; stockModo = 'TODO'; pintarStock(); };
    return;
  }

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
    d.onclick = function () { abrirFicha(d.dataset.c, listaVisible('#s-lista')); };
  });
}

/* ---------- Ficha de producto (estilo biblioteca) ---------- */
const COLOR_CAT = { BEBIDA: '#2f7fa8', POTABILIZAR: '#3a8fb7', PLATOS_PREPARADOS: '#b5562b', CONSERVAS: '#5d6b3a', COCINAR: '#a07b2c',
  CONDIMENTOS: '#8a5a2b', SALSAS: '#b8452e', DESAYUNO: '#c0843a', SNACKS: '#7a2e3a', MENAJE_Y_GAS: '#4a5a6a', ENERGIA: '#c89b1e', HIGIENE: '#3d7a74',
  LIMPIEZA: '#4f6f9a', BOTIQUIN: '#a8323a' };
const ICONO_CAT = { BEBIDA: '💧', POTABILIZAR: '🫙', PLATOS_PREPARADOS: '🍲', CONSERVAS: '🥫', COCINAR: '🍚', CONDIMENTOS: '🧂', SALSAS: '🌶️',
  DESAYUNO: '☕', SNACKS: '🍫', MENAJE_Y_GAS: '🔥', ENERGIA: '🔋', HIGIENE: '🧼', LIMPIEZA: '🧽', BOTIQUIN: '🩹' };
let fichaActual = { codigo: '', lista: [] };

function partir(texto, max) {
  const lineas = []; let l = '';
  String(texto || '').split(/\s+/).forEach(function (w) {
    if ((l + ' ' + w).trim().length > max && l) { lineas.push(l); l = w; } else l = (l + ' ' + w).trim();
  });
  if (l) lineas.push(l);
  return lineas.slice(0, 4);
}
// Portada simulada cuando no hay foto: color e icono de la categoría y el nombre
function portadaSimulada(p) {
  const c = COLOR_CAT[p.categoria] || '#6b736c', ico = ICONO_CAT[p.categoria] || '📦';
  const lineas = partir(p.nombre || 'Sin nombre', 13).slice(0, 3);
  return '<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg"><rect width="120" height="120" fill="' + c + '"/>' +
    '<rect x="6" y="6" width="108" height="108" fill="none" stroke="#fff8"/>' +
    '<text x="60" y="44" text-anchor="middle" font-size="28">' + ico + '</text>' +
    lineas.map(function (t, i) { return '<text x="60" y="' + (66 + i * 13) + '" text-anchor="middle" font-family="Georgia,serif" font-size="11" fill="#fff">' + esc(t) + '</text>'; }).join('') +
    (p.marca && lineas.length < 3 ? '<text x="60" y="106" text-anchor="middle" font-family="Georgia,serif" font-style="italic" font-size="8" fill="#fffc">' + esc(p.marca) + '</text>' : '') + '</svg>';
}

function listaVisible(sel) {
  const vistos = [];
  cada(document.querySelectorAll(sel + ' .prod'), function (d) { if (vistos.indexOf(d.dataset.c) < 0) vistos.push(d.dataset.c); });
  return vistos;
}

async function abrirFicha(codigo, lista) {
  ponerTrampa();
  pendientesCache = await idb.todos('pendientes');
  fichaActual = { codigo: codigo, lista: lista && lista.length ? lista : [codigo] };
  pintarFicha('');
  $('ficha-sheet').classList.add('on');
}
function cerrarFicha() { $('ficha-sheet').classList.remove('on'); }
function moverFicha(d) {
  const i = fichaActual.lista.indexOf(fichaActual.codigo) + d;
  if (i < 0 || i >= fichaActual.lista.length) return;
  fichaActual.codigo = fichaActual.lista[i];
  pintarFicha(d > 0 ? 'in-r' : 'in-l');
}

function pintarFicha(anim) {
  const c = fichaActual.codigo;
  const p = catalogo[c] || { codigo: c };
  const lotes = lotesDe(c);
  const total = lotes.reduce(function (s, l) { return s + l.stock; }, 0);
  const sitios = [];
  lotes.forEach(function (l) { const k = l.almacen + (l.estante ? ' · ' + l.estante : ''); if (sitios.indexOf(k) < 0) sitios.push(k); });
  const obj = objetivos.find(function (o) { return o.id === p.linea_objetivo; });
  const foto = fotoDe(c);
  const contenido = p.contenido ? String(p.contenido).replace('.', ',') + ' ' + (p.unidad || '') : '';
  const faltas = [!p.nombre ? 'nombre' : '', !p.categoria ? 'categoría' : ''].filter(String);

  $('fs-cuerpo').innerHTML = '<div class="pf ' + (anim || '') + '" style="border-left-color:' + (COLOR_CAT[p.categoria] || 'var(--verde)') + '"><div class="pf-grid">' +
    '<div class="pf-cov">' + (foto ? '<img src="' + esc(foto) + '" alt="">' : portadaSimulada(p) + '<small>Sin foto</small>') + '</div>' +
    '<div><div class="pf-loc">' + (sitios.length ? esc(sitios[0]) + (sitios.length > 1 ? ' · +' + (sitios.length - 1) : '') : 'Sin stock') + '</div>' +
    '<h2>' + esc(p.nombre || '(sin nombre)') + '</h2>' +
    '<div class="pf-m">' + esc([p.marca, contenido].filter(Boolean).join(' · ')) + '</div>' +
    '<div class="pf-chips">' + (p.categoria ? '<span class="pf-chip t" style="background:' + (COLOR_CAT[p.categoria] || 'var(--verde)') + ';border-color:transparent">' + (ICONO_CAT[p.categoria] || '') + ' ' + esc(bonito(p.categoria)) + '</span>' : '') +
    '<span class="pf-chip">' + (p.tipo === 'EQUIPO' ? 'Equipo (no se gasta)' : 'Se consume') + '</span>' +
    (obj ? '<span class="pf-chip">🎯 ' + esc(obj.descripcion) + '</span>' : '') + '</div>' +
    '</div></div>' +
    '<div class="pf-stock"><b>' + total + '</b><span class="muted">unidades en total</span></div>' +
    (lotes.length ? lotes.map(function (l) {
      const e = p.tipo === 'EQUIPO' ? '' : estadoCaducidad(l.caducidad);
      return '<div class="pf-lote"><span>' + esc(l.almacen) + (l.estante ? ' · ' + esc(l.estante) : '') + ' — <b>' + l.stock + '</b></span>' +
        '<span class="cad ' + (l.caducidad ? e : 'sin') + '">' + (l.caducidad ? esc(l.caducidad.split('-').reverse().join('/')) + (e === 'caducado' ? ' · caducado' : '') : 'sin caducidad') + '</span></div>';
    }).join('') : '<div class="muted">No queda stock registrado.</div>') +
    (faltas.length ? '<div class="pf-aviso">⚠️ Falta ' + faltas.join(' y ') + ': pulsa «Editar ficha».</div>' : '') +
    '<div class="pf-hist" id="fs-hist"></div>' +
    '<div class="codigo" style="margin-top:8px;font-size:12px">' + (/^INT-/.test(c) ? 'Sin código de barras' : 'Código ' + esc(c)) + '</div></div>';
  pintarHistorialFicha(c);

  const i = fichaActual.lista.indexOf(c), n = fichaActual.lista.length;
  $('fs-cnt').textContent = n > 1 ? (i + 1) + ' de ' + n : '';
  $('fs-ant').disabled = i <= 0; $('fs-sig').disabled = i >= n - 1;
  $('fs-ant').parentNode.classList.toggle('oculto', n < 2);
  $('fs-salida').disabled = !total;
  if (!foto) traerMiniatura(c, function () { if (fichaActual.codigo === c && $('ficha-sheet').classList.contains('on')) pintarFicha(''); });
}

// Últimos movimientos del producto: los pendientes de este móvil + los del servidor (o el historial local si no hay red)
async function pintarHistorialFicha(c) {
  const local = (await idb.todos('historial')).filter(function (m) { return m.codigo === c; })
    .sort(function (a, b) { return b.fecha.localeCompare(a.fecha); });
  function fila(m) {
    const f = m.fecha ? new Date(m.fecha).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '';
    return '<div class="pf-mov"><span><span class="tag ' + esc(m.tipo) + '">' + esc(m.tipo) + '</span> ' + esc(m.cantidad) + ' · ' +
      esc(m.estante || m.almacen || '') + (m.caducidad ? ' · ' + esc(String(m.caducidad).split('-').reverse().join('/')) : '') +
      (m.estado === 'pendiente' ? ' ⏳' : '') + '</span><span class="muted">' + esc(f) + (m.usuario ? ' · ' + esc(m.usuario) : '') + '</span></div>';
  }
  function pintar(lista, nota) {
    if (fichaActual.codigo !== c || !$('fs-hist')) return;
    $('fs-hist').innerHTML = lista.length ? '<b>Últimos movimientos</b>' + lista.slice(0, 8).map(fila).join('') + (nota ? '<div class="muted" style="font-size:12px">' + nota + '</div>' : '') : '';
  }
  const pendientes = local.filter(function (m) { return m.estado === 'pendiente'; });
  if (historialCache[c]) { pintar(pendientes.concat(historialCache[c])); return; }
  pintar(local, local.length ? 'Movimientos hechos desde este móvil' : '');
  if (!navigator.onLine || !ajustes.url) return;
  try {
    const r = await llamar('GET', { accion: 'historial', codigo: c });
    historialCache[c] = r.movimientos || [];
    pintar(pendientes.concat(historialCache[c]));
  } catch (e) { /* servidor antiguo: se queda el historial local */ }
}

/* ---------- Bandeja de revisión: movimientos rechazados por el servidor ---------- */
function abrirRevision() { mostrar('revision'); pintarRevision(); }
function pintarRevision() {
  if (!revision.length) { $('r-lista').innerHTML = '<p class="muted">✅ No queda nada por revisar.</p>'; return; }
  $('r-lista').innerHTML = revision.map(function (x, i) {
    const m = x.mov;
    return '<div class="tarjeta"><div><span class="tag ' + esc(m.tipo) + '">' + esc(m.tipo) + '</span> <b>' + esc(m.cantidad) + ' × ' + esc(nombreDe(m.codigo)) + '</b></div>' +
      '<div class="muted">' + esc(m.caducidad || 'sin cad.') + ' · ' + esc(m.almacen) + (m.estante ? ' · ' + esc(m.estante) : '') + ' · ' +
      new Date(m.fecha).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + (m.usuario ? ' · ' + esc(m.usuario) : '') + '</div>' +
      '<div class="error" style="margin:6px 0">Motivo: ' + esc(x.motivo) + '</div>' +
      '<div class="fila"><button class="btn btn-sec" data-a="corregir" data-i="' + i + '">✏️ Corregir</button>' +
      '<button class="btn btn-sec" data-a="reintentar" data-i="' + i + '">🔄 Reintentar</button>' +
      '<button class="btn btn-peligro" data-a="descartar" data-i="' + i + '">🗑️ Descartar</button></div></div>';
  }).join('') + '<p class="muted" style="font-size:13px">«Reintentar» sirve si ya has corregido la causa (p. ej. registrando antes la entrada que faltaba).</p>';
  cada($('r-lista').querySelectorAll('button[data-a]'), function (b) {
    b.onclick = function () { accionRevision(b.dataset.a, Number(b.dataset.i)); };
  });
}
async function accionRevision(accion, i) {
  const x = revision[i];
  if (!x) return;
  if (accion === 'descartar') {
    revision.splice(i, 1);
    await idb.poner('kv', revision, 'revision');
    await marcarHistorial(x.mov.id, 'descartado: ' + x.motivo);
    toast('Movimiento descartado');
  } else if (accion === 'reintentar') {
    revision.splice(i, 1);
    await idb.poner('kv', revision, 'revision');
    await idb.poner('pendientes', x.mov);
    await marcarHistorial(x.mov.id, 'pendiente');
    toast('Se volverá a enviar');
    sincronizar(false);
  } else if (accion === 'corregir') {
    await abrirFormulario(x.mov.codigo, { salida: x.mov.tipo === 'SALIDA', corregir: x });
    return;
  }
  await refrescarEstado(); await pintarHistorial(); pintarRevision();
}

/* ---------- Informe imprimible (revisión mensual / PDF) ---------- */
const informe = { alcance: 'sitio', agrupar: 'estancia', lotes: 'todos' };
async function abrirInforme() {
  pendientesCache = await idb.todos('pendientes');
  mostrar('informe');
  pintarInforme();
}
function pintarInforme() {
  [['i-a-sitio', informe.alcance === 'sitio'], ['i-a-todo', informe.alcance === 'todo'], ['i-g-estancia', informe.agrupar === 'estancia'],
   ['i-g-categoria', informe.agrupar === 'categoria'], ['i-l-todos', informe.lotes === 'todos'], ['i-l-caducan', informe.lotes === 'caducan']]
    .forEach(function (x) { $(x[0]).classList.toggle('activo', x[1]); });
  const g = grupoActual(), modo = modoActual(), delGrupo = estanciasDelGrupo(g);
  const porCodigo = lotesTodos(pendientesCache);
  const filas = [];
  Object.keys(porCodigo).forEach(function (c) {
    const p = catalogo[c] || {};
    if (informe.alcance === 'sitio' && p.categoria && modoDe(p.categoria) && modoDe(p.categoria) !== modo) return;
    porCodigo[c].forEach(function (l) {
      if (informe.alcance === 'sitio' && !enGrupo(l.almacen, g)) return;
      const e = p.tipo === 'EQUIPO' ? '' : estadoCaducidad(l.caducidad);
      if (informe.lotes === 'caducan' && !e) return;
      filas.push({ codigo: c, nombre: p.nombre || '(sin nombre)', marca: p.marca || '', categoria: p.categoria || 'SIN CATEGORÍA',
                   almacen: l.almacen, estante: l.estante, caducidad: l.caducidad, stock: l.stock, estado: e, equipo: p.tipo === 'EQUIPO' });
    });
  });
  const clave = informe.agrupar === 'estancia'
    ? function (f) { return f.almacen + (f.estante ? ' · ' + f.estante : ''); }
    : function (f) { return bonito(f.categoria); };
  const grupos_ = {};
  filas.forEach(function (f) { (grupos_[clave(f)] = grupos_[clave(f)] || []).push(f); });
  const ordenEst = estancias();
  const nombresGrupo = Object.keys(grupos_).sort(function (a, b) {
    if (informe.agrupar === 'estancia') {
      const ia = ordenEst.indexOf(a.split(' · ')[0]), ib = ordenEst.indexOf(b.split(' · ')[0]);
      if (ia !== ib) return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    }
    return a.localeCompare(b, 'es', { numeric: true });
  });
  const cad = filas.filter(function (f) { return f.estado === 'caducado'; }).length;
  const pronto = filas.filter(function (f) { return f.estado === 'pronto'; }).length;
  const productos = {}; filas.forEach(function (f) { productos[f.codigo] = 1; });
  const fecha = new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const fmt = function (c) { return c ? c.split('-').reverse().join('/') : '—'; };
  $('informe-hoja').innerHTML = '<h1>Revisión de despensa</h1>' +
    '<div class="inf-meta">' + esc(fecha) + ' · ' + esc(informe.alcance === 'sitio' ? g + ' · ' + (modo === 'MATERIAL' ? 'Material' : 'Despensa') : 'Todas las estancias') +
    (informe.lotes === 'caducan' ? ' · solo lotes que caducan pronto' : '') + ' · datos de ' +
    esc(ajustes.ultimaSync ? new Date(ajustes.ultimaSync).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'este móvil') + '</div>' +
    '<div class="inf-res"><span><b>' + Object.keys(productos).length + '</b> productos</span><span><b>' + filas.length + '</b> lotes</span>' +
    (cad ? '<span class="x">' + cad + ' caducados</span>' : '') + (pronto ? '<span class="p">' + pronto + ' caducan en 3 meses</span>' : '') +
    '<span>Revisado por: ________________</span></div>' +
    (filas.length ? nombresGrupo.map(function (k) {
      const lista = grupos_[k].sort(function (a, b) { return a.nombre.localeCompare(b.nombre, 'es') || (a.caducidad || '9').localeCompare(b.caducidad || '9'); });
      const conDonde = informe.agrupar === 'categoria';
      const cols = conDonde ? ['31%', '14%', '24%', '7%', '11%', '13%'] : ['44%', '14%', '8%', '13%', '21%'];
      return '<h3>' + esc(k) + '</h3><table><colgroup>' + cols.map(function (w) { return '<col style="width:' + w + '">'; }).join('') + '</colgroup>' +
        '<thead><tr><th>Producto</th><th>Caduca</th>' + (conDonde ? '<th>Dónde</th>' : '') +
        '<th>Uds</th><th>Contado</th><th>Notas</th></tr></thead><tbody>' +
        lista.map(function (f) {
          return '<tr><td>' + esc(f.nombre) + (f.marca ? ' <span style="color:#555">· ' + esc(f.marca) + '</span>' : '') + (f.equipo ? ' <i>(equipo)</i>' : '') + '</td>' +
            '<td class="' + (f.estado === 'caducado' ? 'x' : f.estado === 'pronto' ? 'p' : '') + '">' + esc(fmt(f.caducidad)) + '</td>' +
            (informe.agrupar === 'categoria' ? '<td>' + esc(f.almacen + (f.estante ? ' · ' + f.estante : '')) + '</td>' : '') +
            '<td class="num">' + f.stock + '</td><td class="caja"></td><td></td></tr>';
        }).join('') + '</tbody></table>';
    }).join('') : '<p>No hay lotes con estos filtros.</p>');
}

/* ---------- Buscar producto (sin código / etiqueta rota / sin stock) ---------- */
/* ---------- Objetivos y lista de la compra (v2.8) ----------
 * La categoría agrupa; cada línea (TA-xx) se mide en su propia unidad.
 * Cuenta para una línea: los productos con esa línea en su ficha, o, si la categoría solo
 * tiene una línea en esa estancia, los productos de la categoría sin línea asignada.
 * Solo cuenta el stock de la estancia del objetivo. Lo caducado no cuenta; lo que caduca
 * en 3 meses sí cuenta, con aviso. */
const objVista = { almacen: '', modo: 'categorias', abiertas: {}, verSinLinea: false };
const UNIDADES_PESO = { kg: 1, g: 0.001 }, UNIDADES_VOLUMEN = { litros: 1, l: 1, ml: 0.001 };

function numero(v) { const n = Number(String(v == null ? '' : v).replace(',', '.').trim()); return isFinite(n) ? n : NaN; }
function formatoCant(n) { return (Math.round(n * 100) / 100).toLocaleString('es-ES', { maximumFractionDigits: 2 }); }
function mismoSitio(almacen, objetivoAlmacen) {
  return normalizar(almacen) === normalizar(objetivoAlmacen) || enGrupo(almacen, objetivoAlmacen);
}

// Cuánto aporta un envase de un producto a una línea, o null si no se puede saber (falta el contenido)
function aportePorEnvase(p, unidadObjetivo) {
  const uo = normalizar(unidadObjetivo), up = normalizar(p.unidad), c = numero(p.contenido);
  const tabla = uo in UNIDADES_PESO ? UNIDADES_PESO : uo in UNIDADES_VOLUMEN ? UNIDADES_VOLUMEN : null;
  if (tabla) return up in tabla && c > 0 ? c * tabla[up] / tabla[uo] : null;
  // Unidades contables (uds, rollos, paquetes…): un pack de 12 rollos con unidad «rollos» cuenta 12
  if (up === uo && up !== 'uds' && c > 0) return c;
  return 1;
}

function calcularObjetivos(porCodigo, almacen) {
  const lineas = objetivos.filter(function (o) { return o.id && mismoSitio(o.almacen, almacen); }).map(function (o) {
    const obj = numero(o.cantidad_objetivo);
    return { o: o, objetivo: obj > 0 ? obj : 0, tiene: 0, pronto: 0, caducado: 0, sinContenido: [], productos: [] };
  });
  const porId = {}, porCat = {};
  lineas.forEach(function (l) { porId[l.o.id] = l; (porCat[l.o.categoria] = porCat[l.o.categoria] || []).push(l); });
  const sinLinea = [];

  Object.keys(porCodigo).forEach(function (c) {
    const lotes = porCodigo[c].filter(function (l) { return mismoSitio(l.almacen, almacen); });
    if (!lotes.length) return;
    const p = catalogo[c] || { codigo: c };
    let linea = porId[p.linea_objetivo], automatica = false;
    if (!linea) {
      const cand = porCat[p.categoria] || [];
      if (cand.length === 1) { linea = cand[0]; automatica = true; }
    }
    const envases = lotes.reduce(function (s, l) { return s + l.stock; }, 0);
    if (!linea) {
      // Solo avisa si su categoría tiene líneas (varias) en esta estancia; si no tiene objetivos, se ignora
      if ((porCat[p.categoria] || []).length > 1 || !p.categoria) sinLinea.push({ codigo: c, envases: envases });
      return;
    }

    const equipo = p.tipo === 'EQUIPO';
    let validos = 0, pronto = 0, caducado = 0;
    lotes.forEach(function (l) {
      const e = equipo ? '' : estadoCaducidad(l.caducidad);
      if (e === 'caducado') caducado += l.stock; else { validos += l.stock; if (e === 'pronto') pronto += l.stock; }
    });
    const aporte = aportePorEnvase(p, linea.o.unidad);
    if (aporte === null) linea.sinContenido.push(c);
    const cant = aporte === null ? 0 : validos * aporte;
    linea.tiene += cant;
    linea.pronto += aporte === null ? 0 : pronto * aporte;
    linea.caducado += caducado;
    linea.productos.push({ codigo: c, envases: validos, cantidad: cant, caducado: caducado, pronto: pronto,
                           automatica: automatica, sinContenido: aporte === null });
  });

  lineas.forEach(function (l) {
    l.falta = l.objetivo ? Math.max(0, l.objetivo - l.tiene) : 0;
    l.completa = l.objetivo > 0 && l.falta < 1e-9;
    l.avance = l.objetivo ? Math.min(1, l.tiene / l.objetivo) : 0;
    l.productos.sort(function (a, b) { return b.cantidad - a.cantidad; });
  });
  // Categorías en el orden de la lista de Config; las que no estén, al final
  const orden = categorias();
  const cats = Object.keys(porCat).sort(function (a, b) {
    const ia = orden.indexOf(a), ib = orden.indexOf(b);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b);
  }).map(function (cat) {
    const ls = porCat[cat].slice().sort(function (a, b) { return String(a.o.id).localeCompare(String(b.o.id)); });
    const conObj = ls.filter(function (l) { return l.objetivo > 0; });
    return { categoria: cat, lineas: ls, conObjetivo: conObj.length,
             completas: conObj.filter(function (l) { return l.completa; }).length,
             avance: conObj.length ? conObj.reduce(function (s, l) { return s + l.avance; }, 0) / conObj.length : 0,
             sinLinea: sinLinea.filter(function (x) { return (catalogo[x.codigo] || {}).categoria === cat; }) };
  });
  return { lineas: lineas, categorias: cats, sinLinea: sinLinea };
}

function textoListaCompra(r, almacen) {
  const partes = [];
  r.categorias.forEach(function (c) {
    const faltan = c.lineas.filter(function (l) { return l.objetivo > 0 && !l.completa; });
    if (!faltan.length) return;
    partes.push((partes.length ? '\n' : '') + '*' + bonito(c.categoria) + '*');
    faltan.forEach(function (l) {
      partes.push('- ' + l.o.descripcion + ': faltan ' + formatoCant(l.falta) + ' ' + l.o.unidad +
        ' (hay ' + formatoCant(l.tiene) + ' de ' + formatoCant(l.objetivo) + ')');
    });
  });
  if (!partes.length) return '';
  return '🛒 Lista de la compra · ' + almacen + '\n' + new Date().toLocaleDateString('es-ES') + '\n\n' + partes.join('\n');
}

// Una línea por artículo, sin cabeceras: en Keep cada línea pasa a ser una casilla para marcar
function textoListaMarcar(r) {
  const filas = [];
  r.categorias.forEach(function (c) {
    c.lineas.forEach(function (l) {
      if (l.objetivo > 0 && !l.completa) filas.push(l.o.descripcion + ' — ' + formatoCant(l.falta) + ' ' + l.o.unidad);
    });
  });
  return filas.join('\n');
}

function almacenesObjetivos() {
  const v = [];
  objetivos.forEach(function (o) { if (o.almacen && v.indexOf(o.almacen) < 0) v.push(o.almacen); });
  return v;
}

async function abrirObjetivos() {
  pendientesCache = await idb.todos('pendientes');
  const alms = almacenesObjetivos();
  if (alms.indexOf(objVista.almacen) < 0) {
    objVista.almacen = alms.find(function (a) { return enGrupo(a, grupoActual()) || normalizar(grupoDe(a)) === normalizar(grupoActual()); }) || alms[0] || '';
  }
  mostrar('objetivos');
  pintarObjetivos();
}

function colorAvance(a) { return a >= 1 ? '#2e9d4b' : a >= 0.5 ? '#e0a43a' : '#c0573e'; }
function barra(a) { return '<div class="barra"><i style="width:' + Math.round(a * 100) + '%;background:' + colorAvance(a) + '"></i></div>'; }

function pintarObjetivos() {
  const alms = almacenesObjetivos();
  $('o-almacenes').innerHTML = alms.length > 1 ? alms.map(function (a) {
    return '<button class="chip' + (a === objVista.almacen ? ' activo' : '') + '" data-a="' + esc(a) + '">' + esc(a) + '</button>';
  }).join('') : '';
  cada($('o-almacenes').children, function (b) { b.onclick = function () { objVista.almacen = b.dataset.a; pintarObjetivos(); }; });
  ['categorias', 'compra'].forEach(function (m) { $('o-m-' + m).classList.toggle('activo', objVista.modo === m); });

  if (!objetivos.length) {
    $('o-resumen').textContent = 'No hay objetivos descargados. Rellena la pestaña Objetivos de la hoja y sincroniza.';
    $('o-lista').innerHTML = ''; $('o-compra').classList.add('oculto'); $('o-avisos').innerHTML = '';
    return;
  }
  const r = calcularObjetivos(lotesTodos(pendientesCache), objVista.almacen);
  const conObj = r.lineas.filter(function (l) { return l.objetivo > 0; });
  const completas = conObj.filter(function (l) { return l.completa; }).length;
  const sinCant = r.lineas.length - conObj.length;
  $('o-resumen').innerHTML = '<b>' + esc(objVista.almacen) + '</b> · ' + completas + ' de ' + conObj.length + ' líneas completas' +
    (sinCant ? ' · ' + sinCant + ' sin cantidad decidida' : '') +
    '<br><span style="font-size:13px">Solo cuenta lo guardado aquí. Lo caducado no cuenta.</span>';

  // Avisos: productos con stock aquí que no cuentan para ninguna línea
  const n = r.sinLinea.length;
  let av = '';
  if (n) {
    av = '<button class="chip" id="o-ver-sin">⚠️ ' + n + (n === 1 ? ' producto no cuenta' : ' productos no cuentan') +
      ' para ningún objetivo · ' + (objVista.verSinLinea ? 'Ocultar' : 'Ver') + '</button>';
    if (objVista.verSinLinea) {
      av += '<div class="tarjeta" style="margin-top:8px"><p class="muted" style="margin-top:0">Su categoría tiene varias líneas: toca cada uno y elige su «Línea de objetivo» en la ficha.</p>' +
        r.sinLinea.map(function (x) {
          const p = catalogo[x.codigo] || {};
          return '<div class="lista-item o-editar" data-c="' + esc(x.codigo) + '"><span>' + esc(p.nombre || x.codigo) +
            ' <span class="muted">· ' + esc(p.categoria ? bonito(p.categoria) : 'sin categoría') + ' · ' + x.envases + ' uds</span></span><button>Asignar</button></div>';
        }).join('') + '</div>';
    }
  }
  $('o-avisos').innerHTML = av;
  if ($('o-ver-sin')) $('o-ver-sin').onclick = function () { objVista.verSinLinea = !objVista.verSinLinea; pintarObjetivos(); };

  if (objVista.modo === 'compra') {
    const t = textoListaCompra(r, objVista.almacen);
    $('o-lista').innerHTML = '';
    $('o-compra').classList.remove('oculto');
    $('o-texto').textContent = t || '✅ No falta nada: todas las líneas con cantidad están completas.';
    objVista.textoMarcar = textoListaMarcar(r);
    $('o-compartir').disabled = !t; $('o-copiar').disabled = !t; $('o-keep').disabled = !t;
  } else {
    $('o-compra').classList.add('oculto');
    $('o-lista').innerHTML = r.categorias.map(function (c) {
      const abierta = !!objVista.abiertas[c.categoria];
      let h = '<div class="prod o-cat" style="border-left:5px solid ' + (COLOR_CAT[c.categoria] || 'var(--verde)') + '">' +
        '<div class="prod-cab o-cab" data-cat="' + esc(c.categoria) + '"><span>' + (ICONO_CAT[c.categoria] || '') + ' ' + esc(bonito(c.categoria)) + '</span>' +
        '<span class="muted">' + (c.conObjetivo ? c.completas + '/' + c.conObjetivo : 'sin cantidad') + ' ' + (abierta ? '▴' : '▾') + '</span></div>' +
        (c.conObjetivo ? barra(c.avance) : '');
      if (c.sinLinea.length) h += '<div class="lote pronto">⚠️ ' + c.sinLinea.length + ' sin línea asignada</div>';
      if (abierta) {
        h += c.lineas.map(function (l) {
          const avisos = [];
          if (l.pronto > 0) avisos.push('<span class="pronto">⏰ ' + formatoCant(l.pronto) + ' caducan en 3 meses</span>');
          if (l.caducado > 0) avisos.push('<span class="caducado">' + l.caducado + ' envases caducados (no cuentan)</span>');
          if (l.sinContenido.length) avisos.push('<span class="pronto">⚠️ ' + l.sinContenido.length + ' sin contenido por envase (no cuentan)</span>');
          return '<div class="o-linea"><div class="prod-cab" style="font-weight:500"><span>' + esc(l.o.descripcion) + '</span>' +
            '<span style="white-space:nowrap">' + (l.objetivo ? '<b>' + formatoCant(l.tiene) + '</b> / ' + formatoCant(l.objetivo) : '<span class="muted">sin cantidad</span>') +
            ' <span class="muted">' + esc(l.o.unidad) + '</span></span></div>' + (l.objetivo ? barra(l.avance) : '') +
            (avisos.length ? '<div class="lote">' + avisos.join(' · ') + '</div>' : '') +
            (l.productos.length ? '<div class="o-prods">' + l.productos.map(function (x) {
              const p = catalogo[x.codigo] || {};
              return '<button class="o-prod" data-c="' + esc(x.codigo) + '">' + esc(p.nombre || x.codigo) + ' · ' +
                (x.sinContenido ? '<span class="pronto">falta contenido</span>' : x.envases + ' env.' +
                  (normalizar(l.o.unidad) !== 'uds' && x.cantidad !== x.envases ? ' = ' + formatoCant(x.cantidad) + ' ' + esc(l.o.unidad) : '')) +
                (x.automatica ? ' <span class="muted">(por categoría)</span>' : '') + '</button>';
            }).join('') + '</div>' : '<div class="lote">Nada guardado todavía.</div>') + '</div>';
        }).join('');
        if (c.sinLinea.length) h += '<div class="lote">Sin línea: ' + c.sinLinea.map(function (x) {
          return '<button class="o-prod o-editar" data-c="' + esc(x.codigo) + '">' + esc((catalogo[x.codigo] || {}).nombre || x.codigo) + ' · asignar</button>';
        }).join('') + '</div>';
      }
      return h + '</div>';
    }).join('');
  }

  cada($('o-lista').querySelectorAll('.o-cab'), function (d) {
    d.onclick = function () { const k = d.dataset.cat; objVista.abiertas[k] = !objVista.abiertas[k]; pintarObjetivos(); };
  });
  cada(document.querySelectorAll('#pantalla-objetivos .o-prod:not(.o-editar)'), function (b) {
    b.onclick = function (ev) { ev.stopPropagation(); abrirFicha(b.dataset.c, [b.dataset.c]); };
  });
  cada(document.querySelectorAll('#pantalla-objetivos .o-editar'), function (b) {
    b.onclick = function (ev) { ev.stopPropagation(); abrirFormulario(b.dataset.c, { editar: true }); };
  });
}

async function compartirLista(paraMarcar) {
  const t = paraMarcar ? objVista.textoMarcar : $('o-texto').textContent;
  const titulo = 'Compra ' + objVista.almacen + ' ' + new Date().toLocaleDateString('es-ES');
  if (navigator.share) {
    try { await navigator.share({ title: titulo, text: t }); if (paraMarcar) toast('En Keep: pulsa ⊞ abajo a la izquierda → Casillas de verificación', 6000); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  if (paraMarcar) { copiarTexto(t); return; }
  window.open('https://wa.me/?text=' + encodeURIComponent(t), '_blank');
}
async function copiarLista() { copiarTexto($('o-texto').textContent); }
async function copiarTexto(t) {
  try { await navigator.clipboard.writeText(t); toast('Lista copiada'); }
  catch (e) { toast('No se pudo copiar: mantén pulsado el texto y cópialo a mano', 4000); }
}

async function abrirBuscar(texto) {
  pendientesCache = await idb.todos('pendientes');
  $('b-buscar').value = typeof texto === 'string' ? texto : '';
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
    return !q || normalizar((p.nombre || '') + ' ' + (p.marca || '') + ' ' + bonito(p.categoria || '')).indexOf(q) >= 0;
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
    d.onclick = function () {
      if (soloIncompletos) abrirFormulario(d.dataset.c, { editar: true });
      else abrirFicha(d.dataset.c, listaVisible('#b-lista'));
    };
  });
}

/* ---------- Sincronización ---------- */
// Todas las llamadas van por POST con la clave dentro del mensaje (nunca en la dirección).
// Si el servidor aún es antiguo (< 2.5) y no entiende una lectura por POST, se reintenta por GET.
const LECTURAS = ['ping', 'datos', 'catalogo', 'historial', 'miniatura'];
async function llamar(metodo, datos) {
  try {
    return await peticion('POST', datos);
  } catch (e) {
    if (e.message === 'accion desconocida' && LECTURAS.indexOf(datos.accion) >= 0) return await peticion('GET', datos);
    throw e;
  }
}

async function peticion(metodo, datos) {
  const ctrl = new AbortController();
  // El servidor puede tardar al consultar Open Food Facts o guardar fotos
  const t = setTimeout(function () { ctrl.abort(); }, datos.accion === 'movimientos' || datos.accion === 'foto' ? 60000 : 30000);
  try {
    let resp;
    if (metodo === 'GET') {
      const u = new URL(ajustes.url);
      u.searchParams.set('accion', datos.accion);
      if (datos.codigo) u.searchParams.set('codigo', datos.codigo);
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
    if (!json.ok) throw new Error(json.error === 'token' ? 'clave no válida o anulada' : (json.error || 'error del servidor'));
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
  // Servidor 2.6 o posterior: fecha de la última copia de seguridad de la hoja ('' = ninguna)
  if (d.ultimaCopia !== undefined) ajustes.ultimaCopia = d.ultimaCopia || '';
}

// Línea de Ajustes con el estado de la copia de seguridad semanal
function pintarCopia() {
  const el = $('a-copia');
  if (ajustes.ultimaCopia === undefined) { el.textContent = ''; return; } // servidor antiguo
  if (!ajustes.ultimaCopia) { el.textContent = '⚠️ Copia de seguridad: todavía no se ha hecho ninguna'; return; }
  const f = new Date(ajustes.ultimaCopia);
  const dias = Math.floor((Date.now() - f.getTime()) / 86400000);
  el.textContent = (dias > 8 ? '⚠️ ' : '') + 'Última copia de seguridad: ' + f.toLocaleDateString('es-ES') +
    (dias > 8 ? ' (hace ' + dias + ' días: revisa la copia semanal en Apps Script)' : '');
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
      for (const x of r.rechazados) {
        // No se pierde: va a la bandeja de revisión con el motivo y los datos originales
        const original = lotes[i].find(function (m) { return m.id === x.id; });
        if (original) { revision.push({ mov: Object.assign({}, original), motivo: x.motivo, fecha: new Date().toISOString() }); }
        await idb.borrar('pendientes', x.id);
        await marcarHistorial(x.id, 'rechazado: ' + x.motivo);
      }
      if (r.rechazados.length) await idb.poner('kv', revision, 'revision');
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

    Object.keys(historialCache).forEach(function (k) { delete historialCache[k]; });
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
    if (!$('pantalla-ajustes').classList.contains('oculto')) { pintarListas(); pintarCopia(); }
    pintarContexto();
  }
}

/* ---------- Ajustes ---------- */
function abrirAjustes() {
  $('a-url').value = ajustes.url || '';
  $('a-token').value = ajustes.token || '';
  $('a-usuario').value = ajustes.usuario || '';
  $('a-resultado').textContent = '';
  pintarCopia();
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
    $('a-resultado').textContent = '✅ Conexión correcta' + (r.clave ? ' · clave de ' + r.clave : '') +
      (r.version >= 2.6 ? '' : ' (servidor antiguo: actualiza Codigo.gs a la v2.6)') +
      (r.clave === 'clave antigua' ? '. Cambia a tu clave personal cuando la tengas.' : '') + '. Pulsa Guardar.';
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
