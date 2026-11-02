# Lo entregable del agente queda en Keel (`.keel-out/`)

- **Fecha:** 2026-11-02
- **ADR:**
  - 0012 (evidencia).
  - 0018 §3 (sandbox).
  - 0039 §3 (frontera).
  - 0044 (Claude Design, Propuesto).
- **Contexto.** El humano lo pidió después de perder la propuesta de KEEL-18:
  «si creó los archivos, que los creara donde Keel no los perdiera y la
  referencia o archivo quedara accesible, descargable o poder abrirlo desde Keel
  en el navegador».

## Qué pasó en KEEL-18

KEEL-18 (T11 de KEEL-13) pedía una propuesta visual en Claude Design. El run del
SDK no tiene la tool `Artifact` (ADR-0044), así que el agente hizo una maqueta
HTML y su captura en `/tmp/keel-18-descuentos/` y le dio esa ruta al humano. Su
frontera sólo permitía el `.md`.

- **El `/tmp` del sandbox es un `tmpfs` propio del run** (`bwrapArgs`). La
  maqueta nunca fue visible fuera del agente y se borró al terminar el run, el
  2026-10-30. La ruta que recibió el humano nunca sirvió.
- **El agente no la adjuntó.** `evidence_attach` sólo acepta archivos del
  worktree, y la frontera no lo dejaba escribir ahí.
- **Se recuperó de los eventos.** El `Write` del agente guarda el HTML entero.
  Se le aplicó la edición posterior del agente (un script de Python) y se volvió
  a renderizar la captura.

## Qué hay

- **`.keel-out/`** (`OUTPUT_DIR`, `@keel/core`): la carpeta de lo entregable,
  dentro del worktree.
  - No entra al plan de git (`buildPlan`) ni a los cambios de la tarea
    (`readChanges`).
  - La frontera de una subtarea y el canon de `close` no la reservan: la carpeta
    es de cada worktree, no la comparte ningún carril. Escribir ahí sigue
    pidiendo el permiso normal.
  - **Al terminar cada run**, antes de liberar el worktree, Keel adjunta como
    evidencia cada archivo de `.keel-out/`.
    - Las imágenes van como `screenshot` y lo demás como `document`.
    - Un archivo con el mismo contenido no se repite; uno que cambió queda como
      corrección del anterior (`supersedes_id`).
    - El tope es de 25 MB por archivo. Uno más grande no se adjunta y se avisa
      con `evidence.skipped`.
- **El método se lo dice al agente.**
  - En las etapas que editan: que escriba ahí lo entregable, que su `/tmp` es
    privado y se borra, y que nunca le dé al humano una ruta de `/tmp`.
  - En todas: «si la tarea pide Claude Design, encárgalo con `design_request`; si
    no puedes, dilo y espera al humano: no lo sustituyas con otra cosa que nadie
    pidió».
- **Abrir desde Keel.**
  - `evidence.open` (sólo humano) escribe la evidencia con su nombre y extensión
    en `<estado de Keel>/exports/` y la abre con el sistema. En WSL lo hace con
    `explorer.exe` y la ruta de Windows.
  - La GUI muestra un HTML como página, en un `iframe` con `sandbox` vacío (sin
    scripts ni red), y cada evidencia tiene «Abrir en el navegador».
- **`design.open` no abría nada.** Llamaba a `openInBrowser`, que sólo acepta
  `github.com`, así que el «Abrir» de un diseño de Claude Design no hacía nada
  desde ADR-0044. Ahora usa `openUrl` (`open-external.ts`); el protocolo ya
  exige `https://claude.ai/`.

## A decidir por el humano

- **ADR-0039 §3.** La frontera de una subtarea ya no reserva `.keel-out/`. Es
  una excepción a un ADR aceptado: si debe quedar escrita, va en un ADR que lo
  enmiende.
- **No se tocó el sandbox (ADR-0018).** Lo entregable vive en el worktree, que
  ya era escribible. Una carpeta fuera del worktree habría cambiado lo que el
  sandbox monta con escritura.
