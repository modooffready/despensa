/**
 * DESPENSA — Backend en Google Apps Script (v2.6)
 *
 * Funciones para ejecutar a mano desde el editor:
 *  - configurar(): solo la primera vez (crea pestañas y TOKEN). YA HECHO.
 *  - migrarV2():   una vez, al pasar a la v2. YA HECHO.
 *  - autorizarV21(): una vez, al pasar a la v2.1 (permisos de Drive para fotos y de Internet para Open Food Facts).
 *  - completarPendientes(): opcional, rellena con Open Food Facts los productos sin nombre.
 *  - completarFotos(): opcional, busca en Open Food Facts la foto de los productos que no tienen.
 *  - migrarV24(): una vez, al pasar a la v2.4 (nombres en la pestaña Stock).
 *  - crearClaves(): v2.5, crea una clave para cada persona de PERSONAS_CLAVE y las muestra.
 *  - verClaves(): muestra las claves actuales.
 *  - anularClaves(): anula las claves de las personas puestas en ANULAR_CLAVES.
 *  - cerrarAccesoAntiguo(): cuando todos los móviles usen su clave nueva, anula la clave antigua.
 *  - migrarV22(): una vez, al pasar a la v2.2 (modo Despensa/Material de cada categoría y nombres de los coches).
 *  - activarCopiaSemanal(): v2.6, una vez. Programa la copia de seguridad de cada lunes y hace la primera.
 *  - copiaSeguridad(): hace una copia ahora mismo (la usa la programación semanal; también a mano).
 *  - desactivarCopiaSemanal(): quita la programación (las copias ya hechas se conservan).
 *
 * Lo demás lo usa la app del móvil (doGet / doPost).
 */

const HOJAS = {
  productos:   ['codigo', 'nombre', 'marca', 'categoria', 'unidad', 'foto_url', 'alta', 'fecha_alta',
                'tipo', 'contenido', 'linea_objetivo', 'notas'],
  movimientos: ['id', 'fecha_registro', 'fecha_movimiento', 'usuario', 'tipo', 'codigo',
                'cantidad', 'delta', 'caducidad', 'almacen', 'estante', 'nota'],
  objetivos:   ['id', 'categoria', 'descripcion', 'cantidad_objetivo', 'unidad', 'almacen', 'notas'],
  config:      ['tipo', 'valor', 'padre', 'activo'] // padre = estancia (UBICACION) o modo DESPENSA/MATERIAL (CATEGORIA)
};
const NOMBRES = { productos: 'Productos', movimientos: 'Movimientos', stock: 'Stock',
                  objetivos: 'Objetivos', config: 'Config' };
const TIPOS = ['ENTRADA', 'SALIDA', 'AJUSTE'];
const TIPOS_CONFIG = ['CATEGORIA', 'ESTANCIA', 'UBICACION'];
// Campos de producto que la app puede modificar
const CAMPOS_EDITABLES = ['nombre', 'marca', 'categoria', 'unidad', 'foto_url', 'tipo', 'contenido', 'linea_objetivo', 'notas'];

const CONFIG_INICIAL = [
  ['CATEGORIA', 'BEBIDA'], ['CATEGORIA', 'POTABILIZAR'], ['CATEGORIA', 'PLATOS_PREPARADOS'],
  ['CATEGORIA', 'CONSERVAS'], ['CATEGORIA', 'COCINAR'], ['CATEGORIA', 'CONDIMENTOS'],
  ['CATEGORIA', 'DESAYUNO'], ['CATEGORIA', 'SNACKS'], ['CATEGORIA', 'MENAJE_Y_GAS'],
  ['CATEGORIA', 'ENERGIA'], ['CATEGORIA', 'HIGIENE'], ['CATEGORIA', 'LIMPIEZA'], ['CATEGORIA', 'BOTIQUIN'],
  ['ESTANCIA', 'Trastero Ávila'],
  ['ESTANCIA', 'Mochila – Documentos/electrónica'], ['ESTANCIA', 'Mochila – Botiquín/higiene'],
  ['ESTANCIA', 'Mochila – Comida/agua'],
  ['ESTANCIA', 'Peugeot 5008'], ['ESTANCIA', 'Mazda 3'], ['ESTANCIA', 'Sotalbo'],
  ['UBICACION', 'Estante 1', 'Trastero Ávila'], ['UBICACION', 'Estante 2', 'Trastero Ávila'],
  ['UBICACION', 'Estante 3', 'Trastero Ávila'], ['UBICACION', 'Estante 4', 'Trastero Ávila'],
  ['UBICACION', 'Estante 5', 'Trastero Ávila'], ['UBICACION', 'Estante 6', 'Trastero Ávila']
];

/* ============================================================
 * 1) CONFIGURACIÓN INICIAL (ya ejecutada en la v1)
 * ============================================================ */
function configurar() {
  const ss = SpreadsheetApp.getActive();
  crearHoja_(ss, NOMBRES.productos, HOJAS.productos);
  crearHoja_(ss, NOMBRES.movimientos, HOJAS.movimientos);
  crearHoja_(ss, NOMBRES.objetivos, HOJAS.objetivos);
  formatosTexto_(ss);
  ponerFormulaStock_(ss);
  ['Hoja 1', 'Hoja1', 'Sheet1'].forEach(function (n) {
    const h = ss.getSheetByName(n);
    if (h && h.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(h);
  });
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('TOKEN');
  if (!token) { token = Utilities.getUuid().replace(/-/g, ''); props.setProperty('TOKEN', token); }
  Logger.log('TU TOKEN (guárdalo, lo pedirá la app): ' + token);
}

/* ============================================================
 * 2) MIGRACIÓN A LA V2 — ejecutar UNA vez
 * ============================================================ */
function migrarV2() {
  const ss = SpreadsheetApp.getActive();

  // Productos: cabecera completa (las 8 primeras columnas no cambian)
  const prod = ss.getSheetByName(NOMBRES.productos);
  prod.getRange(1, 1, 1, HOJAS.productos.length).setValues([HOJAS.productos]).setFontWeight('bold');

  // Config: crear y rellenar con los valores iniciales si está vacía
  const conf = crearHoja_(ss, NOMBRES.config, HOJAS.config);
  if (conf.getLastRow() < 2) {
    const filas = CONFIG_INICIAL.map(function (r) { return [r[0], r[1], r[2] || '', true]; });
    conf.getRange(2, 1, filas.length, 4).setValues(filas);
  }

  // Objetivos: nueva cabecera (id y notas). Se vacía para pegar la tabla limpia.
  const obj = ss.getSheetByName(NOMBRES.objetivos);
  if (String(obj.getRange(1, 1).getValue()) !== 'id') {
    obj.clear();
    obj.getRange(1, 1, 1, HOJAS.objetivos.length).setValues([HOJAS.objetivos]).setFontWeight('bold');
    obj.setFrozenRows(1);
  }

  // Movimientos: estantes "1".."6" del trastero pasan a "Estante 1".."Estante 6"
  const mov = ss.getSheetByName(NOMBRES.movimientos);
  const n = mov.getLastRow();
  if (n > 1) {
    const rango = mov.getRange(2, 10, n - 1, 2); // almacen, estante
    const vals = rango.getValues().map(function (r) {
      const est = String(r[1]);
      if (r[0] === 'Trastero Ávila' && /^[1-9]$/.test(est)) return [r[0], 'Estante ' + est];
      return [r[0], est];
    });
    rango.setValues(vals);
  }

  formatosTexto_(ss);
  ponerFormulaStock_(ss);
  Logger.log('Migración v2 terminada. Ahora pega la tabla de objetivos en Objetivos!A1 y publica una nueva versión.');
}

/* ============================================================
 * MIGRACIÓN A LA V2.2 — ejecutar UNA vez
 * ============================================================ */
const MODO_CATEGORIA = {
  BEBIDA: 'DESPENSA', PLATOS_PREPARADOS: 'DESPENSA', CONSERVAS: 'DESPENSA', COCINAR: 'DESPENSA',
  CONDIMENTOS: 'DESPENSA', DESAYUNO: 'DESPENSA', SNACKS: 'DESPENSA',
  POTABILIZAR: 'MATERIAL', MENAJE_Y_GAS: 'MATERIAL', ENERGIA: 'MATERIAL', HIGIENE: 'MATERIAL',
  LIMPIEZA: 'MATERIAL', BOTIQUIN: 'MATERIAL'
};
const RENOMBRAR_ESTANCIAS = { 'Kit Peugeot': 'Peugeot 5008', 'Kit Mazda': 'Mazda 3' };

function migrarV22() {
  const ss = SpreadsheetApp.getActive();
  const conf = ss.getSheetByName(NOMBRES.config);
  conf.getRange(1, 3).setValue('padre');
  const n = conf.getLastRow();
  if (n < 2) { Logger.log('Config vacía: ejecuta antes migrarV2'); return; }

  // ¿Alguna estancia a renombrar ya tiene movimientos? Entonces no se toca.
  const mov = ss.getSheetByName(NOMBRES.movimientos);
  const usadas = new Set(mov.getLastRow() > 1 ? mov.getRange(2, 10, mov.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]); }) : []);

  const filas = conf.getRange(2, 1, n - 1, 4).getValues();
  const avisos = [];
  filas.forEach(function (r) {
    const tipo = String(r[0]).toUpperCase(), valor = String(r[1]).trim();
    if (tipo === 'CATEGORIA' && !r[2] && MODO_CATEGORIA[valor]) r[2] = MODO_CATEGORIA[valor];
    if (tipo === 'ESTANCIA' && RENOMBRAR_ESTANCIAS[valor]) {
      if (usadas.has(valor)) avisos.push(valor + ' tiene movimientos: no se renombra');
      else r[1] = RENOMBRAR_ESTANCIAS[valor];
    }
    if (tipo === 'UBICACION' && RENOMBRAR_ESTANCIAS[String(r[2])] && !usadas.has(String(r[2]))) r[2] = RENOMBRAR_ESTANCIAS[String(r[2])];
  });
  conf.getRange(2, 1, filas.length, 4).setValues(filas);
  Logger.log('Migración v2.2 terminada. ' + avisos.join('; ') + ' Publica una nueva versión.');
}

function crearHoja_(ss, nombre, cabeceras) {
  const hoja = ss.getSheetByName(nombre) || ss.insertSheet(nombre);
  if (hoja.getLastRow() === 0) {
    hoja.getRange(1, 1, 1, cabeceras.length).setValues([cabeceras]).setFontWeight('bold');
    hoja.setFrozenRows(1);
  }
  return hoja;
}

function formatosTexto_(ss) {
  ss.getSheetByName(NOMBRES.productos).getRange('A:A').setNumberFormat('@');
  ss.getSheetByName(NOMBRES.productos).getRange('K:K').setNumberFormat('@'); // linea_objetivo
  const mov = ss.getSheetByName(NOMBRES.movimientos);
  mov.getRange('F:F').setNumberFormat('@');
  mov.getRange('I:I').setNumberFormat('@');
  mov.getRange('K:K').setNumberFormat('@');
}

function ponerFormulaStock_(ss) {
  const stock = ss.getSheetByName(NOMBRES.stock) || ss.insertSheet(NOMBRES.stock);
  stock.clear();
  const locale = ss.getSpreadsheetLocale() || '';
  const sep = /^(en|ja|zh|ko|th|he|hi)/.test(locale) ? ',' : ';';
  // Columna A: nombre del producto; de B a F: código, caducidad, almacén, estante y stock
  stock.getRange('A1').setValue('nombre').setFontWeight('bold');
  stock.getRange('A2').setFormula(
    '=ARRAYFORMULA(IF(B2:B=""' + sep + '""' + sep + 'IFERROR(VLOOKUP(B2:B' + sep + 'Productos!A:B' + sep + '2' + sep + 'FALSE)' + sep + '"(sin nombre)")))'
  );
  stock.getRange('B1').setFormula(
    '=IFERROR(QUERY(Movimientos!A1:L' + sep +
    '"select F, I, J, K, sum(H) where F <> \'\' group by F, I, J, K label sum(H) \'stock\'"' + sep + '1)' +
    sep + '"Sin movimientos todavía")'
  );
  stock.setFrozenRows(1);
  stock.getRange('B1:F1').setFontWeight('bold');
}

// Ejecutar UNA vez al pasar a la v2.4: rehace la pestaña Stock con la columna de nombres
function migrarV24() {
  ponerFormulaStock_(SpreadsheetApp.getActive());
  Logger.log('Pestaña Stock actualizada con nombres. Publica una nueva versión.');
}

// Últimos movimientos de un producto (para la ficha del móvil)
function historialDe_(codigo) {
  const hoja = SpreadsheetApp.getActive().getSheetByName(NOMBRES.movimientos);
  const n = hoja.getLastRow();
  if (n < 2 || !codigo) return [];
  const filas = hoja.getRange(2, 1, n - 1, HOJAS.movimientos.length).getValues();
  const res = [];
  for (let i = filas.length - 1; i >= 0 && res.length < 20; i--) {
    const r = filas[i];
    if (String(r[5]) !== String(codigo)) continue;
    const f = r[2] instanceof Date ? r[2] : (r[1] instanceof Date ? r[1] : null);
    res.push({ id: String(r[0]), fecha: f ? f.toISOString() : '', usuario: r[3], tipo: r[4], cantidad: r[6],
               caducidad: r[8] instanceof Date ? Utilities.formatDate(r[8], 'Europe/Madrid', 'yyyy-MM') : String(r[8]),
               almacen: r[9], estante: String(r[10]), nota: r[11] });
  }
  return res;
}

/* ============================================================
 * 3) WEB APP — lo que llama el móvil
 * ============================================================ */
const VERSION_SERVIDOR = 2.6;

// Lecturas por la dirección (GET): solo para apps antiguas y solo con la clave antigua.
// Desaparece al ejecutar cerrarAccesoAntiguo().
function doGet(e) {
  const p = (e && e.parameter) || {};
  const antigua = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!antigua || p.token !== antigua) return json_({ ok: false, error: 'token' });
  return json_(responder_(p.accion, p, 'clave antigua'));
}

// Todo lo demás llega por POST, con la clave dentro del mensaje (nunca en la dirección)
function doPost(e) {
  let body;
  try {
    if (!e || !e.postData || e.postData.contents.length > 4000000) return json_({ ok: false, error: 'peticion demasiado grande' });
    body = JSON.parse(e.postData.contents);
  } catch (err) { return json_({ ok: false, error: 'json no valido' }); }
  const quien = quienEs_(body.token);
  if (!quien) return json_({ ok: false, error: 'token' });
  return json_(responder_(body.accion, body, quien));
}

function responder_(accion, d, quien) {
  switch (accion) {
    case 'ping': return { ok: true, hora: new Date().toISOString(), version: VERSION_SERVIDOR, clave: quien, ultimaCopia: ultimaCopia_() };
    case 'datos': return { ok: true, productos: leerProductos_(), stock: calcularStock_(), config: leerConfig_(), objetivos: leerObjetivos_(),
                           ultimaCopia: ultimaCopia_() };
    case 'catalogo': return { ok: true, productos: leerProductos_() };
    case 'historial': return { ok: true, movimientos: historialDe_(d.codigo) };
    case 'miniatura': return miniatura_(d.codigo);
    case 'movimientos': return guardarMovimientos_(arr_(d.movimientos), arr_(d.productos), quien);
    case 'config': return cambiarConfig_(d.cambio || {});
    case 'foto': return guardarFoto_(d);
    default: return { ok: false, error: 'accion desconocida' };
  }
}

function arr_(v) { return Array.isArray(v) ? v.slice(0, 500) : []; }

/* ============================================================
 * CLAVES POR PERSONA (v2.5)
 * ============================================================ */
const PERSONAS_CLAVE = ['Sergio', 'Mónica'];   // una clave para cada persona
const ANULAR_CLAVES = [];                       // p. ej. ['Mónica'] y ejecuta anularClaves()

function leerClaves_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('TOKENS') || '{}'); } catch (e) { return {}; }
}
function guardarClaves_(c) { PropertiesService.getScriptProperties().setProperty('TOKENS', JSON.stringify(c)); }

function crearClaves() {
  const c = leerClaves_();
  PERSONAS_CLAVE.forEach(function (n) { if (!c[n]) c[n] = Utilities.getUuid().replace(/-/g, ''); });
  guardarClaves_(c);
  verClaves();
}

function verClaves() {
  const c = leerClaves_();
  Object.keys(c).forEach(function (n) { Logger.log('Clave de ' + n + ': ' + c[n]); });
  if (!Object.keys(c).length) Logger.log('Todavía no hay claves por persona: ejecuta crearClaves().');
  Logger.log(PropertiesService.getScriptProperties().getProperty('TOKEN')
    ? 'La clave antigua sigue funcionando. Cuando todos los móviles tengan su clave nueva, ejecuta cerrarAccesoAntiguo().'
    : 'La clave antigua está anulada.');
}

function anularClaves() {
  const c = leerClaves_();
  ANULAR_CLAVES.forEach(function (n) {
    if (c[n]) { delete c[n]; Logger.log('Anulada la clave de ' + n); } else Logger.log('No había clave para ' + n);
  });
  guardarClaves_(c);
}

function cerrarAccesoAntiguo() {
  if (!Object.keys(leerClaves_()).length) { Logger.log('Antes crea las claves nuevas con crearClaves().'); return; }
  PropertiesService.getScriptProperties().deleteProperty('TOKEN');
  Logger.log('Clave antigua anulada. Solo funcionan las claves por persona.');
}

// Nombre del dueño de la clave, o '' si no es válida
function quienEs_(t) {
  if (!t || typeof t !== 'string') return '';
  const c = leerClaves_();
  for (const n in c) if (c[n] === t) return n;
  const antigua = PropertiesService.getScriptProperties().getProperty('TOKEN');
  return antigua && t === antigua ? 'clave antigua' : '';
}

/* ============================================================
 * COPIA DE SEGURIDAD SEMANAL (v2.6)
 * Exporta la hoja entera a Excel (.xlsx) en la carpeta "Copias de seguridad",
 * junto a la hoja, y conserva solo las últimas COPIAS_A_GUARDAR.
 * Las fotos no se copian (ya están en Drive y ocuparían el doble).
 * Si una copia falla, Google envía un correo de aviso a la cuenta dueña del script.
 * ============================================================ */
const COPIAS_A_GUARDAR = 4;
const CARPETA_COPIAS = 'Copias de seguridad';
const PREFIJO_COPIA = 'Despensa copia ';

function activarCopiaSemanal() {
  quitarProgramacion_();
  ScriptApp.newTrigger('copiaSeguridad').timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(4).inTimezone('Europe/Madrid').create();
  copiaSeguridad();
  Logger.log('Copia semanal activada: cada lunes entre las 4 y las 5 de la mañana. La primera ya está hecha.');
}

function desactivarCopiaSemanal() {
  const n = quitarProgramacion_();
  Logger.log(n ? 'Copia semanal desactivada. Las copias ya hechas siguen en Drive.' : 'No había copia semanal programada.');
}

function quitarProgramacion_() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'copiaSeguridad') { ScriptApp.deleteTrigger(t); n++; }
  });
  return n;
}

function copiaSeguridad() {
  const ss = SpreadsheetApp.getActive();
  SpreadsheetApp.flush();
  const url = 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=xlsx';
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } });
  const codigo = resp.getResponseCode();
  // Si falla, se lanza un error: así Google avisa por correo y no se borra ninguna copia anterior
  if (codigo !== 200) throw new Error('No se pudo exportar la hoja (respuesta ' + codigo + ')');
  const blob = resp.getBlob();
  if (blob.getBytes().length < 2000) throw new Error('La copia ha salido vacía; no se guarda');

  const carpeta = subcarpeta_(CARPETA_COPIAS);
  const nombre = PREFIJO_COPIA + Utilities.formatDate(new Date(), 'Europe/Madrid', 'yyyy-MM-dd HHmm') + '.xlsx';
  carpeta.createFile(blob.setName(nombre));

  // Solo se borran copias hechas por esta función (mismo prefijo), de la más antigua a la más nueva
  const copias = [];
  const it = carpeta.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (f.getName().indexOf(PREFIJO_COPIA) === 0 && /\.xlsx$/.test(f.getName())) copias.push(f);
  }
  copias.sort(function (a, b) { return b.getDateCreated().getTime() - a.getDateCreated().getTime(); });
  const borradas = copias.slice(COPIAS_A_GUARDAR);
  borradas.forEach(function (f) { f.setTrashed(true); });

  PropertiesService.getScriptProperties().setProperty('ULTIMA_COPIA', new Date().toISOString());
  Logger.log('Copia guardada: ' + nombre + ' (' + Math.round(blob.getBytes().length / 1024) + ' KB). ' +
             'Copias conservadas: ' + Math.min(copias.length, COPIAS_A_GUARDAR) + '. Enviadas a la papelera: ' + borradas.length + '.');
}

// Fecha de la última copia correcta (ISO) o '' si aún no hay ninguna
function ultimaCopia_() { return PropertiesService.getScriptProperties().getProperty('ULTIMA_COPIA') || ''; }

/* ============================================================
 * VALIDACIÓN Y SANEADO (v2.5)
 * ============================================================ */
// Texto seguro para la hoja: sin caracteres de control, con longitud máxima y sin que se interprete como fórmula
function texto_(v, max) {
  let s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max || 120);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}
function codigoValido_(c) { c = String(c == null ? '' : c); return c.length >= 1 && c.length <= 60 && !/[\u0000-\u001f\s]/.test(c) && !/^[=+\-@]/.test(c); }
function cadValida_(c) { return c === '' || /^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/.test(c); }
function fechaValida_(f) {
  if (!f) return '';
  const d = new Date(f);
  if (isNaN(d.getTime())) return '';
  const ahora = Date.now();
  return d.getTime() > Date.UTC(2020, 0, 1) && d.getTime() < ahora + 2 * 86400000 ? d : '';
}
function normalizar_(t) { return String(t == null ? '' : t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function cadTexto_(v) { return v instanceof Date ? Utilities.formatDate(v, 'Europe/Madrid', 'yyyy-MM') : String(v == null ? '' : v).trim(); }
function claveLote_(codigo, cad, almacen, estante) { return [String(codigo), cadTexto_(cad), normalizar_(almacen), normalizar_(estante)].join('|'); }

function sanearProducto_(p) {
  const o = { codigo: String(p.codigo || '') };
  if (p.nombre != null && p.nombre !== '') o.nombre = texto_(p.nombre, 120);
  if (p.marca != null && p.marca !== '') o.marca = texto_(p.marca, 80);
  if (p.categoria) o.categoria = texto_(String(p.categoria).toUpperCase(), 40);
  if (p.unidad) o.unidad = texto_(p.unidad, 20);
  if (p.tipo && ['CONSUMIBLE', 'EQUIPO'].indexOf(String(p.tipo)) >= 0) o.tipo = String(p.tipo);
  const cont = Number(p.contenido);
  if (p.contenido !== '' && p.contenido != null && isFinite(cont) && cont > 0 && cont < 100000) o.contenido = cont;
  if (p.linea_objetivo) o.linea_objetivo = texto_(p.linea_objetivo, 20);
  if (p.foto_url && /^https:\/\//.test(String(p.foto_url))) o.foto_url = String(p.foto_url).slice(0, 500);
  if (p.notas) o.notas = texto_(p.notas, 300);
  return o;
}

/* ============================================================
 * OPEN FOOD FACTS Y FOTOS (v2.1)
 * ============================================================ */

// Ejecutar UNA vez desde el editor tras pegar la v2.1: concede permisos de Drive y de Internet
function autorizarV21() {
  const carpeta = carpetaFotos_();
  const prueba = buscarOFF_('3017620422003'); // Nutella, como prueba
  Logger.log('Carpeta de fotos: ' + carpeta.getName() + ' · Open Food Facts responde: ' + (prueba ? prueba.nombre : 'NO'));
}

// Completa con Open Food Facts los productos que siguen sin nombre (se puede ejecutar a mano)
function completarPendientes() {
  const hoja = SpreadsheetApp.getActive().getSheetByName(NOMBRES.productos);
  const cab = HOJAS.productos;
  const n = hoja.getLastRow();
  if (n < 2) return;
  const datos = hoja.getRange(2, 1, n - 1, cab.length).getValues();
  let hechos = 0;
  datos.forEach(function (r, i) {
    if (hechos >= 40 || r[1] || !/^\d{8,14}$/.test(String(r[0]))) return;
    const off = buscarOFF_(String(r[0]));
    rellenarDesdeOFF_(r, off);
    hoja.getRange(i + 2, 1, 1, cab.length).setValues([r]);
    hechos++;
  });
  Logger.log('Productos revisados: ' + hechos);
}

// Busca en Open Food Facts la foto de los productos con código de barras que aún no tienen foto (ejecutar a mano)
function completarFotos() {
  const hoja = SpreadsheetApp.getActive().getSheetByName(NOMBRES.productos);
  const cab = HOJAS.productos, iFoto = cab.indexOf('foto_url');
  const n = hoja.getLastRow();
  if (n < 2) return;
  const datos = hoja.getRange(2, 1, n - 1, cab.length).getValues();
  let revisados = 0, encontradas = 0;
  datos.forEach(function (r, i) {
    if (revisados >= 60 || r[iFoto] || !/^\d{8,14}$/.test(String(r[0]))) return;
    revisados++;
    const off = buscarOFF_(String(r[0]));
    if (off && off.foto_url) { hoja.getRange(i + 2, iFoto + 1).setValue(off.foto_url); encontradas++; }
  });
  Logger.log('Revisados: ' + revisados + ' · Fotos encontradas en Open Food Facts: ' + encontradas);
}

function buscarOFF_(codigo) {
  try {
    const url = 'https://world.openfoodfacts.org/api/v2/product/' + encodeURIComponent(codigo) +
      '.json?fields=product_name,product_name_es,brands,product_quantity,product_quantity_unit,image_front_small_url';
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'User-Agent': 'DespensaApp/2.1 (uso personal)' } });
    if (resp.getResponseCode() !== 200) return null;
    const j = JSON.parse(resp.getContentText());
    if (j.status !== 1 || !j.product) return null;
    const p = j.product;
    const nombre = p.product_name_es || p.product_name || '';
    if (!nombre) return null;
    const cont = convertirCantidad_(p.product_quantity, p.product_quantity_unit);
    return { nombre: nombre, marca: String(p.brands || '').split(',')[0].trim(),
             foto_url: p.image_front_small_url || '', contenido: cont.contenido, unidad: cont.unidad };
  } catch (e) {
    return null;
  }
}

function convertirCantidad_(q, u) {
  const n = Number(q);
  if (!n || n <= 0) return { contenido: '', unidad: '' };
  u = String(u || 'g').toLowerCase();
  if (u === 'g') return n >= 1000 ? { contenido: n / 1000, unidad: 'kg' } : { contenido: n, unidad: 'g' };
  if (u === 'ml') return n >= 1000 ? { contenido: n / 1000, unidad: 'litros' } : { contenido: n, unidad: 'ml' };
  if (u === 'kg') return { contenido: n, unidad: 'kg' };
  if (u === 'l') return { contenido: n, unidad: 'litros' };
  return { contenido: '', unidad: '' };
}

// r = fila de Productos (array). Solo rellena lo que está vacío.
function rellenarDesdeOFF_(r, off) {
  const cab = HOJAS.productos;
  const alta = cab.indexOf('alta');
  if (!off) { if (!r[1]) r[alta] = 'no_encontrado'; return; }
  ['nombre', 'marca', 'foto_url', 'contenido', 'unidad'].forEach(function (k) {
    const i = cab.indexOf(k);
    if ((r[i] === '' || r[i] === null) && off[k] !== '') r[i] = off[k];
  });
  r[alta] = 'openfoodfacts';
}

function carpetaFotos_() { return subcarpeta_('Fotos'); }

// Subcarpeta dentro de la carpeta donde está la hoja (la crea si no existe)
function subcarpeta_(nombre) {
  const ss = SpreadsheetApp.getActive();
  const padres = DriveApp.getFileById(ss.getId()).getParents();
  const base = padres.hasNext() ? padres.next() : DriveApp.getRootFolder();
  const sub = base.getFoldersByName(nombre);
  return sub.hasNext() ? sub.next() : base.createFolder(nombre);
}

// Devuelve la foto de Drive de un producto (miniatura si existe) en base64, para mostrarla en el móvil
function miniatura_(codigo) {
  const pr = leerProductos_().filter(function (x) { return x.codigo === String(codigo || ''); })[0];
  if (!pr || !pr.foto_url) return { ok: false, error: 'sin foto' };
  const m = String(pr.foto_url).match(/[-\w]{25,}/);
  if (!m || /openfoodfacts/.test(pr.foto_url)) return { ok: false, error: 'no es de Drive' };
  try {
    const f = DriveApp.getFileById(m[0]);
    const blob = f.getThumbnail() || f.getBlob();
    return { ok: true, datos: Utilities.base64Encode(blob.getBytes()), tipo: blob.getContentType() || 'image/jpeg' };
  } catch (e) {
    return { ok: false, error: 'no se pudo leer la foto' };
  }
}

function guardarFoto_(b) {
  const codigo = String(b.codigo || '');
  if (!codigoValido_(codigo) || !b.datos) return { ok: false, error: 'faltan datos' };
  if (String(b.datos).length > 3000000) return { ok: false, error: 'foto demasiado grande' };
  const blob = Utilities.newBlob(Utilities.base64Decode(b.datos), 'image/jpeg',
    codigo + '_' + Utilities.formatDate(new Date(), 'Europe/Madrid', 'yyyyMMdd-HHmmss') + '.jpg');
  const archivo = carpetaFotos_().createFile(blob);
  const url = archivo.getUrl();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    guardarProductos_([sanearProducto_({ codigo: codigo, foto_url: url })], []);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, foto_url: url };
}

/* ============================================================
 * 4) LÓGICA
 * ============================================================ */
function guardarMovimientos_(movs, prods, quien) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const hoja = SpreadsheetApp.getActive().getSheetByName(NOMBRES.movimientos);
    const n = hoja.getLastRow();
    // Se lee todo una vez: ids ya guardados (para no duplicar) y stock actual de cada lote
    const actuales = n > 1 ? hoja.getRange(2, 1, n - 1, HOJAS.movimientos.length).getValues() : [];
    const existentes = new Set();
    const stock = {};
    actuales.forEach(function (r) {
      existentes.add(String(r[0]));
      const k = claveLote_(r[5], r[8], r[9], r[10]);
      stock[k] = (stock[k] || 0) + Number(r[7] || 0);
    });

    const ahora = new Date();
    const filas = [], aceptados = [], rechazados = [];
    movs.forEach(function (m) {
      m = m || {};
      const id = String(m.id || '').slice(0, 80);
      if (!id) { rechazados.push({ id: id, motivo: 'sin id' }); return; }
      if (existentes.has(id)) { aceptados.push(id); return; }
      const tipo = String(m.tipo || '').toUpperCase();
      const cant = Number(m.cantidad);
      const cad = String(m.caducidad || '').trim();
      const almacen = texto_(m.almacen, 60), estante = texto_(m.estante, 60);
      let motivo = '';
      if (TIPOS.indexOf(tipo) < 0) motivo = 'tipo de movimiento no válido';
      else if (!codigoValido_(m.codigo)) motivo = 'código no válido';
      else if (!Number.isInteger(cant) || Math.abs(cant) > 9999 || (tipo === 'AJUSTE' ? cant === 0 : cant < 1)) motivo = 'cantidad no válida';
      else if (!cadValida_(cad)) motivo = 'caducidad no válida';
      else if (!almacen) motivo = 'falta la estancia';
      if (motivo) { rechazados.push({ id: id, motivo: motivo }); return; }

      const delta = tipo === 'SALIDA' ? -cant : cant;
      // Control de stock en el servidor: con varios móviles o sin conexión, el control del móvil no basta
      const k = claveLote_(m.codigo, cad, almacen, estante);
      const hay = stock[k] || 0;
      if (delta < 0 && hay + delta < 0) {
        rechazados.push({ id: id, motivo: 'sin stock suficiente en ese lote (constan ' + hay + ')' });
        return;
      }
      stock[k] = hay + delta;
      filas.push([
        id, ahora, fechaValida_(m.fecha), texto_(m.usuario, 40) || (quien === 'clave antigua' ? '' : quien), tipo, String(m.codigo),
        cant, delta, cad, almacen, estante, texto_(m.nota, 300)
      ]);
      existentes.add(id);
      aceptados.push(id);
    });

    if (filas.length) hoja.getRange(n + 1, 1, filas.length, filas[0].length).setValues(filas);
    // Productos: solo los de movimientos aceptados o fichas válidas
    const productos = prods.filter(function (p) { return p && codigoValido_(p.codigo); }).map(sanearProducto_);
    const movsOk = movs.filter(function (m) { return m && aceptados.indexOf(String(m.id)) >= 0 && codigoValido_(m.codigo); });
    const productosNuevos = guardarProductos_(productos, movsOk);
    return { ok: true, aceptados: aceptados, rechazados: rechazados, productosNuevos: productosNuevos,
             productosRecibidos: productos.map(function (p) { return p.codigo; }) };
  } finally {
    lock.releaseLock();
  }
}

// Crea productos nuevos y actualiza los campos que la app envía con valor
function guardarProductos_(prods, movs) {
  const hoja = SpreadsheetApp.getActive().getSheetByName(NOMBRES.productos);
  const cab = HOJAS.productos;
  const n = hoja.getLastRow();
  const datos = n > 1 ? hoja.getRange(2, 1, n - 1, cab.length).getValues() : [];
  const indice = {};
  datos.forEach(function (r, i) { indice[String(r[0])] = i; });

  const info = {};
  prods.forEach(function (p) { if (p && p.codigo) info[String(p.codigo)] = p; });
  const codigos = new Set(
    movs.map(function (m) { return String(m.codigo || ''); }).filter(String).concat(Object.keys(info))
  );
  const nuevos = [];
  const ahora = new Date();
  let consultasOFF = 0;

  codigos.forEach(function (c) {
    const p = info[c] || {};
    if (c in indice) {
      const i = indice[c];
      let cambiado = false;
      CAMPOS_EDITABLES.forEach(function (campo) {
        const v = p[campo];
        if (v !== undefined && v !== null && v !== '') {
          datos[i][cab.indexOf(campo)] = v;
          cambiado = true;
        }
      });
      if (cambiado) {
        if (datos[i][cab.indexOf('alta')] === 'pendiente' && datos[i][1]) datos[i][cab.indexOf('alta')] = 'manual';
        hoja.getRange(i + 2, 1, 1, cab.length).setValues([datos[i]]);
      }
    } else {
      const fila = cab.map(function (campo) {
        if (campo === 'codigo') return c;
        if (campo === 'alta') return p.nombre ? 'manual' : 'pendiente';
        if (campo === 'fecha_alta') return ahora;
        const v = p[campo];
        return v === undefined || v === null ? '' : v;
      });
      // Sin nombre y con código de barras real: buscar en Open Food Facts (máx. 5 por envío)
      if (!p.nombre && /^\d{8,14}$/.test(c) && consultasOFF < 5) {
        consultasOFF++;
        rellenarDesdeOFF_(fila, buscarOFF_(c));
      }
      nuevos.push(fila);
    }
  });

  if (nuevos.length) hoja.getRange(n + 1, 1, nuevos.length, cab.length).setValues(nuevos);
  return nuevos.length;
}

function cambiarConfig_(c) {
  const tipo = String(c.tipo || '').toUpperCase();
  const valor = texto_(c.valor, 60);
  let padre = texto_(c.padre !== undefined ? c.padre : (c.estancia || ''), 60);
  if (tipo === 'ESTANCIA') padre = '';
  if (tipo === 'CATEGORIA') padre = padre.toUpperCase();
  if (TIPOS_CONFIG.indexOf(tipo) < 0 || !valor) return { ok: false, error: 'datos no validos' };
  if (tipo === 'UBICACION' && !padre) return { ok: false, error: 'falta la estancia' };
  if (tipo === 'CATEGORIA' && padre && ['DESPENSA', 'MATERIAL'].indexOf(padre) < 0) return { ok: false, error: 'modo no valido' };
  const activo = c.op !== 'desactivar';

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const hoja = SpreadsheetApp.getActive().getSheetByName(NOMBRES.config);
    if (!hoja) return { ok: false, error: 'falta la pestaña Config (ejecuta migrarV2)' };
    const n = hoja.getLastRow();
    const filas = n > 1 ? hoja.getRange(2, 1, n - 1, 4).getValues() : [];
    for (let i = 0; i < filas.length; i++) {
      const mismoTipo = String(filas[i][0]).toUpperCase() === tipo && String(filas[i][1]).trim() === valor;
      // Ubicaciones: se distinguen por estancia. Categorías: por nombre (el modo se puede cambiar).
      const mismoPadre = tipo !== 'UBICACION' || String(filas[i][2]).trim() === padre;
      if (mismoTipo && mismoPadre) {
        hoja.getRange(i + 2, 4).setValue(activo);
        if (tipo === 'CATEGORIA' && padre) hoja.getRange(i + 2, 3).setValue(padre);
        return { ok: true, config: leerConfig_() };
      }
    }
    if (!activo) return { ok: false, error: 'no existe' };
    hoja.appendRow([tipo, valor, padre, true]);
    return { ok: true, config: leerConfig_() };
  } finally {
    lock.releaseLock();
  }
}

function leerConfig_() {
  const hoja = SpreadsheetApp.getActive().getSheetByName(NOMBRES.config);
  if (!hoja || hoja.getLastRow() < 2) return [];
  return hoja.getRange(2, 1, hoja.getLastRow() - 1, 4).getValues()
    .filter(function (r) { return r[0] && r[1]; })
    .map(function (r) {
      const a = String(r[3]).toUpperCase();
      return { tipo: String(r[0]).toUpperCase(), valor: String(r[1]).trim(), estancia: String(r[2]).trim(), padre: String(r[2]).trim(),
               activo: !(r[3] === false || a === 'FALSE' || a === 'FALSO' || a === 'NO' || a === '0') };
    });
}

function leerObjetivos_() {
  const hoja = SpreadsheetApp.getActive().getSheetByName(NOMBRES.objetivos);
  if (!hoja || hoja.getLastRow() < 2 || String(hoja.getRange(1, 1).getValue()) !== 'id') return [];
  const cab = HOJAS.objetivos;
  return hoja.getRange(2, 1, hoja.getLastRow() - 1, cab.length).getValues()
    .filter(function (r) { return r[0]; })
    .map(function (r) {
      const o = {};
      cab.forEach(function (k, i) { o[k] = r[i]; });
      o.id = String(o.id);
      return o;
    });
}

function leerProductos_() {
  const hoja = SpreadsheetApp.getActive().getSheetByName(NOMBRES.productos);
  const n = hoja.getLastRow();
  if (n < 2) return [];
  const cab = HOJAS.productos;
  return hoja.getRange(2, 1, n - 1, cab.length).getValues().map(function (r) {
    const o = {};
    cab.forEach(function (k, i) { o[k] = r[i] instanceof Date ? r[i].toISOString() : r[i]; });
    o.codigo = String(o.codigo);
    return o;
  });
}

// Stock por lote (codigo + caducidad + almacen + estante), solo lo que no es cero
function calcularStock_() {
  const hoja = SpreadsheetApp.getActive().getSheetByName(NOMBRES.movimientos);
  const n = hoja.getLastRow();
  if (n < 2) return [];
  const filas = hoja.getRange(2, 1, n - 1, HOJAS.movimientos.length).getValues();
  const mapa = {};
  filas.forEach(function (r) {
    const codigo = String(r[5]);
    if (!codigo) return;
    const cad = r[8] instanceof Date ? Utilities.formatDate(r[8], 'Europe/Madrid', 'yyyy-MM') : String(r[8]);
    const k = [codigo, cad, String(r[9]), String(r[10])].join('|');
    mapa[k] = (mapa[k] || 0) + Number(r[7] || 0);
  });
  return Object.keys(mapa).filter(function (k) { return mapa[k] !== 0; }).map(function (k) {
    const p = k.split('|');
    return { codigo: p[0], caducidad: p[1], almacen: p[2], estante: p[3], stock: mapa[k] };
  });
}

function tokenValido_(t) { return !!quienEs_(t); }
function tokenValidoAntiguo_(t) {
  const real = PropertiesService.getScriptProperties().getProperty('TOKEN');
  return !!real && t === real;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
