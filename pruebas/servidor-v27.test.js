// Servidor v2.7 (servidor/Codigo.gs) con el simulador de Apps Script.
// Cubre lo que ya hacía y no tenía prueba (validación, stock por lote, no duplicar) y lo nuevo de la v2.7.
// Ejecutar: node --test pruebas/servidor-v27.test.js
const test = require('node:test');
const assert = require('node:assert');
const { crearEntorno } = require('./simulador-gas');

const CAB = {
  Productos: ['codigo', 'nombre', 'marca', 'categoria', 'unidad', 'foto_url', 'alta', 'fecha_alta', 'tipo', 'contenido', 'linea_objetivo', 'notas'],
  Movimientos: ['id', 'fecha_registro', 'fecha_movimiento', 'usuario', 'tipo', 'codigo', 'cantidad', 'delta', 'caducidad', 'almacen', 'estante', 'nota'],
  Objetivos: ['id', 'categoria', 'descripcion', 'cantidad_objetivo', 'unidad', 'almacen', 'notas'],
  Config: ['tipo', 'valor', 'padre', 'activo']
};
const T = 'Trastero Ávila';

function entorno(opciones) {
  const g = crearEntorno(Object.assign({ propiedades: { TOKENS: JSON.stringify({ Sergio: 'clave-prueba' }) } }, opciones || {}));
  const libro = g.ctx.SpreadsheetApp.getActive();
  Object.keys(CAB).forEach(function (n) { libro.insertSheet(n).appendRow(CAB[n]); });
  g.hoja = function (n) { return libro.getSheetByName(n); };
  g.filas = function (n) { return g.hoja(n).celdas.slice(1); };
  g.llamar = function (accion, datos) {
    return JSON.parse(g.ctx.doPost({ postData: { contents: JSON.stringify(Object.assign({ token: 'clave-prueba', accion: accion }, datos || {})) } }).texto);
  };
  return g;
}
let n = 0;
function mov(tipo, codigo, cantidad, extra) {
  return Object.assign({ id: 'm' + (++n), fecha: '2026-11-10T10:00:00.000Z', usuario: 'Sergio', tipo: tipo, codigo: codigo, cantidad: cantidad,
    caducidad: '2027-03', almacen: T, estante: 'Estante 1', nota: '' }, extra || {});
}

test('clave no válida: no se hace nada', function () {
  const g = entorno();
  const r = JSON.parse(g.ctx.doPost({ postData: { contents: JSON.stringify({ token: 'otra', accion: 'datos' }) } }).texto);
  assert.deepStrictEqual(r, { ok: false, error: 'token' });
});

test('movimientos: valida, rechaza con motivo y neutraliza fórmulas', function () {
  const g = entorno();
  const malos = [
    mov('REGALO', 'A', 1), mov('ENTRADA', 'A', 0), mov('ENTRADA', 'A', 1.5), mov('ENTRADA', 'A', 10000),
    mov('ENTRADA', 'A', 1, { caducidad: '2027-13' }), mov('ENTRADA', 'A', 1, { almacen: '' }), mov('ENTRADA', '=1+1', 1), mov('ENTRADA', 'con espacio', 1)
  ];
  const bueno = mov('ENTRADA', '8400000000017', 3, { nota: '=HYPERLINK("http://x")', usuario: '+Sergio' });
  const r = g.llamar('movimientos', { movimientos: malos.concat([bueno]), productos: [] });
  assert.deepStrictEqual(r.aceptados, [bueno.id]);
  assert.deepStrictEqual(r.rechazados.map(function (x) { return x.motivo; }), ['tipo de movimiento no válido', 'cantidad no válida', 'cantidad no válida',
    'cantidad no válida', 'caducidad no válida', 'falta la estancia', 'código no válido', 'código no válido']);
  const filas = g.filas('Movimientos');
  assert.strictEqual(filas.length, 1);
  assert.strictEqual(filas[0][5], '8400000000017');
  assert.strictEqual(filas[0][7], 3, 'delta positivo en una entrada');
  assert.strictEqual(filas[0][11], '\'=HYPERLINK("http://x")', 'la nota no se interpreta como fórmula');
  assert.strictEqual(filas[0][3], "'+Sergio");
});

test('movimientos: el mismo id enviado dos veces se guarda una sola vez', function () {
  const g = entorno();
  const m = mov('ENTRADA', 'A', 2);
  assert.deepStrictEqual(g.llamar('movimientos', { movimientos: [m], productos: [] }).aceptados, [m.id]);
  const r2 = g.llamar('movimientos', { movimientos: [m, m], productos: [] });
  assert.deepStrictEqual(r2.aceptados, [m.id, m.id], 'se confirma como aceptado para que el móvil lo quite de la cola');
  assert.strictEqual(g.filas('Movimientos').length, 1);
  assert.strictEqual(g.llamar('datos').stock[0].stock, 2);
});

test('stock por lote: no deja sacar más de lo que hay; entrada y salida en el mismo envío', function () {
  const g = entorno();
  const e = mov('ENTRADA', 'A', 2), s1 = mov('SALIDA', 'A', 1), s2 = mov('SALIDA', 'A', 2), otroLote = mov('SALIDA', 'A', 1, { caducidad: '2028-01' });
  const r = g.llamar('movimientos', { movimientos: [e, s1, s2, otroLote], productos: [] });
  assert.deepStrictEqual(r.aceptados, [e.id, s1.id]);
  assert.deepStrictEqual(r.rechazados, [{ id: s2.id, motivo: 'sin stock suficiente en ese lote (constan 1)' }, { id: otroLote.id, motivo: 'sin stock suficiente en ese lote (constan 0)' }]);
  assert.deepStrictEqual(g.llamar('datos').stock, [{ codigo: 'A', caducidad: '2027-03', almacen: T, estante: 'Estante 1', stock: 1 }]);
});

test('F4: estancia y estante con otras mayúsculas o tildes son el mismo lote, también al calcular el stock', function () {
  const g = entorno();
  const e = mov('ENTRADA', 'A', 3), s = mov('SALIDA', 'A', 1, { almacen: 'trastero avila', estante: 'ESTANTE  1' });
  const r = g.llamar('movimientos', { movimientos: [e, s], productos: [] });
  assert.deepStrictEqual(r.rechazados, []);
  assert.deepStrictEqual(g.llamar('datos').stock, [{ codigo: 'A', caducidad: '2027-03', almacen: T, estante: 'Estante 1', stock: 2 }],
    'un solo lote (antes salían dos: uno con 3 y otro con -1)');
});

test('productos: alta, etiqueta (F3), kcal y campos vacíos que no borran', function () {
  const g = entorno();
  // Producto nuevo sin nombre (Open Food Facts simulado no lo tiene)
  g.llamar('movimientos', { movimientos: [mov('ENTRADA', '8400000000017', 1)], productos: [] });
  let p = g.llamar('datos').productos[0];
  assert.strictEqual(p.alta, 'no_encontrado');
  assert.strictEqual(p.kcal_100g, '', 'la columna nueva existe y va vacía');
  // Se completa a mano desde la app: la etiqueta deja de decir no_encontrado
  g.llamar('movimientos', { movimientos: [], productos: [{ codigo: '8400000000017', nombre: 'Tomate frito', categoria: 'condimentos', kcal_100g: 77.4, contenido: 400, unidad: 'g' }] });
  p = g.llamar('datos').productos[0];
  assert.strictEqual(p.nombre, 'Tomate frito');
  assert.strictEqual(p.categoria, 'CONDIMENTOS');
  assert.strictEqual(p.alta, 'manual');
  assert.strictEqual(p.kcal_100g, 77);
  // Vacíos y valores absurdos no cambian nada
  g.llamar('movimientos', { movimientos: [], productos: [{ codigo: '8400000000017', nombre: '', marca: '', kcal_100g: 5000, contenido: -1 }] });
  p = g.llamar('datos').productos[0];
  assert.strictEqual(p.nombre, 'Tomate frito');
  assert.strictEqual(p.kcal_100g, 77);
  assert.strictEqual(p.contenido, 400);
  // Completado por la app desde Open Food Facts: etiqueta openfoodfacts
  g.llamar('movimientos', { movimientos: [mov('ENTRADA', '8400000000024', 1)], productos: [] });
  g.llamar('movimientos', { movimientos: [], productos: [{ codigo: '8400000000024', nombre: 'Garbanzos', alta: 'openfoodfacts' }] });
  assert.strictEqual(g.llamar('datos').productos[1].alta, 'openfoodfacts');
  // Un producto nuevo que llega ya con nombre
  g.llamar('movimientos', { movimientos: [], productos: [{ codigo: 'INT-AB12', nombre: 'Manta', tipo: 'EQUIPO' }] });
  const manta = g.llamar('datos').productos[2];
  assert.strictEqual(manta.alta, 'manual');
  assert.strictEqual(manta.tipo, 'EQUIPO');
  assert.strictEqual(g.filas('Productos').length, 3, 'no se duplican filas');
});

test('productos: una pestaña con solo 12 columnas no rompe la lectura ni el guardado', function () {
  const g = entorno({ columnas: { Productos: 12 } });
  g.llamar('movimientos', { movimientos: [mov('ENTRADA', 'INT-X', 1)], productos: [{ codigo: 'INT-X', nombre: 'Algo', kcal_100g: 100 }] });
  assert.strictEqual(g.llamar('datos').productos[0].kcal_100g, 100);
  assert.strictEqual(g.hoja('Productos').getMaxColumns(), 13);
});

test('Objetivos: se leen por cabecera, con las columnas nuevas que haya', function () {
  const g = entorno({ columnas: { Objetivos: 7 } });
  g.hoja('Objetivos').appendRow(['TA-01', 'BEBIDA', 'Agua', 106.25, 'litros', T, 'nota']);
  g.hoja('Objetivos').appendRow(['', '', 'fila sin id', '', '', '', '']);
  // Sin columnas nuevas: igual que antes
  assert.deepStrictEqual(g.llamar('datos').objetivos, [{ id: 'TA-01', categoria: 'BEBIDA', descripcion: 'Agua', cantidad_objetivo: 106.25, unidad: 'litros', almacen: T, notas: 'nota' }]);
  // migrarV27 añade las cabeceras (y las columnas que falten) sin tocar datos; repetirla no duplica
  g.ctx.migrarV27();
  g.ctx.migrarV27();
  assert.deepStrictEqual(g.hoja('Objetivos').celdas[0], CAB.Objetivos.concat(['esencial', 'minimo']));
  assert.strictEqual(g.hoja('Productos').celdas[0][12], 'kcal_100g');
  g.hoja('Objetivos').celdas[1][7] = true; g.hoja('Objetivos').celdas[1][8] = 50;
  // Una columna que añada Sergio más adelante también llega, sin cambiar el servidor
  g.hoja('Objetivos').insertColumnsAfter(9, 1);
  g.hoja('Objetivos').celdas[0][9] = 'Revisar Cada'; g.hoja('Objetivos').celdas[1][9] = '6 meses';
  const o = g.llamar('datos').objetivos[0];
  assert.strictEqual(o.esencial, true);
  assert.strictEqual(o.minimo, 50);
  assert.strictEqual(o.revisar_cada, '6 meses');
  assert.strictEqual(o.cantidad_objetivo, 106.25);
});

test('migrarV27 no pisa una columna de Productos que ya se use para otra cosa', function () {
  const g = entorno();
  g.hoja('Productos').celdas[0][12] = 'mi columna';
  g.ctx.migrarV27();
  assert.strictEqual(g.hoja('Productos').celdas[0][12], 'mi columna');
  assert.ok(g.registro.some(function (l) { return /ATENCIÓN/.test(l); }));
  assert.strictEqual(g.hoja('Objetivos').celdas[0].length, 7, 'se detiene sin tocar Objetivos');
});

test('Config: listas de siempre y fecha de revisión (REVISION), una fila por estancia', function () {
  const g = entorno();
  let r = g.llamar('config', { cambio: { op: 'añadir', tipo: 'ESTANCIA', valor: 'Caja 72 h' } });
  assert.deepStrictEqual(r.config, [{ tipo: 'ESTANCIA', valor: 'Caja 72 h', estancia: '', padre: '', activo: true }]);
  r = g.llamar('config', { cambio: { op: 'añadir', tipo: 'CATEGORIA', valor: 'EQUIPO', padre: 'material' } });
  assert.strictEqual(r.config[1].padre, 'MATERIAL');
  assert.strictEqual(g.llamar('config', { cambio: { op: 'añadir', tipo: 'REVISION', valor: 'Caja 72 h', padre: 'ayer' } }).error, 'fecha de revision no valida');
  g.llamar('config', { cambio: { op: 'añadir', tipo: 'REVISION', valor: 'Caja 72 h', padre: '2026-11-16' } });
  r = g.llamar('config', { cambio: { op: 'añadir', tipo: 'REVISION', valor: 'Caja 72 h', padre: '2027-05-16' } });
  const rev = r.config.filter(function (x) { return x.tipo === 'REVISION'; });
  assert.deepStrictEqual(rev, [{ tipo: 'REVISION', valor: 'Caja 72 h', estancia: '2027-05-16', padre: '2027-05-16', activo: true }]);
  // La hoja de verdad convierte el texto en fecha: debe volver como AAAA-MM-DD
  g.hoja('Config').celdas[3][2] = new g.ctx.Date(Date.UTC(2027, 4, 16, 10, 0, 0));
  assert.strictEqual(g.llamar('datos').config[2].padre, '2027-05-16');
  assert.strictEqual(g.llamar('config', { cambio: { op: 'añadir', tipo: 'OTRA', valor: 'x' } }).error, 'datos no validos');
});

test('N5: la miniatura solo sirve fotos de la carpeta Fotos', function () {
  const g = entorno();
  g.llamar('movimientos', { movimientos: [], productos: [{ codigo: 'INT-F', nombre: 'Con foto' }, { codigo: 'INT-Z', nombre: 'Trampa' }] });
  const foto = g.llamar('foto', { codigo: 'INT-F', datos: Buffer.from('imagen').toString('base64') });
  assert.ok(foto.ok);
  const m = g.llamar('miniatura', { codigo: 'INT-F' });
  assert.ok(m.ok);
  assert.strictEqual(Buffer.from(m.datos, 'base64').toString(), 'imagen');
  // Alguien con clave apunta foto_url a otro archivo de la cuenta (una copia de seguridad)
  g.ctx.copiaSeguridad();
  const copia = g.copias()[0];
  g.llamar('movimientos', { movimientos: [], productos: [{ codigo: 'INT-Z', foto_url: copia.getUrl() }] });
  assert.deepStrictEqual(g.llamar('miniatura', { codigo: 'INT-Z' }), { ok: false, error: 'no es una foto de la app' });
});

test('si la hoja está ocupada, el móvil recibe un mensaje legible y no se guarda nada a medias', function () {
  const g = entorno();
  g.ctx.LockService.getScriptLock = function () { return { waitLock: function () { throw new Error('Lock timeout: another process was holding the lock for too long.'); }, releaseLock: function () {} }; };
  const r = g.llamar('movimientos', { movimientos: [mov('ENTRADA', 'A', 1)], productos: [] });
  assert.deepStrictEqual(r, { ok: false, error: 'el servidor está ocupado; se reintentará' });
  assert.strictEqual(g.filas('Movimientos').length, 0);
});
