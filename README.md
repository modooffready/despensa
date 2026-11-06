# despensa
## Pruebas
`NODE_PATH=$(npm root -g) node --test pruebas/*.test.js`
- `copia-seguridad.test.js`: `servidor/Codigo.gs` con un simulador de Apps Script (`pruebas/simulador-gas.js`).
- `app-objetivos.test.js`: la app en Chromium (Playwright) con un servidor simulado. Con `CAPTURAS=1` guarda capturas en /tmp.
