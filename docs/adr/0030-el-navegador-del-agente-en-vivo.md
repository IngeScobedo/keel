# ADR-0030: El navegador del agente, de primer nivel y en vivo en la GUI

- **Estado:** Propuesto
- **Fecha:** 2026-10-26; revisado el 2026-10-28 para la superficie de foco
  (ADR-0034)
- **Criticidad:** Alta
- **Relacionados:**
  - ADR-0014 (integraciones): es la primera integración de nivel 3, nativa.
    Playwright era su ejemplo.
  - ADR-0005 (protocolo), ADR-0004 (store), ADR-0012 (artefactos y evidencia),
    ADR-0011 (eventos semánticos).
  - ADR-0009 (puente MCP), ADR-0019 (reglas del gate), ADR-0018 y ADR-0025 §10
    (sandbox).
  - ADR-0021 §5 (perfil del proyecto), ADR-0029 (probar en el navegador es de
    `review`).
  - ADR-0034: la GUI como superficie de foco; el navegador va en el hilo y en el
    cajón de contexto.
  - ADR-0002 regla 3: Keel no bundlea el navegador, igual que con Claude Code.

## Contexto

El humano (2026-10-26):

> me gustaría ya agregar la implementación de Playwright, de primer nivel, donde
> en esta fase de prueba en el navegador, donde tomará capturas etc., lo haga en
> tiempo real en la GUI y vea qué está haciendo

Lo que hay:

- En KEEL-2, el agente probó en el navegador con lo que tenía a mano y nadie
  veía qué hacía.
- Los worktrees nacen sin dependencias. `verify_run` falló porque no había
  `node_modules`, y tampoco se puede levantar la app.
- El spike `spikes/browser-live` (2026-10-26, Chromium 156, `@playwright/mcp`
  0.0.83) midió el diseño de abajo:
  - El observador de Keel ve la página que abre el agente.
  - El primer cuadro llega entre 0.12 y 0.4 s después de cada acción.
  - Cada cuadro JPEG de 1280×800 pesa unos 20 KB, y sólo hay cuadros cuando la
    página cambia: unos 1.5 por segundo durante la prueba.
  - Sin `--password-store=basic`, Chromium se cuelga con el llavero bloqueado de
    WSL.

## Decisión

### 1. Keel es dueño del navegador

- Uno por tarea, mientras tenga un run vivo que lo use. Se lanza al primer uso y
  se cierra al terminar el run.
- Chromium sin ventana (`--headless=new`), con:
  - un perfil temporal en el estado de Keel, que se borra al cerrar;
  - el puerto de depuración sólo en `127.0.0.1` y elegido por el sistema;
  - `--password-store=basic` y `--use-mock-keychain`: nunca toca el llavero del
    humano.
- Keel no trae el navegador. Detecta el Chromium de Playwright o un Chrome
  instalado; si no hay, la GUI dice cómo instalarlo
  (`bunx playwright install chromium`, unos 400 MB).

### 2. El agente lo maneja con `@playwright/mcp`, a través de Keel

- El daemon lanza `@playwright/mcp` (versión fija) como proceso hijo, conectado
  al navegador con `--cdp-endpoint` y con `--image-responses omit`, para que las
  capturas no le gasten tokens al agente.
- El daemon es su cliente MCP. Las tools llegan al agente por el puente de Keel
  (ADR-0009) como `browser_*`, igual en Claude y en Codex.
- **Qué tools ofrece Keel:**
  - Navegar, ver el árbol de accesibilidad, hacer clic, escribir, llenar
    formularios, elegir opciones, teclas, esperar, pestañas, capturar, leer la
    consola y las peticiones de red.
  - `browser_run_code_unsafe` y `browser_evaluate` corren código arbitrario en
    la página: el gate los pregunta (ADR-0019). El humano los puede permitir con
    una regla.
  - `browser_file_upload` sólo acepta rutas del worktree de la tarea.
- **A dónde navega:** sólo al origen de la app de la tarea (§3) y a `localhost`.
  Otro origen pasa por el gate como una petición de red.
- **Etapas:** las tools del navegador no escriben en el repo. Valen en
  `implement`, en `review` (que sigue siendo de sólo lectura) y en `close`
  (ADR-0029).

### 3. La app de la tarea en su worktree

El perfil del proyecto suma dos comandos. Keel los detecta y el humano los
confirma, como el resto del perfil:

- **`setup`:** instala las dependencias, por ejemplo `bun install`.
  - Keel lo corre al crear el worktree y otra vez si cambia el lockfile.
  - Su salida va como artefacto, y un fallo se ve en el chat.
  - Esto también arregla `verify_run` en worktrees nuevos.
- **`preview`:** levanta la app.
  - Lleva el comando, la URL y una señal de listo: un patrón en la salida o la
    URL que responde.
  - Keel le asigna un puerto libre en `PORT`, para que dos tareas no choquen.
  - Lo arranca la tool `preview_start` del agente o el primer `browser_*`.
  - Se detiene al terminar el run.
  - Sus registros se pueden leer con `preview_logs`, sin volcarlos al chat.

### 4. En vivo en la GUI

- Keel abre su propia conexión CDP al navegador y pide `Page.startScreencast`
  sobre la pestaña activa: JPEG, calidad 60, como máximo 1280×800.
- **Los cuadros son efímeros.** Van como notificación `browser.frame` sólo a los
  clientes que piden `browser.watch` para el run. Nunca entran en eventos ni en
  SQLite (ADR-0004).
  - Si un cliente va lento, Keel descarta cuadros y manda el último.
  - Al conectarse, el cliente recibe el último cuadro.
- **Superficie de foco** (ADR-0020, ADR-0034 §5): el hilo es lo principal y el
  navegador no le quita lugar.
  - Cada acción del agente (navegar, clic, escribir) es una línea del hilo con
    su miniatura. Clic en la miniatura abre ese cuadro en grande como detalle
    (ADR-0034 §4): «atrás» lo cierra.
  - La vista en vivo, la URL y si la app está levantada van en la sección
    «Navegador» del cajón de contexto. El cajón se abre solo cuando el navegador
    arranca, sin quitarle el foco al compositor; si el humano lo cierra, sigue
    cerrado y el riel muestra que hay navegador en vivo.
  - La misma vista se puede abrir grande, como un lugar más de la pila.
  - Fuera de la tarea, un aviso de ADR-0034 §6 no muestra cuadros: sólo dice que
    el agente está probando en el navegador y lleva a la tarea.
- El humano mira y puede detener el run como siempre. Tomar el control del
  navegador desde la GUI queda fuera de este ADR.

### 5. Evidencia

- Cada captura que toma el agente y la última de cada navegación quedan como
  artefacto (ADR-0012), con el run, la URL y la hora.
- El QA de `review` puede citarlas, y la GUI las muestra en los documentos de la
  tarea.
- Keel cuenta los errores de consola y las peticiones fallidas de la sesión y
  los deja como evento semántico (ADR-0011). El resumen del QA los muestra,
  aunque el agente no los mencione.

## Spike antes de implementar

- Que `@playwright/mcp` y Chromium, lanzados por el daemon, se cierran al morir
  el daemon y la reconciliación los encuentra (ADR-0003 §9).
- La latencia del puente: agente → `keel mcp` → daemon → `@playwright/mcp`.
- Windows: el Chromium de Playwright, el puerto local y el screencast.
- `setup` y `preview` en Casa Matte (monorepo con Turborepo).

## Criterios de aceptación

- En `review`, el agente levanta la app con `preview_start`, navega, hace clic y
  toma una captura.
- La GUI muestra cada acción en vivo en menos de 1 s, y la captura queda como
  artefacto de la tarea.
- `browser_evaluate` pregunta. Navegar a un origen externo pregunta.
- Con el llavero bloqueado, el navegador funciona y no aparece en el llavero.
- Al terminar el run no quedan Chromium, `@playwright/mcp` ni la app.
- Un worktree nuevo corre `setup`. `verify_run` pasa sin instalar nada a mano.
- Sin Chromium instalado, la GUI dice cómo instalarlo y el run no se cae.

## Consecuencias

- El daemon suma `@playwright/mcp` y `playwright-core` (unos 33 MB en
  `node_modules`) y un proceso hijo más por tarea con navegador.
- El protocolo suma `browser.watch` y `browser.frame`, el primer flujo que no
  pasa por el log de eventos.
- El perfil del proyecto suma `setup` y `preview`. Los proyectos ya confirmados
  los ven como «por confirmar».

## Alternativas consideradas

- **Tools de navegador propias sobre `playwright-core`.** Dan más control, pero
  Keel mantendría lo que `@playwright/mcp` ya resuelve: el árbol de
  accesibilidad con referencias y la espera a que la página se asiente.
- **Dar `@playwright/mcp` directo al agente** como servidor MCP del proveedor.
  Keel no podría filtrar tools, ni verlo, ni guardar la evidencia; además, el
  proceso correría dentro del sandbox del run, que tapa D-Bus (ADR-0025 §10).
- **Un navegador con ventana en WSLg.** Se ve fuera de Keel, sin chat ni
  evidencia, y no existe igual en Windows ni en macOS.
- **Sólo capturas después de cada acción.** Es más barato, pero el humano pidió
  ver en vivo, y el screencast ya sólo manda cuadros cuando algo cambia.
- **La traza de Playwright (trace viewer) al final.** Complementa la vista en
  vivo, no la reemplaza. Puede venir después como artefacto.
