// Pruebas de la copia de seguridad semanal (servidor v2.6). Ejecutar: node --test pruebas/
const test = require('node:test');
const assert = require('node:assert');
const { crearEntorno } = require('./simulador-gas');

test('versión del servidor 2.6', function () {
  assert.strictEqual(crearEntorno().ctx.__const.VERSION_SERVIDOR, 2.6);
});

test('activarCopiaSemanal programa un único activador los lunes a las 4 y hace la primera copia', function () {
  const g = crearEntorno();
  g.ctx.activarCopiaSemanal();
  g.ctx.activarCopiaSemanal(); // repetirlo no duplica
  assert.strictEqual(g.activadores.length, 1);
  assert.deepStrictEqual([g.activadores[0].funcion, g.activadores[0].dia, g.activadores[0].hora, g.activadores[0].zona],
    ['copiaSeguridad', 'MONDAY', 4, 'Europe/Madrid']);
  const vivas = g.copias().filter(function (f) { return !f.papelera; });
  assert.strictEqual(vivas.length, 2);
  assert.match(vivas[0].nombre, /^Despensa copia \d{4}-\d{2}-\d{2} \d{4}\.xlsx$/);
  assert.ok(g.registro.some(function (l) { return /export\?format=xlsx/.test(l); }));
});

test('conserva solo las 4 últimas y envía a la papelera las más antiguas', function () {
  const g = crearEntorno();
  for (let i = 0; i < 6; i++) { g.ctx.copiaSeguridad(); g.avanzarDias(7); }
  const todas = g.copias();
  const vivas = todas.filter(function (f) { return !f.papelera; });
  assert.strictEqual(todas.length, 6);
  assert.strictEqual(vivas.length, 4);
  // Las que quedan son las 4 más recientes
  const recientes = todas.slice().sort(function (a, b) { return b.creado - a.creado; }).slice(0, 4);
  assert.deepStrictEqual(vivas.map(function (f) { return f.id; }).sort(), recientes.map(function (f) { return f.id; }).sort());
});

test('no toca otros archivos de la carpeta de copias', function () {
  const g = crearEntorno();
  g.ctx.copiaSeguridad();
  const carpeta = g.carpetaDespensa.hijas.filter(function (h) { return h.nombre === 'Copias de seguridad'; })[0];
  carpeta.createFile({ getName: function () { return 'mi copia manual.xlsx'; }, getBytes: function () { return []; } });
  for (let i = 0; i < 6; i++) { g.avanzarDias(7); g.ctx.copiaSeguridad(); }
  const manual = g.copias().filter(function (f) { return f.nombre === 'mi copia manual.xlsx'; })[0];
  assert.strictEqual(manual.papelera, false);
});

test('si la exportación falla: error (Google avisa por correo), no se borra nada y no cambia la fecha', function () {
  const g = crearEntorno();
  for (let i = 0; i < 4; i++) { g.ctx.copiaSeguridad(); g.avanzarDias(7); }
  const fecha = g.propiedades.ULTIMA_COPIA;
  g.fijarExportacion({ codigo: 500, bytes: 0 });
  assert.throws(function () { g.ctx.copiaSeguridad(); }, /No se pudo exportar/);
  g.fijarExportacion({ codigo: 200, bytes: 10 });
  assert.throws(function () { g.ctx.copiaSeguridad(); }, /vacía/);
  assert.strictEqual(g.copias().filter(function (f) { return !f.papelera; }).length, 4);
  assert.strictEqual(g.propiedades.ULTIMA_COPIA, fecha);
});

test('ping y datos devuelven la fecha de la última copia', function () {
  const g = crearEntorno({ propiedades: { TOKENS: JSON.stringify({ Sergio: 'clave-prueba' }) } });
  // La hoja necesita sus pestañas para 'datos'
  ['Productos', 'Movimientos', 'Objetivos', 'Config'].forEach(function (n) { g.ctx.SpreadsheetApp.getActive().insertSheet(n); });
  const llamar = function (accion) {
    return JSON.parse(g.ctx.doPost({ postData: { contents: JSON.stringify({ token: 'clave-prueba', accion: accion }) } }).texto);
  };
  assert.strictEqual(llamar('ping').ultimaCopia, '');
  g.ctx.copiaSeguridad();
  const p = llamar('ping');
  assert.strictEqual(p.version, 2.6);
  assert.strictEqual(p.ultimaCopia, g.propiedades.ULTIMA_COPIA);
  assert.strictEqual(llamar('datos').ultimaCopia, g.propiedades.ULTIMA_COPIA);
});
