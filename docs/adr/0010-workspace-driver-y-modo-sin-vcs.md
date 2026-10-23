# ADR-0010: `WorkspaceDriver` y modo sin VCS

- **Estado:** Propuesto
- **Fecha:** 2026-10-23
- **Criticidad:** Alta
- **Relacionados:** ADR-0007 §5 (`@keel/git`), ADR-0009 (tools por MCP), SDD 02
  «Git y lanes», SDD 04 Fase 1 (deuda decidida por el humano el 2026-10-22)

## Contexto

En la Fase 0, un run `execute` exige un repositorio git y falla explícito si no
lo hay. El humano lo aceptó para cerrar esa fase y pidió desacoplar el
aislamiento para no cerrarse a flujos sin VCS: dotfiles, scratchpads, scripts
del sistema, o configuraciones donde versionar es una decisión posterior. Pidió
además que el agente pueda pasar un trabajo de «carpeta libre» a «proyecto
versionado» con tools de `@keel/git`.

## Decisión

1. **`WorkspaceDriver`** es la interfaz del daemon para preparar, capturar y
   liberar el espacio de un run: `provision`, `capture`, `release`, `kind` y sus
   garantías declaradas. Nace dentro del daemon con dos implementaciones; no se
   empaqueta hasta tener un segundo consumidor (ADR-0007 §3).
   - **`GitWorktreeDriver`:** lo de hoy (`workspaces.ts` con `@keel/git`).
     Worktree aislado, rescate en `refs/keel/rescue/`, paralelismo por lanes.
   - **`DirectFsDriver`:** el agente trabaja en la carpeta real, sin copia,
     porque ése es el caso de uso (`~/.config/nvim`).
     - **Rescate:** antes de lanzar el proveedor, un snapshot de los
       `write_scopes` declarados en `$XDG_STATE_HOME/keel/snapshots/<run>/` (tar
       más un manifest con hashes), y un comando para restaurarlo.
     - **Un escritor por carpeta:** lock por ruta canónica; no hay paralelismo.
     - Sin diff de git: la captura compara hashes del snapshot con el estado
       final.
2. **Qué driver usa un run.** Lo declara el proyecto (`vcs: git | none`).
   - Un proyecto sin git no pasa solo a `DirectFsDriver`: el humano lo confirma
     una vez por proyecto (Project Setup), porque pierde el aislamiento.
   - La UI muestra siempre «Workspace: sin control de versiones» en ese modo.
   - Sin esa confirmación sigue el comportamiento de la Fase 0: fallo explícito.
3. **Tools de `@keel/git` para el agente** (por el puente MCP de ADR-0009):
   - **Inspeccionar el entorno:** si la ruta está bajo git, si hay repos padre,
     si es `$HOME`. Sólo lectura, sin aprobación.
   - **Inicializar un repo en una ruta externa** (`~/dotfiles`). Nunca sobre
     `$HOME`: la ruta debe estar dentro de los `write_scopes` o ser nueva.
   - **Crear symlinks o el script de sincronización.** Toca rutas fuera del
     worktree, así que pasa por el inbox de aprobaciones.
   - **Vincular el repo al proyecto.** Cambia la configuración del proyecto: el
     agente lo pide y el humano lo aprueba. Desde el siguiente run, el driver
     pasa a `GitWorktreeDriver`.
4. **Las garantías no se igualan por abajo.** `DirectFsDriver` declara
   `isolation: none`, `rescue: snapshot` y `parallel: false`. El scheduler y la
   UI leen esas capacidades; ninguna regla asume aislamiento sin preguntarlo.

## Consecuencias

- Migración: `projects` gana `vcs` y la confirmación humana del modo sin VCS.
- `run_worktrees` sigue siendo de git; el modo sin VCS registra su snapshot
  aparte (`run_snapshots`) para no mezclar garantías.
- Las tools de `@keel/git` para agentes dependen de ADR-0009.

## Alternativas consideradas

- **Trabajar sobre una copia temporal y aplicar al final.** Da aislamiento, pero
  no sirve para lo que motiva este ADR: dotfiles y configs del sistema que el
  agente debe validar en su sitio (`nvim --headless`). Queda como opción futura
  del driver.
- **Inicializar git automáticamente en cualquier carpeta.** Versionar es una
  decisión del humano, y sobre `$HOME` sería dañino.
