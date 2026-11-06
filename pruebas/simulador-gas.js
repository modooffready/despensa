/**
 * Simulador mínimo de Google Apps Script para probar servidor/Codigo.gs con Node.
 * Cubre lo que usa el servidor: SpreadsheetApp, DriveApp, PropertiesService,
 * ScriptApp (activadores), UrlFetchApp, Utilities, LockService, Logger, ContentService.
 * Uso: const gas = crearEntorno(); gas.ctx.copiaSeguridad(); ...
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function crearEntorno(opciones) {
  opciones = opciones || {};
  const registro = [];
  let reloj = opciones.ahora || Date.UTC(2026, 10, 9, 3, 0, 0);
  let secuencia = 0;

  // ---------- Drive ----------
  function crearArchivo(nombre, bytes, carpeta) {
    const f = {
      id: 'archivo' + (++secuencia), nombre: nombre, bytes: bytes, papelera: false,
      creado: new Date(reloj + secuencia), carpeta: carpeta,
      getName: function () { return this.nombre; },
      getId: function () { return this.id; },
      getDateCreated: function () { return this.creado; },
      setTrashed: function (v) { this.papelera = !!v; },
      isTrashed: function () { return this.papelera; },
      getUrl: function () { return 'https://drive.google.com/file/d/' + this.id + 'xxxxxxxxxxxxxxxxxxxx/view'; },
      getParents: function () { return iterador([carpeta]); }
    };
    carpeta.archivos.push(f);
    return f;
  }
  function crearCarpeta(nombre) {
    const c = {
      nombre: nombre, archivos: [], hijas: [],
      getName: function () { return this.nombre; },
      getFoldersByName: function (n) { return iterador(this.hijas.filter(function (h) { return h.nombre === n; })); },
      createFolder: function (n) { const h = crearCarpeta(n); this.hijas.push(h); return h; },
      getFiles: function () { return iterador(this.archivos.filter(function (a) { return !a.papelera; })); },
      createFile: function (blob) { return crearArchivo(blob.getName(), blob.getBytes(), this); }
    };
    return c;
  }
  function iterador(lista) {
    let i = 0;
    return { hasNext: function () { return i < lista.length; }, next: function () { return lista[i++]; } };
  }
  const raiz = crearCarpeta('Mi unidad');
  const carpetaDespensa = raiz.createFolder('Despensa');
  const archivoHoja = crearArchivo('Despensa – Inventario', [], carpetaDespensa);
  const ID_HOJA = archivoHoja.id;

  // ---------- Hoja de cálculo ----------
  const hojas = {};
  function crearHojaSim(nombre) {
    const h = {
      nombre: nombre, celdas: [],
      getName: function () { return nombre; },
      getLastRow: function () { return this.celdas.length; },
      getRange: function (fila, col, nf, nc) {
        const hoja = this;
        if (typeof fila === 'string') return { setNumberFormat: function () { return this; }, setValue: function () { return this; },
          setFontWeight: function () { return this; }, setFormula: function () { return this; } };
        nf = nf || 1; nc = nc || 1;
        return {
          getValues: function () {
            const res = [];
            for (let r = 0; r < nf; r++) { const fila2 = hoja.celdas[fila - 1 + r] || []; const out = []; for (let c = 0; c < nc; c++) out.push(fila2[col - 1 + c] === undefined ? '' : fila2[col - 1 + c]); res.push(out); }
            return res;
          },
          getValue: function () { return this.getValues()[0][0]; },
          setValues: function (v) { for (let r = 0; r < nf; r++) { hoja.celdas[fila - 1 + r] = hoja.celdas[fila - 1 + r] || []; for (let c = 0; c < nc; c++) hoja.celdas[fila - 1 + r][col - 1 + c] = v[r][c]; } return this; },
          setValue: function (v) { return this.setValues([[v]]); },
          setFontWeight: function () { return this; }, setNumberFormat: function () { return this; }, setFormula: function () { return this; }
        };
      },
      appendRow: function (r) { this.celdas.push(r.slice()); },
      setFrozenRows: function () {}, clear: function () { this.celdas = []; }
    };
    hojas[nombre] = h;
    return h;
  }
  const libro = {
    getId: function () { return ID_HOJA; },
    getSheetByName: function (n) { return hojas[n] || null; },
    insertSheet: function (n) { return crearHojaSim(n); },
    getSheets: function () { return Object.keys(hojas).map(function (k) { return hojas[k]; }); },
    deleteSheet: function (h) { delete hojas[h.nombre]; },
    getSpreadsheetLocale: function () { return 'es_ES'; }
  };

  // ---------- Servicios ----------
  const propiedades = Object.assign({}, opciones.propiedades || {});
  const activadores = [];
  let exportacion = opciones.exportacion || { codigo: 200, bytes: 15000 };

  const ctx = {
    console: console,
    Logger: { log: function (m) { registro.push(String(m)); } },
    SpreadsheetApp: { getActive: function () { return libro; }, getActiveSpreadsheet: function () { return libro; }, flush: function () {} },
    DriveApp: {
      getFileById: function (id) {
        const buscar = function (c) { for (const a of c.archivos) if (a.id === id) return a; for (const h of c.hijas) { const r = buscar(h); if (r) return r; } return null; };
        const f = buscar(raiz); if (!f) throw new Error('no existe ' + id); return f;
      },
      getRootFolder: function () { return raiz; }
    },
    PropertiesService: { getScriptProperties: function () { return {
      getProperty: function (k) { return k in propiedades ? propiedades[k] : null; },
      setProperty: function (k, v) { propiedades[k] = String(v); },
      deleteProperty: function (k) { delete propiedades[k]; }
    }; } },
    ScriptApp: {
      WeekDay: { MONDAY: 'MONDAY', SUNDAY: 'SUNDAY' },
      getOAuthToken: function () { return 'token-oauth-simulado'; },
      getProjectTriggers: function () { return activadores.slice(); },
      deleteTrigger: function (t) { const i = activadores.indexOf(t); if (i >= 0) activadores.splice(i, 1); },
      newTrigger: function (funcion) {
        const t = { funcion: funcion, getHandlerFunction: function () { return funcion; } };
        const b = { timeBased: function () { return b; }, onWeekDay: function (d) { t.dia = d; return b; },
          atHour: function (h) { t.hora = h; return b; }, inTimezone: function (z) { t.zona = z; return b; },
          create: function () { activadores.push(t); return t; } };
        return b;
      }
    },
    UrlFetchApp: { fetch: function (url, op) {
      registro.push('FETCH ' + url);
      if (/\/export\?format=xlsx/.test(url)) {
        if (!op || !op.headers || !/^Bearer /.test(op.headers.Authorization)) return respuesta(401, 0);
        return respuesta(exportacion.codigo, exportacion.bytes);
      }
      return respuesta(404, 0);
    } },
    Utilities: {
      getUuid: function () { return crypto.randomUUID(); },
      formatDate: function (d, zona, formato) {
        const p = new Intl.DateTimeFormat('es-ES', { timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
        const v = {}; p.forEach(function (x) { v[x.type] = x.value; });
        return formato.replace('yyyy', v.year).replace('MM', v.month).replace('dd', v.day).replace('HH', v.hour).replace('mm', v.minute).replace('ss', '00');
      },
      base64Encode: function (b) { return Buffer.from(b).toString('base64'); },
      base64Decode: function (s) { return Array.from(Buffer.from(s, 'base64')); },
      newBlob: function (bytes, tipo, nombre) { return blob(bytes, nombre); }
    },
    LockService: { getScriptLock: function () { return { waitLock: function () {}, releaseLock: function () {} }; } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: function (t) { return { texto: t, setMimeType: function () { return this; } }; } },
    Date: class extends Date { constructor(...a) { if (a.length) super(...a); else super(reloj); } static now() { return reloj; } }
  };
  function blob(bytes, nombre) {
    return { nombre: nombre, getBytes: function () { return bytes; }, getName: function () { return this.nombre; },
      setName: function (n) { this.nombre = n; return this; }, getContentType: function () { return 'application/octet-stream'; } };
  }
  function respuesta(codigo, n) {
    return { getResponseCode: function () { return codigo; }, getBlob: function () { return blob(new Array(n).fill(1), 'export.xlsx'); },
      getContentText: function () { return ''; } };
  }

  vm.createContext(ctx);
  const codigo = fs.readFileSync(path.join(__dirname, '..', 'servidor', 'Codigo.gs'), 'utf8');
  // const/let de nivel superior no quedan en ctx: se exponen las que necesitan las pruebas
  vm.runInContext(codigo + '\n;this.__const = { VERSION_SERVIDOR, COPIAS_A_GUARDAR, CARPETA_COPIAS, PREFIJO_COPIA };', ctx);

  return {
    ctx: ctx, registro: registro, propiedades: propiedades, activadores: activadores,
    carpetaDespensa: carpetaDespensa,
    avanzarDias: function (d) { reloj += d * 86400000; },
    fijarExportacion: function (e) { exportacion = e; },
    copias: function () {
      const c = carpetaDespensa.hijas.filter(function (h) { return h.nombre === ctx.__const.CARPETA_COPIAS; })[0];
      return c ? c.archivos : [];
    }
  };
}

module.exports = { crearEntorno };
