# ADR-0007: Keel como kit — librerías reutilizables y el daemon como composición

- **Estado:** Aceptado (2026-10-23); revisado el 2026-10-22 con los comentarios
  del humano
- **Fecha:** 2026-10-22
- **Criticidad:** Alta
- **Relacionados:** ADR-0001 (`@keel/core` sin I/O), ADR-0003 (lenguajes y
  procesos), ADR-0004 (store), ADR-0005 (protocolo como frontera), SDD 02, SDD
  04 Fase 0

## Contexto

El humano pidió (2026-10-22) que las piezas de Keel sirvan para construir otros
harness y no sólo este. Que un equipo de DevOps, uno de Java o un red team pueda
tomar el motor de git y worktrees, el loop agéntico o las tools de agente, y
usarlos sin reescribirlos ni arrastrar el producto entero. También pidió que la
observabilidad o una metodología propia se integren suscribiéndose a eventos o
registrando tools, sin tocar el núcleo.

Hoy el repo tiene `@keel/core` (puro), `@keel/daemon` (store, IPC, adaptador
Claude, CLI y composición, todo en un paquete) y `@keel/gui`. La siguiente pieza
de la Fase 0 es el motor de git con worktrees aislados. Si nace dentro del
daemon, sólo se reutiliza copiándolo.

**Quién consume qué.** Los equipos que integran Keel en su trabajo (dos equipos
que unen sus partes, DevOps, un red team) casi nunca van a importar paquetes
TypeScript: se integran por el protocolo (ADR-0005), los eventos y MCP. Las
librerías sirven sobre todo a quien construye otro harness. Por eso el orden de
estabilidad es: primero el protocolo y el catálogo de eventos, después las tools
MCP y al final las APIs de las librerías.

## Decisión

1. **Dos capas.** Las _librerías_ (`@keel/<pieza>`) no toman decisiones de
   producto: no abren el store, no conocen el protocolo de clientes ni el
   lifecycle de la tarea, salvo los tipos de `@keel/core`. El _producto_
   (`@keel/daemon` y los clientes) las compone y es el único que persiste,
   publica eventos y aplica gates. Una librería nunca importa `@keel/daemon` ni
   un cliente.
2. **Catálogo inicial.** Cada librería nace como paquete cuando se implementa
   por primera vez:
   - `@keel/core` (existe): tipos, protocolo, máquinas de estado
     (`LIFECYCLE_EDGES`), correlación. Sin I/O.
   - `@keel/git` (siguiente, Fase 0): worktrees, base SHA, captura de cambios,
     limpieza recuperable y contexto para commits. Requisitos en el punto 5.
   - `@keel/agent-runtime` (cuando llegue el segundo proveedor, Codex): el
     contrato del loop agéntico. Ver punto 7.
   - `@keel/ipc` (cuando aparezca un segundo consumidor fuera del daemon):
     framing NDJSON por bytes, cliente y servidor JSON-RPC sobre socket.
   - El store (ADR-0004) y la unidad de trabajo con recibos se quedan en el
     daemon: son decisión de producto.
3. **Se extrae con el segundo consumidor, no antes.** Los módulos existentes se
   escriben sin depender del resto del daemon y pasan a su paquete cuando hay un
   segundo consumidor: `ipc/framing.ts`, `command.ts` y `payload.ts` ya tienen
   esa forma. Mover un archivo sin dependencias es barato; adivinar la API
   pública de un paquete sin consumidores no lo es.
4. **Las librerías corren en Node.** Sólo usan APIs compatibles con Node
   (`node:child_process`, `node:fs`, `node:crypto`…), nunca `Bun.*` ni `bun:*`.
   Declaran `engines.node` y `keel.runtime: "node"` en su `package.json`. El
   daemon sí usa Bun a fondo (ADR-0003 §1). CI importa cada librería con Node
   para que la regla no dependa de la disciplina de nadie.
5. **`@keel/git` se recupera sin el store de Keel.** La fuente de verdad sobre
   qué worktrees son de Keel es el propio repositorio git; el store del daemon
   es un índice:
   - Cada worktree se registra en git: un ref en un namespace propio
     (`refs/keel/runs/<run_id>`, con la base SHA) y metadatos dentro del
     worktree (`.git/worktrees/<name>/keel.json`: run, base, creado en, dueño).
   - `reconcile(repo)` reconstruye el estado desde
     `git worktree list --porcelain` y esos refs: worktrees vivos, huérfanos,
     con cambios sin guardar o con el directorio borrado. No necesita SQLite.
   - Nunca borra un worktree con cambios sin preservar: primero un commit o
     stash en un ref de rescate y después la limpieza.
   - **Concurrencia sobre el `.git` compartido.** Todos los worktrees comparten
     object store y refs, así que `fetch`, `gc`, `worktree add/prune` y las
     actualizaciones de refs compiten por los locks. La librería serializa esas
     operaciones por repositorio con una cola interna y además expone un lock
     explícito para quien orquesta varios procesos. Ante un `index.lock` o un
     lock de ref ajeno (otro proceso, el humano) reintenta con backoff acotado y
     devuelve un error tipado. Nunca borra el archivo de lock.
6. **Puntos de extensión estables:**
   - **Observabilidad = suscribirse, con semántica de entrega.** Fuera de
     proceso con `events.subscribe` (ADR-0005 §4); dentro del daemon con el
     `EventBus`. `event_seq` es monotónico; en una conexión la entrega va en
     orden, sin huecos ni duplicados (probado en K-03). Al reconectar, el
     cliente pide `after_event_seq` con el último que procesó y recibe el replay
     hasta el cursor y luego el stream. Un cliente lento se desconecta con
     `backpressure` y se recupera igual. Los `kind` son strings abiertos
     (ADR-0004 §3) con un catálogo versionado junto al protocolo.
   - **Las tools de Keel para agentes son un servidor MCP.** Crear tareas y sus
     detalles, reportar progreso, abrir issues, pedir un handoff y lanzar
     agentes se exponen como servidor MCP, no como un registro propio. Así las
     usa cualquier harness: Keel, Claude Code solo, Codex o lo que monte un red
     team. El servidor MCP traduce a comandos del protocolo. Actor
     (`agent:<run_id>`) y autoridad se aplican del lado del daemon, en la misma
     unidad de trabajo que el resto. Un agente nunca obtiene autoridad `human`
     ni `human_close` (`@keel/core`, ADR-0005 §7).
   - **Políticas** (permisos, presupuesto, concurrencia) son interfaces que el
     daemon compone con defaults bajos (ADR-0002, regla 5).
   - Cargar código de terceros dentro del proceso del daemon (plugins) **no** se
     decide aquí. Hoy la extensión de terceros es fuera de proceso, por el
     protocolo y MCP.
7. **`ProviderAdapter` se diseña ya, sin empaquetar.** Una abstracción de
   proveedor diseñada con un solo proveedor suele salir mal, así que el paquete
   espera a Codex. La interfaz sí se fija ahora dentro del daemon: ejecutar,
   cancelar, preflight de capacidades y auth, eventos normalizados hacia el
   proyector y la política de herramientas. El adaptador Claude la implementa.
   Cuando llegue Codex, mover el archivo a `@keel/agent-runtime` es barato
   (punto 3) y la interfaz se corrige con dos casos reales.
8. **Lenguajes, cada uno donde ya está decidido.** Las librerías y el daemon van
   en TypeScript (punto 4 y ADR-0003 §1). Rust va en el cascarón de Tauri
   (ADR-0003 §4), posiblemente en la TUI (Fase 4) y en el daemon sólo si se
   cumplen los disparadores medidos de ADR-0003 §6. Una implementación en otro
   lenguaje cumple el mismo contrato si pasa los fixtures de conformidad de
   `@keel/core`.
9. **Cómo se hace cumplir.** Cada librería declara `keel.dependsOn` y
   `keel.runtime` en su `package.json`, tiene README con su API pública
   (`src/index.ts`) y tests en `test/`. Biome prohíbe con `noRestrictedImports`
   que una librería importe `@keel/daemon`, un cliente o `bun:*`, como ya hace
   con `@keel/core`.

## Consecuencias

- **El producto primero.** La Fase 0 tiene que salir como un harness que
  funciona: crear tarea, worktree real, run, cambio registrado, limpieza. No
  basta con un kit bien separado y sin producto. Lo que atrae contribuciones es
  que la gente lo use; la arquitectura limpia viene detrás. El punto 3 contiene
  el coste de paquetes y builds; cualquier paquete nuevo fuera de ese criterio
  se justifica contra este riesgo.
- `@keel/git` se diseña primero como API: entradas, salidas, errores tipados,
  qué devuelve `reconcile()` tras un crash y qué hace ante locks ajenos. Después
  se cablea al daemon y a `runs.start`.
- Hace falta un catálogo de `kind` de eventos versionado junto al protocolo. Sin
  él, «suscribirse» no es un contrato.
- **Retención frente a cursor.** Con retención (ADR-0004 §6), un cursor más
  antiguo que el primer evento conservado no puede reponerse. El protocolo debe
  devolver un error explícito (`cursor_expired` con el primer `event_seq`
  disponible) en lugar de un replay incompleto. Va en ADR-0005 o en su sucesor.
- El servidor MCP y el actor `agent:<run_id>` necesitan un ADR propio. Tiene que
  decir cómo se autentica el proceso MCP ante el daemon, si la identidad viene
  de la conexión (ADR-0005 §7) y con qué credencial por run emitida por el
  daemon, y qué comandos puede pedir un agente.
- Publicar los paquetes en npm, con semver y garantías de compatibilidad, queda
  fuera de este ADR; se decide cuando haya un consumidor externo.

## Alternativas consideradas

- **Todo en el daemon y extraer después.** Es lo de hoy. Sale barato hasta que
  el código de git o del loop agéntico importa el store o el bus; entonces
  separarlo es una reescritura. Se descarta para las piezas nuevas.
- **Un paquete por módulo desde ya.** Fija APIs públicas sin consumidores y
  multiplica el trabajo de build. Se descarta por el punto 3.
- **Estado de worktrees sólo en SQLite.** Más simple, pero `@keel/git` no
  serviría sin el store de Keel y un crash dejaría worktrees que sólo Keel
  reconoce. Se descarta por el punto 5.
- **Registro de tools propio de Keel.** Sólo lo usaría Keel. MCP ya es el
  estándar que hablan Claude Code y Codex. Se descarta por el punto 6.
- **Plugins dentro del proceso como mecanismo de extensión principal.** Da más
  poder, pero mete código ajeno en el proceso que guarda la verdad y supervisa
  procesos. Se difiere; la extensión hoy va por el protocolo y MCP.
