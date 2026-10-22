# ADR-0007: Keel como kit — librerías reutilizables y el daemon como composición

- **Estado:** Propuesto
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
     limpieza recuperable y contexto para commits. Recibe rutas y opciones
     tipadas y devuelve resultados tipados; no escribe en SQLite ni emite
     eventos de Keel. El daemon persiste lo que devuelve.
   - `@keel/agent-runtime` (cuando llegue el segundo proveedor, Codex): contrato
     del loop agéntico independiente del proveedor. Un `ProviderAdapter`
     (ejecutar, cancelar, eventos normalizados), una política de herramientas
     (`canUseTool`, presupuesto) y un registro de tools custom. El adaptador
     Claude actual pasa a implementarlo.
   - `@keel/ipc` (cuando aparezca un segundo consumidor fuera del daemon):
     framing NDJSON por bytes, cliente y servidor JSON-RPC sobre socket.
   - El store (ADR-0004) y la unidad de trabajo con recibos se quedan en el
     daemon: son decisión de producto.
3. **Los módulos que ya existen no se extraen por adelantado.** Se escriben sin
   depender del resto del daemon y se mueven a su paquete cuando aparece el
   segundo consumidor: `ipc/framing.ts`, `command.ts` y `payload.ts` ya cumplen
   esa forma. Mover un archivo sin dependencias es barato; adivinar la API
   pública de un paquete sin consumidores no lo es.
4. **Puntos de extensión estables:**
   - **Observabilidad = suscribirse.** Fuera de proceso con `events.subscribe`
     (ADR-0005 §4); dentro del daemon con el `EventBus`. Los `kind` de evento
     son strings abiertos (ADR-0004 §3) con un catálogo documentado.
   - **Tools de Keel para los agentes** (crear tareas y sus detalles, reportar
     progreso, abrir issues, pedir un handoff, lanzar agentes) pasan por la
     misma unidad de trabajo que el protocolo, con actor `agent:<run_id>`. Nunca
     tienen autoridad humana: la tabla de `@keel/core` lo impide (`human` y
     `human_close` no se conceden a un agente), igual que ADR-0005 §7.
   - **Políticas** (permisos, presupuesto, concurrencia) son interfaces que el
     daemon compone con defaults bajos (ADR-0002, regla 5).
   - Cargar código de terceros dentro del proceso del daemon (plugins) **no** se
     decide aquí. Hoy la extensión de terceros es fuera de proceso, por el
     protocolo.
5. **Lenguajes, cada uno donde ya está decidido.** Las librerías y el daemon van
   en TypeScript sobre Bun (ADR-0003 §1). Rust va en el cascarón de Tauri
   (ADR-0003 §4), posiblemente en la TUI (Fase 4) y en el daemon sólo si se
   cumplen los disparadores medidos de ADR-0003 §6. Una implementación en otro
   lenguaje cumple el mismo contrato si pasa los mismos fixtures de conformidad
   de `@keel/core`.
6. **Cómo se hace cumplir.** Cada librería declara `keel.dependsOn` en su
   `package.json`, tiene README con su API pública (`src/index.ts`) y tests en
   `test/`. Biome prohíbe con `noRestrictedImports` que una librería importe
   `@keel/daemon` o un cliente, como ya hace con `@keel/core`.

## Consecuencias

- `@keel/git` se diseña primero como API (entradas, salidas, errores, qué pasa
  con un worktree tras un crash) y después se cablea al daemon y a `runs.start`.
- Hace falta un catálogo de `kind` de eventos versionado junto al protocolo. Sin
  él, «suscribirse» no es un contrato.
- Las tools de Keel para agentes requieren ampliar el modelo de actor del daemon
  (hoy sólo `human` y `system:daemon`) con `agent:<run_id>` y su autoridad.
  Probablemente sea un ADR propio.
- Publicar los paquetes en npm, con semver y garantías de compatibilidad, queda
  fuera de este ADR; se decide cuando haya un consumidor externo.
- Coste: más paquetes, más `tsconfig` y referencias de build. Se acota con la
  regla del punto 3.

## Alternativas consideradas

- **Todo en el daemon y extraer después.** Es lo de hoy. Sale barato hasta que
  el código de git o del loop agéntico importa el store o el bus; entonces
  separarlo es una reescritura. Se descarta para las piezas nuevas.
- **Un paquete por módulo desde ya.** Fija APIs públicas sin consumidores y
  multiplica el trabajo de build. Se descarta por el punto 3.
- **Plugins dentro del proceso como mecanismo de extensión principal.** Da más
  poder, pero mete código ajeno en el proceso que guarda la verdad y supervisa
  procesos. Se difiere; la vía de extensión hoy es el protocolo.
