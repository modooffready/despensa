// Editar una ficha no debe sumar stock; deshacer cualquier movimiento de la lista (app v2.8.3).
// Ejecutar: NODE_PATH=$(npm root -g) node --test pruebas/app-ficha.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');

const RAIZ = path.join(__dirname, '..');
const T = 'Trastero Ávila';
const DATOS = {
  ok: true, version: 2.6, ultimaCopia: new Date().toISOString(),
  objetivos: [{ id: 'TA-15', categoria: 'CONDIMENTOS', descripcion: 'Sal', cantidad_objetivo: 1, unidad: 'kg', almacen: T },
              { id: 'TA-16', categoria: 'CONDIMENTOS', descripcion: 'Azúcar', cantidad_objetivo: 1, unidad: 'kg', almacen: T }],
  config: [{ tipo: 'CATEGORIA', valor: 'CONDIMENTOS', padre: 'DESPENSA', estancia: 'DESPENSA', activo: true },
           { tipo: 'CATEGORIA', valor: 'SALSAS', padre: 'DESPENSA', estancia: 'DESPENSA', activo: true },
           { tipo: 'CATEGORIA', valor: 'HIGIENE', padre: 'MATERIAL', estancia: 'MATERIAL', activo: true },
           { tipo: 'CATEGORIA', valor: 'EQUIPO', padre: 'MATERIAL', estancia: 'MATERIAL', activo: true },
           { tipo: 'ESTANCIA', valor: T, padre: '', estancia: '', activo: true }],
  productos: [{ codigo: '8410000000001', nombre: 'Ketchup', categoria: 'CONDIMENTOS', unidad: 'g', contenido: 560 },
              { codigo: '8410000000002', nombre: 'Salsa de soja con menos sal', categoria: 'CONDIMENTOS', linea_objetivo: 'TA-15' }],
  stock: [{ codigo: '8410000000001', caducidad: '2030-01', almacen: T, estante: '', stock: 3 }]
};

test('editar ficha no registra movimiento; deshacer vale para cualquier movimiento', async function () {
  const srv = http.createServer(function (q, r) {
    const ruta = q.url.split('?')[0], f = path.join(RAIZ, ruta === '/' ? 'index.html' : ruta);
    try { const b = fs.readFileSync(f); r.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); r.end(b); }
    catch (e) { r.writeHead(404); r.end(); }
  });
  await new Promise(function (ok) { srv.listen(0, ok); });
  const navegador = await chromium.launch();
  try {
    const p = await navegador.newPage({ viewport: { width: 390, height: 800 } });
    const errores = [], enviados = [];
    p.on('pageerror', function (e) { errores.push(e.message); });
    let conexion = true;
    await p.route('https://script.google.com/**', function (rt) {
      if (!conexion) return rt.abort();
      const b = JSON.parse(rt.request().postData() || '{}');
      if (b.accion === 'movimientos') enviados.push.apply(enviados, b.movimientos || []);
      rt.fulfill({ contentType: 'application/json', body: JSON.stringify(Object.assign({ aceptados: (b.movimientos || []).map(function (m) { return m.id; }), rechazados: [] }, DATOS)) });
    });
    await p.goto('http://localhost:' + srv.address().port + '/');
    await p.waitForFunction(function () { return typeof abrirAjustes === 'function'; });
    await p.evaluate(function () { abrirAjustes(); });
    await p.fill('#a-url', 'https://script.google.com/macros/s/X/exec');
    await p.fill('#a-token', 'k'); await p.fill('#a-usuario', 'Prueba');
    await p.evaluate(function () { return guardarAjustes(); });
    await p.waitForFunction(function () { return Object.keys(catalogo).length === 2; });
    conexion = false; // así los movimientos quedan pendientes y se pueden contar

    // 0) Con «Material» elegido arriba, un producto de Despensa muestra las categorías de Despensa
    await p.evaluate(function () { ajustes.modo = 'MATERIAL'; });
    // 1) Editar ficha (como desde «✏️ Editar ficha»): sin entrada/salida y con «Guardar cambios»
    await p.evaluate(function () { return abrirFormulario('8410000000001', { editar: true }); });
    assert.ok(await p.isVisible('#p-categorias >> text=Salsas'), 'Salsas visible aunque el modo de arriba sea Material');
    assert.ok(await p.isHidden('#f-mov'), 'oculta entrada/salida');
    assert.ok(await p.isHidden('#f-guardar-seguir')); assert.ok(await p.isHidden('#f-guardar'));
    assert.ok(await p.isVisible('#f-guardar-cambios'));
    await p.click('#p-categorias >> text=Salsas');
    await p.click('#f-guardar-cambios');
    await p.waitForSelector('#pantalla-formulario.oculto', { state: 'attached' });
    const tras = await p.evaluate(async function () { return { pend: (await idb.todos('pendientes')).length, cat: catalogo['8410000000001'].categoria }; });
    assert.deepStrictEqual(tras, { pend: 0, cat: 'SALSAS' }, 'cambia la categoría sin sumar stock');

    // 2) Editar y pedir también un movimiento: vuelven los botones, con el tipo en el texto
    await p.evaluate(function () { return abrirFormulario('8410000000001', { editar: true }); });
    await p.click('#f-con-mov');
    assert.ok(await p.isVisible('#f-mov'));
    assert.strictEqual((await p.textContent('#f-guardar')).trim(), 'Guardar entrada y terminar');
    await p.click('#f-salida');
    assert.strictEqual((await p.textContent('#f-guardar')).trim(), 'Guardar salida y terminar');
    await p.click('#f-cancelar');

    // 3) Al escanear (sin editar) se ven los botones de movimiento
    await p.evaluate(function () { return abrirFormulario('8410000000001'); });
    assert.ok(await p.isVisible('#f-mov')); assert.ok(await p.isHidden('#f-guardar-cambios'));
    // Dos entradas seguidas; se deshace la primera (no la última)
    await p.click('#f-guardar');
    await p.waitForSelector('#pantalla-inicio:not(.oculto)');
    await p.evaluate(function () { return abrirFormulario('8410000000001'); });
    await p.click('#f-guardar');
    await p.waitForFunction(async function () { return (await idb.todos('pendientes')).length === 2; });
    await p.waitForFunction(function () { return document.querySelectorAll('#lista-historial .deshacer').length === 2; }, null, { timeout: 5000 }).catch(function () {});
    const botones = await p.$$('#lista-historial .deshacer');
    assert.strictEqual(botones.length, 2, 'cada movimiento tiene su Deshacer');
    // Dos toques seguidos (el segundo confirma), en el mismo instante para que no se repinte la lista entre medias
    await p.evaluate(function () { const b = document.querySelectorAll('#lista-historial .deshacer')[1]; b.click(); b.click(); });
    await p.waitForFunction(async function () { return (await idb.todos('pendientes')).length === 1; });
    // 4) Soja mal asignada a «Sal»: al pasarla a Salsas se quita la línea y se guarda NINGUNA
    await p.evaluate(function () { return abrirFormulario('8410000000002', { editar: true }); });
    assert.strictEqual(await p.inputValue('#p-linea'), 'TA-15');
    assert.strictEqual(await p.evaluate(function () { return puntuarLinea(objetivos[0]); }), 0, '«menos sal» no puntúa para Sal');
    await p.click('#p-categorias >> text=Salsas');
    assert.strictEqual(await p.inputValue('#p-linea'), '');
    await p.click('#f-guardar-cambios');
    await p.waitForFunction(function () { return catalogo['8410000000002'].linea_objetivo === 'NINGUNA' && catalogo['8410000000002'].categoria === 'SALSAS'; });
    const r = await p.evaluate(function () { return calcularObjetivos(lotesTodos([]), 'Trastero Ávila').lineas.map(function (l) { return l.productos.length; }); });
    assert.deepStrictEqual(r, [0, 0]);
    // 5) «Aceite de motor» se sugiere como EQUIPO, no como Condimentos
    const sug = await p.evaluate(function () {
      document.getElementById('p-nombre').value = 'Aceite de motor 5W30';
      return sugerirCategorias()[0].cat;
    });
    assert.strictEqual(sug, 'EQUIPO');
    assert.deepStrictEqual(errores, []);
  } finally {
    await navegador.close(); srv.close();
  }
});
