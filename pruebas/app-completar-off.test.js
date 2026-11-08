// Productos escaneados sin red que se quedan sin nombre: tras sincronizar, el móvil los busca en
// Open Food Facts y envía el nombre (app v2.9.2). Una foto que falla no impide descargar los datos.
// Ejecutar: NODE_PATH=$(npm root -g) node --test pruebas/app-completar-off.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');

const RAIZ = path.join(__dirname, '..');
const T = 'Trastero Ávila';
const productos = [
  { codigo: '3560070468751', nombre: '', categoria: 'COCINAR', alta: 'pendiente', linea_objetivo: 'TA-12' },
  { codigo: '8718951686809', nombre: '', categoria: 'HIGIENE', alta: 'pendiente', foto_url: 'https://drive.google.com/propia' },
  { codigo: '8429871200234', nombre: '', categoria: '', alta: 'pendiente' },          // no está en OFF
  { codigo: 'INT-ABC', nombre: '', categoria: 'HIGIENE', alta: 'manual' }             // sin código de barras: no se busca
];
const OFF = {
  '3560070468751': { product_name_es: 'Harina de trigo', brands: 'Carrefour,Otra', product_quantity: 1000, product_quantity_unit: 'g', image_front_small_url: 'https://images.openfoodfacts.org/h.jpg' },
  '8718951686809': { product_name: 'Gel de ducha', brands: 'Sanex', product_quantity: 600, product_quantity_unit: 'ml', image_front_small_url: 'https://images.openfoodfacts.org/g.jpg' }
};

test('completa desde Open Food Facts los productos sin nombre y no se atasca con una foto', async function () {
  const srv = http.createServer(function (q, r) {
    const ruta = q.url.split('?')[0], f = path.join(RAIZ, ruta === '/' ? 'index.html' : ruta);
    try { const b = fs.readFileSync(f); r.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); r.end(b); }
    catch (e) { r.writeHead(404); r.end(); }
  });
  await new Promise(function (ok) { srv.listen(0, ok); });
  const navegador = await chromium.launch();
  try {
    const p = await navegador.newPage({ viewport: { width: 390, height: 800 } });
    const errores = [], fichasEnviadas = [], consultasOFF = [];
    let llamadasDatos = 0;
    p.on('pageerror', function (e) { errores.push(e.message); });
    await p.route(/openfoodfacts\.org\/api/, function (rt) {
      const c = rt.request().url().match(/product\/([^.]+)\.json/)[1];
      consultasOFF.push(c);
      rt.fulfill({ contentType: 'application/json', body: JSON.stringify(OFF[c] ? { status: 1, product: OFF[c] } : { status: 0 }) });
    });
    await p.route('https://script.google.com/**', function (rt) {
      const b = JSON.parse(rt.request().postData() || '{}');
      if (b.accion === 'foto') return rt.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'foto demasiado grande' }) });
      if (b.accion === 'movimientos') fichasEnviadas.push.apply(fichasEnviadas, b.productos || []);
      if (b.accion === 'datos') llamadasDatos++;
      const servidor = productos.map(function (x) {
        const enviada = fichasEnviadas.filter(function (f) { return f.codigo === x.codigo; }).pop();
        return Object.assign({}, x, enviada || {});
      });
      rt.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, version: 2.6, ultimaCopia: new Date().toISOString(),
        aceptados: (b.movimientos || []).map(function (m) { return m.id; }), rechazados: [],
        objetivos: [], config: [{ tipo: 'ESTANCIA', valor: T, padre: '', activo: true }], productos: servidor, stock: [] }) });
    });
    await p.goto('http://localhost:' + srv.address().port + '/');
    await p.waitForFunction(function () { return typeof abrirAjustes === 'function'; });
    // Una foto pendiente que el servidor va a rechazar
    await p.evaluate(async function () { fotosPend['3560070468751'] = 'data:image/jpeg;base64,AAAA'; await idb.poner('kv', fotosPend, 'fotosPend'); });
    await p.evaluate(function () { abrirAjustes(); });
    await p.fill('#a-url', 'https://script.google.com/macros/s/X/exec');
    await p.fill('#a-token', 'k'); await p.fill('#a-usuario', 'Prueba');
    await p.evaluate(function () { return guardarAjustes(); });
    // Espera a que se envíen los nombres encontrados (segunda sincronización automática)
    await p.waitForFunction(function () { return catalogo['3560070468751'] && catalogo['3560070468751'].nombre && !Object.keys(prodPend).length; }, null, { timeout: 15000 });
    await p.waitForTimeout(800);
    const estado = await p.evaluate(function () { return { cat: catalogo, error: ultimoError, fotos: Object.keys(fotosPend) }; });

    assert.ok(llamadasDatos >= 1, 'descarga los datos aunque falle la foto');
    assert.match(estado.error, /foto de 3560070468751/, 'avisa del fallo de la foto');
    assert.deepStrictEqual(estado.fotos, ['3560070468751'], 'la foto sigue pendiente para reintentarla');
    assert.deepStrictEqual(consultasOFF.sort(), ['3560070468751', '8429871200234', '8718951686809'], 'busca solo los códigos de barras sin nombre, una vez');
    const harina = fichasEnviadas.find(function (f) { return f.codigo === '3560070468751'; });
    assert.deepStrictEqual(harina, { codigo: '3560070468751', nombre: 'Harina de trigo', marca: 'Carrefour', contenido: 1, unidad: 'kg', foto_url: 'https://images.openfoodfacts.org/h.jpg' });
    const gel = fichasEnviadas.find(function (f) { return f.codigo === '8718951686809'; });
    assert.strictEqual(gel.nombre, 'Gel de ducha');
    assert.strictEqual(gel.foto_url, undefined, 'no sustituye una foto propia');
    assert.ok(!fichasEnviadas.find(function (f) { return f.codigo === '8429871200234'; }), 'lo que no está en OFF no se envía');
    assert.strictEqual(estado.cat['3560070468751'].categoria, 'COCINAR', 'conserva la categoría');
    // Otra sincronización no vuelve a consultar los ya intentados
    const antes = consultasOFF.length;
    await p.evaluate(function () { return sincronizar(true); });
    await p.waitForTimeout(500);
    assert.strictEqual(consultasOFF.length, antes, 'no repite consultas en la misma semana');
    assert.deepStrictEqual(errores, []);
  } finally {
    await navegador.close(); srv.close();
  }
});
