# ADR-0044: Una sesión interactiva de Claude Code para Claude Design, lanzada y vista desde Keel

- **Estado:** Propuesto
- **Fecha:** 2026-10-30
- **Criticidad:** Media
- **Relacionados:**
  - ADR-0002: regla 1 (no hay login: la sesión usa el de Claude Code del
    humano), regla 2 (no se leen credenciales), regla 3 (se lanza el `claude`
    instalado), regla 5 (cuenta contra el límite de runs).
  - ADR-0003 §5: tmux es el host de terminales de Keel.
  - ADR-0009 (tools MCP del agente), ADR-0019 (gate), ADR-0020 (tarjetas del
    chat), ADR-0011 (eventos), ADR-0039 (frontera de la subtarea).
  - Spike `spikes/design-session` (cifras de este ADR).

## Contexto

En KEEL-18, la subtarea T11 de casa-matte, el humano pidió la propuesta visual
en Claude Design. El agente no pudo trabajar ahí:

- Buscó la tool `DesignSync` y vio que sólo sincroniza componentes.
- Escribió un HTML en `/tmp/keel-18-descuentos/`, fuera del worktree y de su
  frontera.
- Nadie le abrió ese HTML al humano.

El humano (2026-10-30):

> se puede eso que desde keel un agente de claude haga el spawn de una terminal
> y use la terminal para claude design? que le mande el mensaje el y lo ejecute
> ya trabajando y que lo de haya se vea en keel tambien?

Lo medido en el spike (Claude Code 2.1.314):

- La tool `Artifact`, con la que Claude Code trabaja en Claude Design, no llega
  a un run del Agent SDK con ninguna configuración, ni a `claude -p`. Sólo la
  tiene la sesión interactiva.
- Una sesión interactiva en tmux, con un encargo pegado en su prompt, publicó un
  diseño privado en 24 s y dejó el link en su transcript.
- El diálogo de confianza aparece una vez por carpeta, y confiar en una carpeta
  cubre sus subcarpetas.

## Decisión

### 1. Keel lanza la sesión; el agente no

- Keel abre una sesión de `claude` interactiva por tarea en un pane de tmux
  (ADR-0003 §5) cuando el agente la pide (§2).
  - Su carpeta es el worktree de la tarea.
  - Usa el binario instalado (ADR-0002 regla 3), el login del humano (regla 1) y
    la configuración de su Claude Code. Keel no le pasa modo de permisos ni
    `--dangerously-skip-permissions`.
- **Entorno:** sin las variables `CLAUDECODE` ni `CLAUDE_CODE_*` del proceso que
  la lanza.
- **Identidad:** `--session-id` lo fija Keel, y `-n` le da un nombre con la
  clave de la tarea.
- **Límite:** cuenta como un run vivo contra `max_concurrent_runs` (regla 5). Si
  no hay lugar, el agente recibe el error y la GUI lo dice.
- **Cierre:** se cierra al cerrar la tarea o cuando el humano la cierra. Tras
  reiniciar el daemon se recupera de sus eventos y de `tmux has-session`.

### 2. El agente le habla con `design_request`

- `design_request { brief }` es una tool de Keel (ADR-0009). Keel abre la sesión
  si no existe y le pega el encargo en el prompt (bracketed paste), sin teclear
  carácter por carácter.
  - Si la sesión está en un diálogo (confianza o permiso), el encargo espera a
    que el humano lo conteste.
  - Keel no contesta diálogos por el humano.
- Cuando la sesión termina su turno, Keel avisa al agente con lo que respondió y
  los links de diseño:
  - si su run sigue vivo, como mensaje en el run;
  - si no, le da otro turno con ese mensaje.
- El encargo le recuerda a la sesión que no edite archivos del repo fuera de la
  frontera de la tarea. La garantía de integrar sólo lo de la frontera sigue
  siendo la de ADR-0022 y ADR-0039.

### 3. Lo de allá se ve en Keel

- **Transcript.** Keel lee sólo el transcript de la sesión que lanzó, el de su
  `--session-id`. Nunca lee credenciales (ADR-0002 regla 2). De él emite:
  - `design.session.event`: texto del asistente y tools usadas, resumidas;
  - `design.published`: el link de cada diseño (el `url` de un `publish`, no el
    `type_url` de la plantilla);
  - `design.session.idle`: cuando la sesión termina su turno.
- **La terminal en la GUI.** La tarea muestra la pantalla de la sesión
  (`tmux capture-pane -e`, con sus colores), refrescada mientras está a la
  vista. El humano puede:
  - mandarle teclas (Enter, Esc, flechas, números) y texto, para contestar la
    confianza y los permisos;
  - abrirla en su propia terminal con `tmux attach -t <nombre>`.
- **El link.** Cada diseño aparece con «Abrir», que lo abre en el navegador del
  humano. Sólo se abren links de `https://claude.ai/`.
- **Aviso.** Si la sesión espera al humano (confianza o permiso), la tarea queda
  con aviso hasta que conteste.

### 4. La confianza en la carpeta la da el humano, una vez

Keel no escribe en `~/.claude.json` (ADR-0002 regla 2). La primera sesión le
muestra al humano el diálogo en la terminal de la GUI. Para no repetirlo, la GUI
le sugiere confiar en la carpeta de worktrees de Keel, que cubre las de todas
las tareas.

## Criterios de aceptación

1. Desde un run, `design_request` abre la sesión en el worktree, le entrega el
   encargo y el agente recibe el link del diseño al terminar, sin que el humano
   escriba nada si su Claude Code no pide permisos. Medido en el spike: 24 s.
2. La GUI muestra la pantalla de la sesión en vivo y deja contestar el diálogo
   de confianza con teclas.
3. Con `max_concurrent_runs` lleno, `design_request` falla con el motivo.
4. El link aparece en la tarea con «Abrir» y queda en su historia.

## Consecuencias

- Una sesión interactiva gasta de la suscripción del humano igual que un run.
- Depende de tmux, como el resto de las terminales de Keel. En Windows nativo no
  hay sesión de diseño; la GUI lo dice.
- La GUI muestra la pantalla por snapshots, no un emulador de terminal completo.
  Basta para leer y contestar diálogos. Para algo más se usa `tmux attach`.
- Si Claude Code cambia el formato de su transcript, Keel deja de ver lo de
  allá, pero la terminal sigue mostrándolo. Hoy no hay otro canal.

## Alternativas consideradas

- **Que el agente use `SendMessage` hacia una sesión que abrió el humano.**
  Funciona (spike), pero el mensaje no pasa por Keel: no queda en la historia de
  la tarea. Además, una sesión en otro modo de permisos retiene los mensajes
  para que su humano los apruebe.
- **Teclear el encargo con `send-keys`.** Un salto de línea enviaría el mensaje
  a medias. El bracketed paste lo entrega entero.
- **Darle al run la tool `Artifact`.** No depende de Keel: el SDK no la expone.
- **Emulador de terminal (xterm.js) en la GUI.** Es una dependencia nueva y no
  hace falta para contestar diálogos; queda para cuando la terminal de Keel sea
  general.
