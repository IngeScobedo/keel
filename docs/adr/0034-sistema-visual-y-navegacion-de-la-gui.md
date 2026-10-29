# ADR-0034: La GUI como superficie de foco: sistema visual, controles y navegación

- **Estado:** Aceptado (2026-10-29)
- **Fecha:** 2026-10-28
- **Criticidad:** Alta
- **Relacionados:**
  - ADR-0020: el chat del run como superficie de foco. Este ADR lleva su
    principio a toda la GUI.
  - ADR-0006: estados visuales y sus colores; este ADR no cambia los 13
    visuales.
  - ADR-0005: los clientes sólo hablan el protocolo. ADR-0007: paquetes.
  - ADR-0021 y ADR-0022: etapas, documento `tasks` y subtareas.
  - ADR-0030: el navegador en vivo pasa al cajón de contexto (§5).
  - ADR-0031: las tarjetas de infraestructura.

## Contexto

El humano (2026-10-28), después de usar la GUI con Casa Matte:

> al entrar a un task esperaría que en la UI lo del repo, la parte de trabajo,
> human review sea más fácil de usar y lo más importante, que se vea bonito […]
> quiero algo neutro para que en un futuro, si se añade alguna feature de
> themes, sea fácil de implementar; los elementos como input, select… deberían
> de verse bien en cualquier OS […] si abro una referencia que abre el subtask
> KEEL-01 desde el TASK KEEL-03 y esto se repite navegando sobre referencias, al
> hacer back debo de poder regresar exactamente en ese orden pero al revés.

Pidió además: el Markdown de los agentes renderizado en la actividad, con altura
máxima y «ver detalle»; el plan como DAG; checklists que se usen; paneles con
las subtareas trabajando y las encoladas; SSH, Terraform y Ansible visuales en
el chat con el panel derecho plegado en un cajón que se abre cuando algo pide
atención; y avisos de otros proyectos que se puedan aprobar sin salir de donde
está.

Lo que hay, medido el 2026-10-28:

- **Estilos:** `styles.css` tiene 4 468 líneas globales; `tokens.css` (219) se
  genera de `docs/design/tokens.json`, exportado del canvas. Los grises tiran a
  azul (`#0e1013`, `#15181d`) y el acento es azul.
- **Controles nativos:** 24 `<select>`, 9 checkbox y 65 `<input>`. La lista
  desplegable de un `<select>` la dibuja cada sistema: GTK en WebKitGTK (Linux),
  Chromium en WebView2 (Windows) y AppKit en WKWebView (macOS). El CSS no la
  alcanza; `appearance: base-select` sólo existe en Chromium.
- **Navegación:** la página es un `useState` en `App.tsx`. «Atrás» de una tarea
  siempre va al tablero, de un run siempre a la lista de runs. No hay historia,
  ni posición de scroll, ni pestaña recordada.
- **La vista de tarea** tiene siete pestañas. En modo real, Plan, Checklist y
  Diff dicen «no disponible», y Kind, Priority y Git anchor también. La
  actividad muestra el texto de los eventos crudo.
- **Datos que ya existen y la GUI no usa:**
  - el documento `tasks` de una feature, con fases y dependencias (`after`), que
    `parseTasks` de `@keel/core` ya lee;
  - el worktree y la rama de la tarea en el manifest del run;
  - los requisitos `R<n>` del documento `spec`, con sus escenarios
    (`parseSpec`), y el veredicto del QA de `review`.
- **El spike `spikes/ui-primitives`** midió el mismo conjunto de controles con
  tres librerías sin estilos. Lo que suman sobre React, en gzip:

  | Librería                       | Suma    | Paquetes | Combobox | Drawer | Toast |
  | ------------------------------ | ------- | -------- | -------- | ------ | ----- |
  | `@base-ui/react` 1.9.0         | 65.9 KB | 6        | sí       | sí     | sí    |
  | `radix-ui` 1.8.1               | 39.6 KB | 56       | no       | no     | sí    |
  | `react-aria-components` 1.22.1 | 64.4 KB | 9        | sí       | no     | beta  |

  El bundle actual pesa 2.2 MB, casi todo Vega: la diferencia de peso no decide.

## Decisión

### 1. Tokens en dos capas y un tema neutro

- **Primitivos:** escalas sin significado (`gray-0…gray-12`, `accent-1…12` y las
  familias de estado de ADR-0006).
- **Semánticos:** lo que usan los componentes (`surface/*`, `text/*`,
  `border/*`, `accent/*`, `status/*`). Un tema es un juego de valores
  semánticos; nada más cambia.
- **El tema por defecto es neutro:** grises sin tinte y un solo acento, usado
  para el foco y la acción principal. El color se reserva para el estado
  (ADR-0006) y el diff.
- **Claro y oscuro** son los dos temas de hoy. Agregar uno es agregar un bloque
  `:root[data-theme="…"]`.
- **La fuente sigue siendo el canvas:** `docs/design/tokens.json` gana la capa
  de primitivos, y `tokens.css` se genera de ahí.
- **Un chequeo en CI** falla si un CSS fuera de `tokens.css` usa un color
  literal (`#…`, `rgb(…)`): los componentes sólo usan variables.

### 2. Controles: Base UI envuelto en `ui/`

- Keel adopta `@base-ui/react` (versión fija) para los controles con
  comportamiento:
  - select y combobox;
  - checkbox, switch y radio;
  - diálogo y cajón;
  - menú, popover y tooltip;
  - pestañas y toast.
- **Por qué Base UI:** es la única de las tres con combobox, cajón y toast, que
  son tres piezas de este ADR, e instala 6 paquetes contra 56 de Radix.
- **Los componentes de Keel** viven en `packages/gui/src/ui/` (`Select`,
  `Combobox`, `Checkbox`, `Switch`, `Dialog`, `Drawer`, `Menu`, `Tooltip`,
  `Toast`, `Tabs`, `Button`, `Input`, `TextArea`), con los tokens de §1.
- **Fuera de `ui/` nadie importa `@base-ui/react`.** Biome lo hace error
  (`noRestrictedImports`), y cambiar de librería toca una carpeta.
- Los `<input>` de texto siguen siendo nativos, con estilo propio: no tienen
  lista desplegable que dibuje el sistema.

### 3. CSS por capas y junto a su componente

- Sin CSS-in-JS en runtime ni Tailwind. CSS con variables, en capas:
  `@layer tokens, base, ui, components, views`.
- Cada componente nuevo o reescrito trae su `.css` al lado, importado desde el
  `.tsx`. `styles.css` se vacía por partes al reescribir cada vista.
- Las capas hacen predecible qué gana sin subir la especificidad. Un tema sólo
  toca `tokens`.

### 4. Navegación: una pila de lugares, como el navegador

- **Un lugar** es la vista, la entidad (tarea, run, proyecto), la pestaña, lo
  abierto encima (un detalle, el cajón) y el scroll.
- **Abrir algo apila un lugar:** una referencia, una subtarea, un run o «ver
  detalle». «Atrás» desapila y devuelve el lugar tal cual estaba: misma pestaña,
  mismo scroll y lo mismo abierto. KEEL-3 → KEEL-1 → run → «atrás» ×2 vuelve a
  KEEL-3 donde estaba.
- **«Atrás»** es el botón de la vista, `Alt+←`, el botón lateral del mouse y el
  gesto del trackpad. Se apoya en `history.pushState` y `popstate` del WebView,
  así que funciona igual en Tauri y en el navegador.
- **Cambiar de sección** desde el riel (tablero, inbox, conexiones) también
  apila.
- **Un detalle abierto encima** (Markdown completo, diff, evidencia) es un
  lugar: «atrás» lo cierra antes de salir de la vista, igual que `Esc`.
- **El breadcrumb** muestra el camino de referencias (KEEL-3 › KEEL-1 › run), y
  cada miga regresa a ese punto de la pila.
- **La pila vive en la sesión de la ventana.** No se guarda en el daemon ni
  sobrevive a cerrar la app.

### 5. La tarea como superficie de foco

La vista de tarea se ordena como el chat del run (ADR-0020): al centro lo que
pasa, a los lados sólo lo que hace falta.

- **Encabezado:** clave, título, estado, etapa del método (ADR-0021) y la acción
  que toca ahora, una sola, según el estado:
  - continuar;
  - revisar el plan de cierre;
  - aprobar lo pendiente;
  - cerrar a mano.
- **Centro:** el hilo de la tarea, con conversación, actividad y tarjetas.
  - **El Markdown del agente se renderiza.** Un bloque largo se corta a una
    altura máxima, con un degradado al final y «ver detalle», que abre el
    Markdown completo encima como lugar de §4.
  - Las tarjetas de infraestructura (ADR-0031), de git y de aprobaciones van en
    el hilo, no en un panel aparte.
- **Columna izquierda, «Trabajo»:** repo, rama, worktree y base (ADR-0028); la
  etapa y sus gates; el presupuesto con su `cost_kind`. Lo que no existe no se
  muestra: nada de «No disponible».
- **Cajón de contexto a la derecha:**
  - Contiene diff, notas, evidencia, documentos del método y el navegador en
    vivo (ADR-0030).
  - Plegado por defecto; deja un riel con un ícono por sección y un contador.
  - **Se abre solo** cuando algo pide al humano:
    - un plan de git o de cierre por aprobar;
    - un plan de despliegue;
    - el navegador que arranca.
  - **Nunca roba el foco del compositor.** Si el humano lo cierra, no se vuelve
    a abrir por el mismo motivo.
- **Plan (DAG):** el documento `tasks` de la feature, leído con `parseTasks`.
  Las fases son columnas, las dependencias son flechas y cada nodo es la
  subtarea con su estado (ADR-0006). Clic abre la subtarea y apila.
- **Checklist:** la deriva Keel con código, no la escribe el agente. Cada
  requisito `R<n>` del `spec` es una línea con sus escenarios, y se marca:
  - en una feature, cuando todas las subtareas que lo citan en `tasks` están
    `done`;
  - en una tarea sin subtareas, cuando el QA de `review` cierra con `PASS` o
    `WAIVED`.

  El humano ve qué falta y por qué.

- **Subtareas trabajando:** cada subtarea con run vivo tiene un panel con su
  etapa, la última acción y el tiempo.
  - Las encoladas van en un grupo plegado con su cuenta.
  - Al arrancar, una pasa del grupo a los paneles.
  - Las terminadas se resumen en una línea.

### 6. Avisos que se atienden donde estás

- **Un aviso aparece** cuando algo pide al humano en cualquier tarea, subtarea o
  proyecto abierto en el daemon: aprobaciones, preguntas y planes. Va como toast
  apilado y en la bandeja de «Te necesita».
- **Lo simple se responde en el aviso:** aprobar o negar un permiso, o elegir la
  opción de una pregunta, con las mismas acciones del chat (ADR-0020 §2).
- **Lo que necesita contexto** (un plan de git, un despliegue, un diff) tiene
  «Ver». Apila el lugar, cambiando de proyecto si hace falta, y «atrás» regresa
  al proyecto y al lugar de antes.
- **Cambia el protocolo:**
  - `approvals.list` acepta `all_projects: true`, sólo para clientes humanos;
  - cada aprobación lleva `project_id` y `project_name`;
  - `approvals.resolve` acepta una aprobación de otro proyecto si el cliente es
    humano;
  - el daemon avisa `attention.changed` a todos los clientes humanos, sin
    importar su proyecto activo.

### 7. Lo que no hace

- No cambia los estados ni sus colores (ADR-0006).
- No agrega un editor de temas. Deja el camino para uno.
- No reescribe todas las vistas de una vez:
  - primero la tarea (§5) y la navegación (§4);
  - después el resto, cada una cuando se toque.

## Criterios de aceptación

- **Controles.** Un `Select` y un `Combobox` de `ui/` se ven y se manejan igual
  en Linux, Windows y macOS.
  - Teclado: flechas, `Enter`, `Esc` y escribir para buscar.
  - Lector de pantalla: rol y etiqueta correctos.
- **Temas.** Cambiar de tema sólo cambia variables.
  - El chequeo de CI falla con un `#fff` en un CSS de componente.
- **Navegación.** Desde KEEL-3 se abre KEEL-1 por referencia, luego su run y
  luego un detalle. Con «atrás» cuatro veces se vuelve a KEEL-3, en la misma
  pestaña y el mismo scroll.
- **Actividad.** Un mensaje de 200 líneas del agente se ve renderizado y cortado
  con degradado. «Ver detalle» lo abre completo, y «atrás» lo cierra.
- **Cajón.** Un plan de cierre por aprobar abre el cajón solo. Cerrarlo a mano
  lo deja cerrado.
- **Plan y subtareas.**
  - El plan de una feature con tres fases dibuja el DAG con sus dependencias.
  - Una subtarea que arranca pasa del grupo de encoladas a su panel.
- **Avisos.** Con dos proyectos abiertos, una aprobación del proyecto B aparece
  estando en A y se aprueba desde el aviso. «Ver» lleva a B, y «atrás» regresa a
  A.

## Consecuencias

- La GUI suma `@base-ui/react`: unos 66 KB gzip y 6 paquetes.
- `tokens.json` y el canvas ganan la capa de primitivos, y el canvas tiene que
  reflejar el tema neutro.
- El protocolo suma `all_projects` y `attention.changed`.
- Hay un periodo con dos estilos: las vistas reescritas con `ui/` y las que aún
  usan `styles.css`.

## Alternativas consideradas

- **Radix.** Pesa 26 KB menos, pero no tiene combobox ni cajón, que habría que
  construir aparte, y son 56 paquetes.
- **React Aria Components.** Es la más rigurosa en accesibilidad e
  internacionalización y pesa lo mismo que Base UI, pero no tiene cajón y su
  toast está en beta.
- **Controles propios sin librería.** Foco, teclado, posicionamiento y lectores
  de pantalla son justo lo que cuesta hacer bien; las tres librerías ya lo
  resuelven.
- **Tailwind.** Reescribir 4 468 líneas de una vez, y los temas igual
  dependerían de variables CSS. Las capas dan lo mismo sin otra herramienta.
- **Un router con URLs (React Router, TanStack Router).** La GUI no tiene URLs
  que compartir. Una pila de lugares sobre `history` da el «atrás» exacto con
  menos.
