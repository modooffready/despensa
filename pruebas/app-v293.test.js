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
  // Sondeo por tiempo y no por fotogramas: en un navegador sin pantalla los fotogramas pueden pararse y la espera no terminaría nunca
  const esperar = p.waitForFunction.bind(p);
  p.waitForFunction = function (fn, arg, op) {
    return esperar(fn, arg, Object.assign({ polling: 100 }, op || {})).catch(async function (e) {
      // Al agotar una espera, se añade el estado de la app al error para saber por qué no llegó
      let estado = '';
      try { estado = await p.evaluate(function () { return JSON.stringify({ pantalla: pantallaActual, sincronizando: sincronizando, error: ultimoError, objetivos: objetivos.length, stock: stockServidor.length, url: !!ajustes.url }); }); } catch (x) { estado = 'sin estado: ' + x.message; }
      e.message += ' · estado de la app: ' + estado + ' · errores: ' + JSON.stringify(errores);
      throw e;
    });
  };
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

test('v2.10.0: barra de abajo con la sección activa y botón flotante de Escanear', async function () {
  const hoy = new Date();
  const mes = function (d) { const f = new Date(hoy.getFullYear(), hoy.getMonth() + d, 1); return f.getFullYear() + '-' + String(f.getMonth() + 1).padStart(2, '0'); };
  const fila = function (id, cat, desc, cant, uni) { return { id: id, categoria: cat, descripcion: desc, cantidad_objetivo: cant, unidad: uni, almacen: T, notas: '' }; };
  const datos = { ok: true, version: 2.7, aceptados: [], rechazados: [],
    config: CONFIG.concat([{ tipo: 'CATEGORIA', valor: 'CONSERVAS', padre: 'DESPENSA', activo: true }]),
    objetivos: [fila('TA-01', 'BEBIDA', 'Agua embotellada, garrafa 6,25 L', '106,25', 'litros'), fila('TA-02', 'BEBIDA', 'Leche UHT entera', 6, 'litros'),
      fila('TA-08', 'CONSERVAS', 'Atún / sardinas / caballa en lata', 30, 'uds'), fila('TA-07', 'CONSERVAS', 'Legumbre cocida en bote', 20, 'uds')],
    productos: [{ codigo: 'G', nombre: 'Agua Font Vella 6,25 l', marca: 'Font Vella', categoria: 'BEBIDA', linea_objetivo: 'TA-01', unidad: 'litros', contenido: 6.25 },
      { codigo: 'L', nombre: 'Leche entera', marca: 'Carrefour', categoria: 'BEBIDA', linea_objetivo: 'TA-02', unidad: 'litros', contenido: 1 },
      { codigo: 'A', nombre: 'Bonito del norte en migas', categoria: 'CONSERVAS', linea_objetivo: 'TA-08', unidad: 'g', contenido: 80 },
      { codigo: 'M', nombre: 'Mejillones en escabeche', categoria: 'CONSERVAS', unidad: 'g', contenido: 115 }],
    stock: [['G', mes(22), 7], ['L', mes(5), 6], ['A', mes(30), 4], ['M', mes(1), 2]].map(function (r) { return { codigo: r[0], caducidad: r[1], almacen: T, estante: 'Estante 5', stock: r[2] }; }) };
  const a = await montar({
    off: function (c, rt) { return json(rt, { status: 0 }, 404); },
    servidor: function (b, rt) { return json(rt, datos); }
  });
  try {
    const p = a.p;
    await p.evaluate(function () { return guardarAjustes(); });
    await p.waitForFunction(function () { return !sincronizando && objetivos.length === 4; });
    const estado = function () {
      return p.evaluate(function () {
        const v = function (id) { return !document.getElementById(id).classList.contains('oculto'); };
        return { pantalla: pantallaActual, barra: v('pestanas'), fab: v('fab-escanear'),
          activa: Array.prototype.map.call(document.querySelectorAll('#pestanas button.activo'), function (b) { return b.id; }).join(','),
          titulo: document.getElementById('o-titulo').textContent };
      });
    };
    const foto = async function (n) { if (process.env.CAPTURAS) { await p.waitForTimeout(250); await p.screenshot({ path: '/tmp/nav-' + n + '.png' }); } };
    let e = await estado();
    assert.deepStrictEqual([e.pantalla, e.barra, e.fab, e.activa], ['inicio', true, false, 't-inicio'], 'Inicio: barra visible, sin botón flotante (ya tiene el grande)');
    await foto('1-inicio');
    await p.click('#t-stock');
    await p.waitForSelector('#pantalla-stock:not(.oculto)');
    e = await estado();
    assert.deepStrictEqual([e.pantalla, e.barra, e.fab, e.activa], ['stock', true, true, 't-stock']);
    await foto('2-stock');
    await p.click('#t-objetivos');
    await p.waitForSelector('#pantalla-objetivos:not(.oculto)');
    e = await estado();
    assert.deepStrictEqual([e.pantalla, e.activa, e.titulo], ['objetivos', 't-objetivos', '🎯 Objetivos']);
    assert.ok(await p.isVisible('#o-lista'));
    await p.click('.o-cab[data-cat="CONSERVAS"]');
    await foto('3-objetivos');
    await p.click('#t-compra');
    await p.waitForSelector('#o-compra:not(.oculto)');
    e = await estado();
    assert.deepStrictEqual([e.pantalla, e.activa, e.titulo, e.fab], ['objetivos', 't-compra', '🛒 Lista de la compra', true]);
    assert.match(await p.textContent('#o-texto'), /Atún \/ sardinas \/ caballa en lata: faltan 26 uds/);
    await foto('4-compra');
    // Desde Compra, abrir una ficha para editar: la barra y el botón flotante desaparecen; al cancelar se vuelve a Compra
    await p.evaluate(function () { return abrirFormulario('M', { editar: true }); });
    e = await estado();
    assert.deepStrictEqual([e.pantalla, e.barra, e.fab], ['formulario', false, false]);
    await p.click('#f-cancelar');
    await p.waitForSelector('#pantalla-objetivos:not(.oculto)');
    e = await estado();
    assert.strictEqual(e.activa, 't-compra', 'se conserva la sección en la que se estaba');
    // Escanear desde Stock y cancelar: vuelve a Stock, no a Inicio
    await p.click('#t-stock');
    await p.waitForSelector('#pantalla-stock:not(.oculto)');
    await p.evaluate(function () { origenEscaner = pantallaActual; mostrar('escaner'); });
    assert.deepStrictEqual((await estado()).barra, false);
    await p.click('#btn-cancelar-escaner');
    await p.waitForSelector('#pantalla-stock:not(.oculto)');
    assert.strictEqual((await estado()).activa, 't-stock');
    // El contenido no queda tapado por la barra: el final de la lista se puede ver por encima de ella
    const tapa = await p.evaluate(function () {
      window.scrollTo(0, document.body.scrollHeight);
      const ult = document.querySelector('#s-lista .prod:last-child').getBoundingClientRect(), barra = document.getElementById('pestanas').getBoundingClientRect();
      const fab = document.getElementById('fab-escanear').getBoundingClientRect();
      return ult.bottom <= barra.top && ult.bottom <= fab.top;
    });
    assert.ok(tapa, 'al llegar al final, el último producto queda por encima de la barra y del botón flotante');
    // Lo mismo en Compra: el último botón (Copiar) se ve entero
    await p.click('#t-compra');
    await p.waitForSelector('#o-compra:not(.oculto)');
    const copiar = await p.evaluate(function () {
      window.scrollTo(0, document.body.scrollHeight);
      return document.getElementById('o-copiar').getBoundingClientRect().bottom <= document.getElementById('fab-escanear').getBoundingClientRect().top;
    });
    assert.ok(copiar, 'el botón Copiar no queda bajo el botón flotante');
    assert.deepStrictEqual(a.errores, []);
  } finally { await a.cerrar(); }
});

// Servidor simulado con stock por lote, como el de verdad: rechaza una salida sin stock suficiente
function servidorConStock(inicial, opciones) {
  const stock = Object.assign({}, inicial), recibidos = [];
  const clave = function (m) { return [m.codigo, m.caducidad || '', m.almacen, m.estante || ''].join('|'); };
  return {
    recibidos: recibidos, stock: stock,
    responder: function (b, rt) {
      if (b.accion === 'movimientos') {
        const aceptados = [], rechazados = [];
        (b.movimientos || []).forEach(function (m) {
          const k = clave(m), d = m.tipo === 'SALIDA' ? -m.cantidad : m.cantidad;
          if ((opciones.rechazar && opciones.rechazar(m)) || (stock[k] || 0) + d < 0) { rechazados.push({ id: m.id, motivo: 'sin stock suficiente en ese lote (constan ' + (stock[k] || 0) + ')' }); return; }
          stock[k] = (stock[k] || 0) + d; recibidos.push(m); aceptados.push(m.id);
        });
        return json(rt, { ok: true, aceptados: aceptados, rechazados: rechazados });
      }
      return json(rt, { ok: true, version: 2.7, aceptados: [], rechazados: [], objetivos: opciones.objetivos || [], config: opciones.config, productos: opciones.productos,
        stock: Object.keys(stock).filter(function (k) { return stock[k]; }).map(function (k) { const p = k.split('|'); return { codigo: p[0], caducidad: p[1], almacen: p[2], estante: p[3], stock: stock[k] }; }) });
    }
  };
}
const CAJA = 'Caja 72 h';
const CONFIG_MOVER = CONFIG.concat([{ tipo: 'ESTANCIA', valor: CAJA, padre: '', activo: true },
  { tipo: 'UBICACION', valor: 'Estante 5', estancia: T, padre: T, activo: true }, { tipo: 'UBICACION', valor: 'Estante 6', estancia: T, padre: T, activo: true }]);
const lejos = (new Date().getFullYear() + 3) + '-05', cerca = (function () { const f = new Date(new Date().getFullYear(), new Date().getMonth() + 2, 1); return f.getFullYear() + '-' + String(f.getMonth() + 1).padStart(2, '0'); })();

test('v2.10.2: mover unidades del trastero a la Caja 72 h conserva la caducidad; deshacer devuelve las dos mitades', async function () {
  const inicial = {}; inicial['A|' + cerca + '|' + T + '|Estante 5'] = 3; inicial['A|' + lejos + '|' + T + '|Estante 5'] = 4;
  const srv = servidorConStock(inicial, { config: CONFIG_MOVER, productos: [{ codigo: 'A', nombre: 'Bonito del norte en migas', categoria: 'BEBIDA' }] });
  const a = await montar({ off: function (c, rt) { return json(rt, { status: 0 }, 404); }, servidor: srv.responder });
  try {
    const p = a.p;
    await p.evaluate(function () { return guardarAjustes(); });
    await p.waitForFunction(function () { return !sincronizando && stockServidor.length === 2; });
    await p.click('#t-stock');
    await p.waitForSelector('#pantalla-stock:not(.oculto)');
    await p.evaluate(function () { return abrirMover('A'); });
    await p.waitForSelector('#pantalla-mover:not(.oculto)');
    let e = await p.evaluate(function () {
      return { titulo: document.getElementById('m-titulo').textContent, lote: document.querySelector('#m-lotes .activo').textContent,
        destino: document.getElementById('m-destino').value, max: document.getElementById('m-max').textContent,
        barra: !document.getElementById('pestanas').classList.contains('oculto'), boton: document.getElementById('m-guardar').textContent,
        aviso: document.getElementById('m-aviso').classList.contains('oculto') };
    });
    assert.strictEqual(e.titulo, 'Mover: Bonito del norte en migas');
    assert.match(e.lote, new RegExp('Estante 5 · caduca ' + lejos.split('-').reverse().join('/') + ' · 4 unidades'), 'propone el lote que caduca más tarde');
    assert.strictEqual(e.destino, CAJA, 'propone la Caja 72 h como destino');
    assert.strictEqual(e.boton, 'Mover a Caja 72 h');
    assert.ok(e.aviso && !e.barra, 'sin aviso de caducidad y sin barra de secciones');
    // El lote que caduca pronto avisa si va a la Caja
    await p.click('#m-lotes .chip:first-child');
    assert.match(await p.textContent('#m-aviso'), /Caduca en menos de 6 meses/);
    await p.click('#m-lotes .chip:last-child');
    // No deja mover más de lo que hay
    await p.click('#m-mas'); await p.click('#m-mas'); await p.click('#m-mas'); await p.click('#m-mas'); await p.click('#m-mas');
    assert.strictEqual(await p.inputValue('#m-cantidad'), '4');
    await p.fill('#m-cantidad', '2');
    if (process.env.CAPTURAS) await p.screenshot({ path: '/tmp/mover.png' });
    await p.click('#m-guardar');
    await p.waitForSelector('#pantalla-stock:not(.oculto)');
    await p.waitForFunction(function () { return !sincronizando && stockServidor.length === 3; }, null, { timeout: 15000 });
    assert.deepStrictEqual(srv.recibidos.map(function (m) { return [m.tipo, m.cantidad, m.caducidad, m.almacen, m.estante, m.nota, m.traspaso].join(' | '); }), [
      'SALIDA | 2 | ' + lejos + ' | ' + T + ' | Estante 5 | Traspaso a Caja 72 h | ',
      'ENTRADA | 2 | ' + lejos + ' | Caja 72 h |  | Traspaso desde ' + T + ' · Estante 5 | '], 'salida y entrada, en ese orden, con la misma caducidad; el enlace no viaja al servidor');
    assert.strictEqual(srv.stock['A|' + lejos + '|Caja 72 h|'], 2);
    assert.strictEqual(srv.stock['A|' + lejos + '|' + T + '|Estante 5'], 2);
    // Deshacer desde cualquiera de las dos líneas devuelve las dos mitades
    await p.click('#t-inicio');
    await p.waitForSelector('#pantalla-inicio:not(.oculto)');
    assert.match(await p.textContent('#lista-historial'), /Traspaso a Caja 72 h/);
    await p.evaluate(async function () { const h = (await idb.todos('historial')).find(function (m) { return m.tipo === 'SALIDA'; }); await deshacer(h.id); });
    await p.waitForFunction(function () { return !sincronizando && stockServidor.length === 2; }, null, { timeout: 15000 });
    assert.strictEqual(srv.stock['A|' + lejos + '|Caja 72 h|'], 0);
    assert.strictEqual(srv.stock['A|' + lejos + '|' + T + '|Estante 5'], 4);
    assert.deepStrictEqual(srv.recibidos.slice(2).map(function (m) { return m.tipo + ' ' + m.almacen; }), ['SALIDA Caja 72 h', 'ENTRADA ' + T]);
    assert.deepStrictEqual(a.errores, []);
  } finally { await a.cerrar(); }
});

test('v2.10.2: si el servidor rechaza la salida de un traspaso, la entrada se anula sola y no se crea stock', async function () {
  const inicial = {}; inicial['A|' + lejos + '|' + T + '|Estante 5'] = 4;
  let rechazar = true;
  const srv = servidorConStock(inicial, { config: CONFIG_MOVER, productos: [{ codigo: 'A', nombre: 'Bonito', categoria: 'BEBIDA' }],
    rechazar: function (m) { return rechazar && m.tipo === 'SALIDA' && m.almacen === T; } });
  const a = await montar({ off: function (c, rt) { return json(rt, { status: 0 }, 404); }, servidor: srv.responder });
  try {
    const p = a.p;
    await p.evaluate(function () { return guardarAjustes(); });
    await p.waitForFunction(function () { return !sincronizando && stockServidor.length === 1; });
    await p.evaluate(function () { return abrirMover('A'); });
    await p.waitForSelector('#pantalla-mover:not(.oculto)');
    await p.click('#m-guardar');
    await p.waitForFunction(function () { return revision.length === 1; }, null, { timeout: 15000 });
    await p.waitForFunction(async function () { return !sincronizando && !(await idb.todos('pendientes')).length; }, null, { timeout: 15000 });
    await p.waitForTimeout(800);
    assert.strictEqual(srv.stock['A|' + lejos + '|Caja 72 h|'] || 0, 0, 'la entrada aceptada se compensa con una salida: no queda stock inventado en la Caja');
    assert.strictEqual(srv.stock['A|' + lejos + '|' + T + '|Estante 5'], 4, 'el trastero sigue igual');
    await p.evaluate(function () { abrirRevision(); });
    const bandeja = await p.textContent('#r-lista');
    assert.match(bandeja, /Era un traspaso y se ha anulado entero/);
    assert.strictEqual(await p.locator('#r-lista button[data-a="reintentar"], #r-lista button[data-a="corregir"]').count(), 0, 'un traspaso anulado no se puede reintentar a medias');
    assert.deepStrictEqual(a.errores, []);
  } finally { await a.cerrar(); }
});

test('v2.10.3: Compra propone primero qué pasar del trastero a la Caja 72 h y después qué comprar', async function () {
  const fila = function (id, cat, desc, cant, uni, alm) { return { id: id, categoria: cat, descripcion: desc, cantidad_objetivo: cant, unidad: uni, almacen: alm, notas: '' }; };
  const inicial = {};
  inicial['B|' + cerca + '|' + T + '|Estante 5'] = 3;   // caduca pronto: no debe ir a la Caja
  inicial['B|' + lejos + '|' + T + '|Estante 5'] = 4;
  inicial['S|' + lejos + '|' + T + '|Estante 5'] = 6;
  inicial['L|' + lejos + '|' + T + '|Estante 6'] = 3;
  inicial['V|' + lejos + '|' + T + '|Estante 6'] = 2;   // Varios: no se propone
  inicial['X|' + lejos + '|' + T + '|Estante 6'] = 5;   // sin subcategoría: no se propone
  const srv = servidorConStock(inicial, {
    config: CONFIG_MOVER.concat([{ tipo: 'CATEGORIA', valor: 'CONSERVAS', padre: 'DESPENSA', activo: true }]),
    objetivos: [fila('TA-08', 'CONSERVAS', 'Atún / sardinas / caballa en lata', 30, 'uds', T), fila('TA-07', 'CONSERVAS', 'Legumbre cocida en bote', 20, 'uds', T),
      fila('TA-02', 'BEBIDA', 'Leche UHT entera', 6, 'litros', T), fila('TA-51', 'BEBIDA', 'Varios', '', 'uds', T),
      fila('CJ-03', 'CONSERVAS', 'Atún / sardinas en lata', 9, 'uds', CAJA), fila('CJ-02', 'CONSERVAS', 'Legumbre cocida', 6, 'uds', CAJA),
      fila('CJ-05', 'BEBIDA', 'Leche UHT entera', 4, 'litros', CAJA), fila('CJ-06', 'BEBIDA', 'Bifrutas (brik 200 ml)', 6, 'uds', CAJA)],
    productos: [{ codigo: 'B', nombre: 'Bonito del norte', categoria: 'CONSERVAS', linea_objetivo: 'TA-08' },
      { codigo: 'S', nombre: 'Sardinas en aceite', categoria: 'CONSERVAS', linea_objetivo: 'TA-08' },
      { codigo: 'L', nombre: 'Leche entera', categoria: 'BEBIDA', linea_objetivo: 'TA-02', unidad: 'litros', contenido: 1 },
      { codigo: 'V', nombre: 'Vino tinto', categoria: 'BEBIDA', linea_objetivo: 'TA-51' },
      { codigo: 'X', nombre: 'Mejillones', categoria: 'CONSERVAS' }] });
  const a = await montar({ off: function (c, rt) { return json(rt, { status: 0 }, 404); }, servidor: srv.responder });
  try {
    const p = a.p;
    await p.evaluate(function () { return guardarAjustes(); });
    await p.waitForFunction(function () { return !sincronizando && stockServidor.length === 6 && objetivos.length === 8; });
    // En el trastero (el lugar principal) no hay nada que repartir: solo la lista de la compra de siempre
    await p.click('#t-compra');
    await p.waitForSelector('#o-compra:not(.oculto)');
    assert.strictEqual(await p.locator('#o-reparto .o-hecho').count(), 0);
    assert.match(await p.textContent('#o-texto'), /Atún \/ sardinas \/ caballa en lata: faltan 17 uds \(hay 13 de 30\)/);
    // En la Caja 72 h: primero lo que se puede traer
    await p.click('#o-almacenes .chip[data-a="Caja 72 h"]');
    await p.waitForSelector('#o-reparto .o-hecho');
    const sug = await p.evaluate(function () { return objVista.reparto.map(function (x) { return x.cantidad + ' ' + x.codigo + ' ' + x.lote.caducidad + ' ' + x.linea.o.id; }); });
    assert.deepStrictEqual(sug, ['3 L ' + lejos + ' CJ-05', '4 B ' + lejos + ' CJ-03', '5 S ' + lejos + ' CJ-03'],
      'lo que caduca más tarde primero; nada que caduque en menos de 6 meses; ni Varios ni productos sin subcategoría');
    assert.match(await p.textContent('#o-reparto'), /1 · Pasa de Trastero Ávila a Caja 72 h/);
    assert.strictEqual(await p.textContent('#o-compra-titulo'), '2 · Compra para Caja 72 h');
    const lista = await p.textContent('#o-texto');
    assert.doesNotMatch(lista, /Atún/, 'el atún se cubre entero con lo que hay en el trastero');
    assert.match(lista, /Leche UHT entera: faltan 1 litros \(hay 0 de 4 y puedes traer 3\)/);
    assert.match(lista, /Legumbre cocida: faltan 6 uds \(hay 0 de 6\)/);
    assert.match(lista, /Bifrutas \(brik 200 ml\): faltan 6 uds/);
    if (process.env.CAPTURAS) await p.screenshot({ path: '/tmp/reparto.png' });
    // «Hecho» en la primera sugerencia: se registra el traspaso y la lista se actualiza
    await p.click('#o-reparto .o-hecho >> nth=0');
    await p.waitForFunction(function () { return !sincronizando && objVista.reparto.length === 2 && stockServidor.some(function (l) { return l.almacen === 'Caja 72 h'; }); }, null, { timeout: 15000 });
    assert.strictEqual(srv.stock['L|' + lejos + '|Caja 72 h|'], 3);
    assert.strictEqual(srv.stock['L|' + lejos + '|' + T + '|Estante 6'], 0);
    assert.deepStrictEqual(await p.evaluate(function () { return objVista.reparto.map(function (x) { return x.cantidad + ' ' + x.codigo; }); }), ['4 B', '5 S']);
    assert.strictEqual(await p.evaluate(function () { return pantallaActual + ' ' + objVista.modo + ' ' + objVista.almacen; }), 'objetivos compra Caja 72 h', 'se queda en la misma pantalla');
    assert.deepStrictEqual(a.errores, []);
  } finally { await a.cerrar(); }
});
