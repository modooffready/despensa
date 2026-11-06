// Prueba de la pantalla Objetivos (app v2.8) con Playwright y un servidor simulado.
// Ejecutar: NODE_PATH=$(npm root -g) node --test pruebas/app-objetivos.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');

const RAIZ = path.join(__dirname, '..');
const T = 'Trastero Ávila', M = 'Mochila – Comida/agua';
const hoy = new Date();
const mes = function (d) { const f = new Date(hoy.getFullYear(), hoy.getMonth() + d, 1); return f.getFullYear() + '-' + String(f.getMonth() + 1).padStart(2, '0'); };

const DATOS = {
  ok: true, ultimaCopia: new Date().toISOString(),
  config: ['BEBIDA', 'PLATOS_PREPARADOS', 'CONSERVAS', 'COCINAR', 'SNACKS', 'MENAJE_Y_GAS', 'HIGIENE', 'BOTIQUIN']
    .map(function (c) { return { tipo: 'CATEGORIA', valor: c, padre: '', estancia: '', activo: true }; })
    .concat([T, M].map(function (e) { return { tipo: 'ESTANCIA', valor: e, padre: '', estancia: '', activo: true }; })),
  objetivos: [
    ['TA-01', 'BEBIDA', 'Agua embotellada, garrafa 6,25 L', 17, 'uds'], ['TA-02', 'BEBIDA', 'Leche UHT', 20, 'litros'],
    ['TA-06', 'PLATOS_PREPARADOS', 'Platos preparados en lata', 10, 'uds'],
    ['TA-07', 'CONSERVAS', 'Legumbre cocida en bote', 20, 'uds'], ['TA-08', 'CONSERVAS', 'Atún / sardinas / caballa en lata', 30, 'uds'],
    ['TA-11', 'COCINAR', 'Arroz', 4, 'kg'], ['TA-23', 'SNACKS', 'Frutos secos', '1,5', 'kg'],
    ['TA-26', 'MENAJE_Y_GAS', 'Abrelatas manual', 2, 'uds'], ['TA-31', 'HIGIENE', 'Papel higiénico', 16, 'rollos'],
    ['TA-40', 'BOTIQUIN', 'Medicación habitual', '', 'uds']
  ].map(function (r) { return { id: r[0], categoria: r[1], descripcion: r[2], cantidad_objetivo: r[3], unidad: r[4], almacen: T, notas: '' }; }),
  productos: [
    { codigo: 'G', nombre: 'Garrafa', categoria: 'BEBIDA', linea_objetivo: 'TA-01', unidad: 'litros', contenido: 6.25 },
    { codigo: 'L', nombre: 'Leche', categoria: 'BEBIDA', linea_objetivo: 'TA-02', unidad: 'ml', contenido: 1000 },
    { codigo: 'F', nombre: 'Fabada', categoria: 'PLATOS_PREPARADOS', unidad: 'g', contenido: 420 },
    { codigo: 'A', nombre: 'Atún', categoria: 'CONSERVAS', linea_objetivo: 'TA-08', unidad: 'g', contenido: 80 },
    { codigo: 'S', nombre: 'Sardinas', categoria: 'CONSERVAS', unidad: 'g', contenido: 90 },
    { codigo: 'R', nombre: 'Arroz', categoria: 'COCINAR', linea_objetivo: 'TA-11', unidad: 'kg', contenido: 1 },
    { codigo: 'R2', nombre: 'Arroz suelto', categoria: 'COCINAR', linea_objetivo: 'TA-11', unidad: 'uds' },
    { codigo: 'N', nombre: 'Nueces', categoria: 'SNACKS', linea_objetivo: 'TA-23', unidad: 'g', contenido: 500 },
    { codigo: 'P', nombre: 'Papel', categoria: 'HIGIENE', linea_objetivo: 'TA-31', unidad: 'rollos', contenido: 12 },
    { codigo: 'K', nombre: 'Ketchup', categoria: 'SALSAS', unidad: 'g', contenido: 560 },
    { codigo: 'AB', nombre: 'Abrelatas', categoria: 'MENAJE_Y_GAS', linea_objetivo: 'TA-26', tipo: 'EQUIPO', unidad: 'uds' }
  ],
  stock: [
    ['G', mes(40), T, 5], ['G', mes(40), M, 3], ['L', mes(12), T, 6], ['L', '2020-01', T, 2], ['F', mes(1), T, 4],
    ['A', mes(30), T, 12], ['S', mes(30), T, 3], ['R', mes(20), T, 2], ['R2', mes(20), T, 1], ['N', mes(8), T, 2],
    ['P', '', T, 1], ['K', mes(10), T, 2], ['AB', '', T, 2], ['AB', '', M, 1]
  ].map(function (r) { return { codigo: r[0], caducidad: r[1], almacen: r[2], estante: '', stock: r[3] }; })
};

test('pantalla Objetivos: avance por línea y lista de la compra', async function () {
  const srv = http.createServer(function (q, r) {
    const ruta = q.url.split('?')[0], f = path.join(RAIZ, ruta === '/' ? 'index.html' : ruta);
    try { const b = fs.readFileSync(f); r.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); r.end(b); }
    catch (e) { r.writeHead(404); r.end(); }
  });
  await new Promise(function (ok) { srv.listen(0, ok); });
  const navegador = await chromium.launch();
  try {
    const p = await navegador.newPage({ viewport: { width: 390, height: 800 } });
    const errores = [];
    p.on('pageerror', function (e) { errores.push(e.message); });
    await p.route('https://script.google.com/**', function (rt) {
      rt.fulfill({ contentType: 'application/json', body: JSON.stringify(Object.assign({ version: 2.6, aceptados: [], rechazados: [] }, DATOS)) });
    });
    await p.goto('http://localhost:' + srv.address().port + '/');
    await p.waitForFunction(function () { return typeof abrirAjustes === 'function' && document.getElementById('a-url'); });
    await p.evaluate(function () { abrirAjustes(); });
    await p.fill('#a-url', 'https://script.google.com/macros/s/X/exec');
    await p.fill('#a-token', 'k'); await p.fill('#a-usuario', 'Prueba');
    await p.evaluate(function () { return guardarAjustes(); });
    await p.waitForFunction(function () { return objetivos.length === 10; });

    const r = await p.evaluate(function () {
      const res = calcularObjetivos(lotesTodos([]), 'Trastero Ávila');
      const o = {};
      res.lineas.forEach(function (l) { o[l.o.id] = { tiene: l.tiene, falta: l.falta, completa: l.completa, pronto: l.pronto, caducado: l.caducado, sinContenido: l.sinContenido.length }; });
      return { lineas: o, sinLinea: res.sinLinea.map(function (x) { return x.codigo; }) };
    });
    const L = r.lineas;
    assert.strictEqual(L['TA-01'].tiene, 5, 'garrafas: cuenta envases y no la mochila');
    assert.strictEqual(L['TA-02'].tiene, 6, 'leche: ml → litros, sin el lote caducado');
    assert.strictEqual(L['TA-02'].caducado, 2);
    assert.strictEqual(L['TA-06'].tiene, 4, 'fabada sin línea cuenta por categoría (una sola línea)');
    assert.strictEqual(L['TA-06'].pronto, 4);
    assert.strictEqual(L['TA-08'].tiene, 12, 'sardinas sin línea no cuentan (categoría con varias líneas)');
    assert.deepStrictEqual(r.sinLinea, ['S'], 'el ketchup (categoría sin objetivos) no avisa');
    assert.strictEqual(L['TA-11'].tiene, 2); assert.strictEqual(L['TA-11'].sinContenido, 1);
    assert.strictEqual(L['TA-23'].tiene, 1); assert.ok(Math.abs(L['TA-23'].falta - 0.5) < 1e-9, '1,5 kg con coma');
    assert.strictEqual(L['TA-31'].tiene, 12, 'pack de 12 rollos');
    assert.strictEqual(L['TA-26'].completa, true, 'abrelatas (equipo) completo');
    assert.strictEqual(L['TA-40'].completa, false);

    // Pantalla
    await p.click('#t-stock'); await p.click('#s-objetivos');
    await p.waitForFunction(function () { return document.getElementById('o-resumen').textContent.length > 0; });
    const resumen = await p.textContent('#o-resumen');
    assert.match(resumen, /1 de 9 líneas completas · 1 sin cantidad decidida/);
    await p.click('.o-cab[data-cat="CONSERVAS"]');
    const conservas = await p.textContent('#o-lista');
    assert.match(conservas, /Atún \/ sardinas \/ caballa en lata\s*12 \/ 30/);
    assert.match(conservas, /Sardinas · asignar/);
    await p.click('#o-m-compra');
    const lista = await p.textContent('#o-texto');
    assert.match(lista, /Agua embotellada, garrafa 6,25 L: faltan 12 uds/);
    assert.match(lista, /Leche UHT: faltan 14 litros/);
    assert.match(lista, /Frutos secos: faltan 0,5 kg/);
    assert.doesNotMatch(lista, /Abrelatas|Medicación/);
    const marcar = await p.evaluate(function () { return objVista.textoMarcar; });
    assert.match(marcar, /^Agua embotellada, garrafa 6,25 L — 12 uds$/m);
    assert.doesNotMatch(marcar, /\*|Bebida|Lista de la compra/);
    // Asignar línea desde Objetivos abre la ficha y vuelve a Objetivos
    await p.click('#o-m-categorias');
    await p.click('.o-editar[data-c="S"]');
    await p.waitForSelector('#pantalla-formulario:not(.oculto)');
    assert.ok(await p.isVisible('#pantalla-formulario'));
    await p.click('#f-cancelar');
    await p.waitForSelector('#pantalla-objetivos:not(.oculto)');
    assert.ok(await p.isVisible('#pantalla-objetivos'));
    assert.deepStrictEqual(errores, []);
    if (process.env.CAPTURAS) { await p.click('.o-cab[data-cat="BEBIDA"]'); await p.screenshot({ path: '/tmp/objetivos.png', fullPage: true }); await p.click('#o-m-compra'); await p.screenshot({ path: '/tmp/compra.png', fullPage: true }); }
  } finally {
    await navegador.close(); srv.close();
  }
});
