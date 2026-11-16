# despensa
## Pruebas
`NODE_PATH=$(npm root -g) node --test pruebas/*.test.js`
- `copia-seguridad.test.js`: `servidor/Codigo.gs` con un simulador de Apps Script (`pruebas/simulador-gas.js`).
- `app-objetivos.test.js`: la app en Chromium (Playwright) con un servidor simulado. Con `CAPTURAS=1` guarda capturas en /tmp.
- `app-v293.test.js`: Open Food Facts con errores temporales y fichas sin nombre, deshacer durante el envío, avisos de la pestaña Objetivos y packs en uds.
- `servidor-v27.test.js`: validación, stock por lote, envíos repetidos, productos, Objetivos por cabecera, REVISION y miniaturas del servidor v2.7.
