// App v2.9.3:
//  - F1: un error temporal de Open Food Facts (503, 429) no aparca el producto una semana.
//  - M2: una ficha de Open Food Facts sin nombre aporta marca, contenido y foto.
//  - N1: no se puede deshacer un movimiento mientras se está enviando.
//  - Avisos de la pestaña Objetivos: ids repetidos y almacenes que no son una estancia.
//  - Packs: «6 uds» en la ficha cuenta 6 en las líneas contables.
// Ejecutar: NODE_PATH=$(npm root -g) node --test pruebas/app-v293.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');

const RAIZ = path.join(__dirname, '..');
const T = 'Trastero Ávila';

async function montar(opciones) {
  const srv = http.createServer(function (q, r) {
    const ruta = q.url.split('?')[0], f = path.join(RAIZ, ruta === '/' ? 'index.html' : ruta);
    try { const b = fs.readFileSync(f); r.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); r.end(b); }
    catch (e) { r.writeHead(404); r.end(); }
  });
  await new Promise(function (ok) { srv.listen(0, ok); });
  const navegador = await chromium.launch();
  const p = await navegador.newPage({ viewport: { width: 390, height: 800 } });
  const errores = [];
  p.on('pageerror', function (e) { errores.push(e.message); });
  await p.route(/openfoodfacts\.org\/api/, function (rt) {
    const c = rt.request().url().match(/product\/([^.]+)\.json/)[1];
    return opciones.off(c, rt);
  });
  await p.route('https://script.google.com/**', function (rt) {
    return opciones.servidor(JSON.parse(rt.request().postData() || '{}'), rt);
  });
  await p.goto('http://localhost:' + srv.address().port + '/');
  await p.waitForFunction(function () { return typeof abrirAjustes === 'function'; });
  await p.evaluate(function () { abrirAjustes(); });
  await p.fill('#a-url', 'https://script.google.com/macros/s/X/exec');
  await p.fill('#a-token', 'k'); await p.fill('#a-usuario', 'Prueba');
  return { p: p, errores: errores, cerrar: async function () { await navegador.close(); srv.close(); } };
}
function json(rt, cuerpo, estado) { return rt.fulfill({ status: estado || 200, contentType: 'application/json', body: JSON.stringify(cuerpo) }); }
const CONFIG = [{ tipo: 'ESTANCIA', valor: T, padre: '', activo: true }, { tipo: 'ESTANCIA', valor: 'Peugeot 5008', padre: '', activo: true },
  { tipo: 'CATEGORIA', valor: 'BEBIDA', padre: 'DESPENSA', activo: true }, { tipo: 'CATEGORIA', valor: 'HIGIENE', padre: 'MATERIAL', activo: true }];

test('Open Food Facts: un 503 se reintenta; un 404 se aparca; una ficha sin nombre aporta la marca', async function () {
  const productos = [
    { codigo: '8400000000017', nombre: '', categoria: '', alta: 'pendiente' },   // 503 la primera vez, luego responde
    { codigo: '8400000000024', nombre: '', categoria: '', alta: 'pendiente' },   // 404: no existe
    { codigo: '3560070213689', nombre: '', categoria: 'HIGIENE', alta: 'pendiente' } // existe, sin nombre, con marca
  ];
  const consultas = [], fichas = [];
  let fallar = true;
  const a = await montar({
    off: function (c, rt) {
      consultas.push(c);
      if (c === '3560070213689') return json(rt, { status: 1, product: { product_name: '', brands: 'Carrefour', image_front_small_url: 'https://images.openfoodfacts.org/c.jpg' } });
      if (c === '8400000000024') return json(rt, { status: 0, status_verbose: 'product not found' }, 404);
      if (fallar) return rt.fulfill({ status: 503, contentType: 'text/html', body: '<html>Service Unavailable</html>' });
      return json(rt, { status: 1, product: { generic_name_es: 'Tomate frito', brands: 'Hacendado', product_quantity: 400, product_quantity_unit: 'g' } });
    },
    servidor: function (b, rt) {
      if (b.accion === 'movimientos') fichas.push.apply(fichas, b.productos || []);
      const srvProd = productos.map(function (x) {
        return Object.assign.apply(null, [{}, x].concat(fichas.filter(function (f) { return f.codigo === x.codigo; })));
      });
      return json(rt, { ok: true, version: 2.6, aceptados: [], rechazados: [], objetivos: [], config: CONFIG, productos: srvProd, stock: [] });
    }
  });
  try {
    const p = a.p;
    // Orden de consulta estable: primero el 404 y la ficha parcial, al final el que da 503
    await p.evaluate(function () { return guardarAjustes(); });
    await p.waitForFunction(function () { return catalogo['3560070213689'] && catalogo['3560070213689'].marca === 'Carrefour' && !Object.keys(prodPend).length && !sincronizando; }, null, { timeout: 15000 });
    let e = await p.evaluate(function () { return { off: Object.keys(offIntentados), cat: catalogo }; });
    assert.ok(e.off.indexOf('8400000000017') < 0, 'el código que dio 503 no queda aparcado');
    assert.ok(e.off.indexOf('8400000000024') >= 0, 'el 404 sí queda aparcado una semana');
    assert.ok(e.off.indexOf('3560070213689') >= 0, 'la ficha sin nombre no se vuelve a pedir en una semana');
    assert.strictEqual(e.cat['3560070213689'].nombre || '', '', 'sigue sin nombre (hay que escribirlo)');
    assert.strictEqual(e.cat['3560070213689'].foto_url, 'https://images.openfoodfacts.org/c.jpg');
    const parcial = fichas.find(function (f) { return f.codigo === '3560070213689'; });
    assert.deepStrictEqual(parcial, { codigo: '3560070213689', marca: 'Carrefour', foto_url: 'https://images.openfoodfacts.org/c.jpg' }, 'envía la marca y la foto aunque no haya nombre');
    assert.strictEqual(await p.evaluate(function () { return incompletos().length; }), 3, 'los tres siguen en «Completar»');

    // Open Food Facts vuelve a funcionar: la siguiente sincronización completa el que falló
    fallar = false;
    await p.evaluate(function () { return sincronizar(true); });
    await p.waitForFunction(function () { return catalogo['8400000000017'] && catalogo['8400000000017'].nombre === 'Tomate frito' && !Object.keys(prodPend).length && !sincronizando; }, null, { timeout: 15000 });
    const tomate = fichas.find(function (f) { return f.codigo === '8400000000017'; });
    assert.deepStrictEqual(tomate, { codigo: '8400000000017', nombre: 'Tomate frito', marca: 'Hacendado', contenido: 400, unidad: 'g' }, 'usa el nombre genérico si no hay otro');
    assert.strictEqual(consultas.filter(function (c) { return c === '8400000000024'; }).length, 1, 'el 404 no se repite');
    assert.strictEqual(consultas.filter(function (c) { return c === '3560070213689'; }).length, 1, 'la ficha parcial no se repite');
    assert.deepStrictEqual(a.errores, []);
  } finally { await a.cerrar(); }
});

test('formulario: un error temporal de Open Food Facts no dice «No está en Open Food Facts»', async function () {
  const a = await montar({
    off: function (c, rt) { return rt.fulfill({ status: 429, contentType: 'text/plain', body: 'Too Many Requests' }); },
    servidor: function (b, rt) { return json(rt, { ok: true, version: 2.6, aceptados: [], rechazados: [], objetivos: [], config: CONFIG, productos: [], stock: [] }); }
  });
  try {
    const p = a.p;
    await p.evaluate(function () { return guardarAjustes(); });
    await p.waitForFunction(function () { return !sincronizando && listas.length; });
    await p.evaluate(function () { return abrirFormulario('8400000000031'); });
    await p.waitForFunction(function () { return /no responde ahora/.test(document.getElementById('f-off').textContent); }, null, { timeout: 10000 });
    const txt = await p.textContent('#f-off');
    assert.match(txt, /error 429/);
    assert.doesNotMatch(txt, /No está en Open Food Facts/);
    assert.deepStrictEqual(a.errores, []);
  } finally { await a.cerrar(); }
});

test('no se puede deshacer un movimiento mientras se está enviando', async function () {
  const recibidos = [];
  let soltar;
  const espera = new Promise(function (ok) { soltar = ok; });
  const a = await montar({
    off: function (c, rt) { return json(rt, { status: 0 }, 404); },
    servidor: async function (b, rt) {
      if (b.accion === 'movimientos' && (b.movimientos || []).length) {
        recibidos.push.apply(recibidos, b.movimientos);
        await espera; // el servidor tarda: el movimiento está «en vuelo»
        return json(rt, { ok: true, aceptados: b.movimientos.map(function (m) { return m.id; }), rechazados: [] });
      }
      const stock = {};
      recibidos.forEach(function (m) { stock[m.codigo] = (stock[m.codigo] || 0) + (m.tipo === 'SALIDA' ? -m.cantidad : m.cantidad); });
      return json(rt, { ok: true, version: 2.6, aceptados: [], rechazados: [], objetivos: [], config: CONFIG,
        productos: [{ codigo: 'INT-AGUA', nombre: 'Agua', categoria: 'BEBIDA' }],
        stock: Object.keys(stock).filter(function (c) { return stock[c]; }).map(function (c) { return { codigo: c, caducidad: '', almacen: T, estante: '', stock: stock[c] }; }) });
    }
  });
  try {
    const p = a.p;
    await p.evaluate(function () { return guardarAjustes(); });
    await p.waitForFunction(function () { return !sincronizando && listas.length; });
    // Entrada de 2 unidades; se empieza a enviar y, antes de que el servidor conteste, se pulsa Deshacer
    const estado = await p.evaluate(async function (T) {
      const mov = { id: 'mov-1', fecha: new Date().toISOString(), usuario: 'Prueba', tipo: 'ENTRADA', codigo: 'INT-AGUA', cantidad: 2, caducidad: '', almacen: T, estante: '', nota: '' };
      await idb.poner('pendientes', mov);
      await idb.poner('historial', Object.assign({}, mov, { nombre: 'Agua', estado: 'pendiente' }));
      sincronizar(false);
      await new Promise(function (ok) { setTimeout(ok, 300); });
      await deshacer('mov-1');
      return { sincronizando: sincronizando, pendiente: !!(await idb.get('pendientes', 'mov-1')), historial: !!(await idb.get('historial', 'mov-1')), aviso: document.getElementById('toast').textContent };
    }, T);
    assert.strictEqual(estado.sincronizando, true, 'el envío seguía en curso');
    assert.strictEqual(estado.pendiente, true, 'el movimiento no se borra del móvil');
    assert.strictEqual(estado.historial, true, 'sigue en la lista para poder deshacerlo después');
    assert.match(estado.aviso, /enviando/);
    soltar();
    await p.waitForFunction(function () { return !sincronizando && stockServidor.length === 1; }, null, { timeout: 15000 });
    // Ya enviado: ahora Deshacer registra la salida contraria y el stock vuelve a cero
    await p.evaluate(function () { return deshacer('mov-1'); });
    await p.waitForFunction(function () { return !sincronizando && stockServidor.length === 0; }, null, { timeout: 15000 });
    assert.deepStrictEqual(recibidos.map(function (m) { return m.tipo + ' ' + m.cantidad; }), ['ENTRADA 2', 'SALIDA 2']);
    assert.deepStrictEqual(a.errores, []);
  } finally { await a.cerrar(); }
});

test('Objetivos: avisa de ids repetidos y de almacenes que no son una estancia; los packs en uds cuentan su contenido', async function () {
  const fila = function (id, desc, cant, uni, alm) { return { id: id, categoria: 'BEBIDA', descripcion: desc, cantidad_objetivo: cant, unidad: uni, almacen: alm, notas: '' }; };
  const datos = { ok: true, version: 2.6, aceptados: [], rechazados: [], config: CONFIG,
    objetivos: [fila('TA-46', 'Batidos (brik 200 ml)', 18, 'uds', T), fila('TA-31', 'Papel higiénico', 16, 'rollos', T),
      fila('CJ-20', 'Batidos (brik 200 ml)', 6, 'uds', 'Caja 72 h'), fila('CJ-20', 'Leche UHT desnatada', 1, 'litros', 'Caja 72 h'),
      fila('PE-01', 'Agua en brik', 10, 'uds', 'Kit Peugeot 5008')],
    productos: [{ codigo: 'B', nombre: 'Batido pack 6', categoria: 'BEBIDA', linea_objetivo: 'TA-46', unidad: 'uds', contenido: 6 },
      { codigo: 'B1', nombre: 'Batido suelto', categoria: 'BEBIDA', linea_objetivo: 'TA-46', unidad: 'uds' }],
    stock: [{ codigo: 'B', caducidad: '', almacen: T, estante: '', stock: 2 }, { codigo: 'B1', caducidad: '', almacen: T, estante: '', stock: 1 }] };
  const a = await montar({
    off: function (c, rt) { return json(rt, { status: 0 }, 404); },
    servidor: function (b, rt) { return json(rt, datos); }
  });
  try {
    const p = a.p;
    await p.evaluate(function () { return guardarAjustes(); });
    await p.waitForFunction(function () { return !sincronizando && objetivos.length === 5; });
    const r = await p.evaluate(async function (T) {
      await abrirObjetivos();
      const calc = calcularObjetivos(lotesTodos([]), T);
      return { problemas: problemasObjetivos(), caja: document.getElementById('o-problemas').textContent,
        batidos: calc.lineas.find(function (l) { return l.o.id === 'TA-46'; }).tiene,
        aportes: [aportePorEnvase({ unidad: 'uds', contenido: 12 }, 'uds'), aportePorEnvase({ unidad: 'uds', contenido: 6 }, 'rollos'),
          aportePorEnvase({ unidad: 'rollos', contenido: 12 }, 'rollos'), aportePorEnvase({ unidad: 'uds' }, 'uds'),
          aportePorEnvase({ unidad: 'g', contenido: 400 }, 'uds'), aportePorEnvase({ unidad: 'uds', contenido: 6 }, 'litros'),
          aportePorEnvase({ unidad: 'litros', contenido: 1.5 }, 'litros')] };
    }, T);
    assert.strictEqual(r.problemas.length, 3);
    assert.match(r.problemas[0], /id repetido: CJ-20/);
    assert.match(r.problemas.join('|'), /«Caja 72 h» no es una estancia/);
    assert.match(r.problemas.join('|'), /«Kit Peugeot 5008» no es una estancia/);
    assert.match(r.caja, /Revisa la pestaña Objetivos/);
    assert.strictEqual(r.batidos, 13, '2 packs de 6 + 1 brik suelto = 13');
    assert.deepStrictEqual(r.aportes, [12, 6, 12, 1, 1, null, 1.5]);
    assert.deepStrictEqual(a.errores, []);
  } finally { await a.cerrar(); }
});

test('v2.9.4: subcategoría «Varios» y textos sin la palabra «línea»', async function () {
  const fila = function (id, cat, desc, cant, uni, alm) { return { id: id, categoria: cat, descripcion: desc, cantidad_objetivo: cant, unidad: uni, almacen: alm, notas: '' }; };
  const C = 'Caja 72 h', PE = 'Peugeot 5008';
  const datos = { ok: true, version: 2.7, aceptados: [], rechazados: [],
    config: CONFIG.concat([{ tipo: 'ESTANCIA', valor: C, padre: '', activo: true }]),
    objetivos: [fila('TA-01', 'BEBIDA', 'Agua embotellada', 100, 'litros', T), fila('TA-51', 'BEBIDA', 'Varios', '', 'uds', T),
      fila('CJ-05', 'BEBIDA', 'Leche UHT entera', 4, 'litros', C), fila('CJ-06', 'BEBIDA', 'Bifrutas', 6, 'uds', C),
      fila('PE-01', 'BEBIDA', 'Agua en brik', 10, 'uds', PE)],
    productos: [{ codigo: 'V', nombre: 'Vino tinto', categoria: 'BEBIDA', linea_objetivo: 'TA-51', unidad: 'ml', contenido: 750 },
      { codigo: 'X', nombre: 'Refresco', categoria: 'BEBIDA' }],
    stock: [{ codigo: 'V', caducidad: '', almacen: T, estante: '', stock: 3 }, { codigo: 'V', caducidad: '', almacen: C, estante: '', stock: 1 },
      { codigo: 'V', caducidad: '', almacen: PE, estante: '', stock: 2 }, { codigo: 'X', caducidad: '', almacen: T, estante: '', stock: 1 }] };
  const a = await montar({
    off: function (c, rt) { return json(rt, { status: 0 }, 404); },
    servidor: function (b, rt) { return json(rt, datos); }
  });
  try {
    const p = a.p;
    await p.evaluate(function () { return guardarAjustes(); });
    await p.waitForFunction(function () { return !sincronizando && objetivos.length === 5; });
    const r = await p.evaluate(async function (x) {
      const de = function (alm) { const c = calcularObjetivos(lotesTodos([]), alm); return { sin: c.sinLinea.map(function (s) { return s.codigo; }), tiene: c.lineas.map(function (l) { return l.o.id + '=' + l.tiene; }) }; };
      const res = { trastero: de(x.T), caja: de(x.C), coche: de(x.PE) };
      objVista.almacen = x.T; await abrirObjetivos();
      document.querySelector('.o-cab[data-cat="BEBIDA"]').click();
      res.pantalla = document.getElementById('pantalla-objetivos').textContent;
      res.etiqueta = document.querySelector('label + select#p-linea').previousElementSibling.textContent;
      return res;
    }, { T: T, C: C, PE: PE });
    assert.deepStrictEqual(r.trastero, { sin: ['X'], tiene: ['TA-01=0', 'TA-51=3'] }, 'en su lugar, Varios guarda el producto; el que no tiene subcategoría avisa');
    assert.deepStrictEqual(r.caja, { sin: [], tiene: ['CJ-05=0', 'CJ-06=0'] }, 'en la Caja ni cuenta para otra subcategoría ni avisa');
    assert.deepStrictEqual(r.coche, { sin: [], tiene: ['PE-01=0'] }, 'en el coche no cuenta como agua por ser la única subcategoría de Bebida');
    assert.match(r.pantalla, /0 de 1 objetivo completo/);
    assert.match(r.pantalla, /1 producto sin subcategoría/);
    assert.match(r.pantalla, /Varios\s*3 uds · sin objetivo/);
    assert.match(r.pantalla, /Vino tinto · 3 envases/);
    assert.doesNotMatch(r.pantalla, /línea|por categoría|env\./);
    assert.strictEqual(r.etiqueta, 'Subcategoría (opcional)');
    assert.deepStrictEqual(a.errores, []);
  } finally { await a.cerrar(); }
});
