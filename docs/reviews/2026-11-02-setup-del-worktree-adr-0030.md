# Dependencias del worktree (ADR-0030 §3, `setup`) implementadas

- **Fecha:** 2026-11-02
- **ADR:** 0030 (Propuesto). El humano pidió que Keel resolviera las
  dependencias de los worktrees («se supone que keel debe de manejar eso
  correctamente, solucionalo»). Se implementó sólo el `setup` de §3. `preview`
  y el navegador siguen pendientes.

## Por qué

En el lote de KEEL-13, ningún worktree de subtarea tenía `node_modules`:

- `verify_run` fallaba igual en el baseline y después del cambio («Could not
  find Nx modules»).
- T4, T6 y T9 cerraron con QA CONCERNS sin haber verificado nada.
- T3 y T7 se detuvieron a pedir dependencias.

## Qué hay

- **Perfil.** El perfil suma `setup: { command, lockfiles, timeout_ms? }`.
  - Keel lo detecta por el lockfile y siempre con el lockfile congelado: `bun
    install --frozen-lockfile`, `pnpm install --frozen-lockfile`, `yarn` (con
    `--immutable` si es Berry), `npm ci`, `uv sync --frozen` o `poetry install
    --no-root`.
  - Un perfil confirmado antes de que existiera el campo usa el detectado. Si el
    humano lo deja vacío, no se instala nada.
- **Cuándo corre.** Keel lo corre al preparar el worktree de un run `execute`
  mientras el agente empieza, y `verify` lo espera, también el baseline.
  - Se instala una vez por worktree. Vuelve a correr si cambia un lockfile: la
    marca va en el directorio git del worktree, no en el árbol.
  - Una segunda llamada espera la que está en curso.
  - Nunca corre en el checkout del humano, sólo dentro de la carpeta de
    worktrees de Keel.
- **Salida.** La salida va como artefacto.
  - `workspace.setup_completed` / `workspace.setup_failed` aparecen en el chat.
  - Si falla con el agente vivo, Keel le dice que `verify` va a fallar por eso.
- **GUI.** El perfil muestra y deja corregir el comando de instalación.

Medido en Casa Matte (worktree temporal sobre la rama de KEEL-13): `bun install
--frozen-lockfile` instaló 2087 paquetes en 13.6 s, con el caché de bun y sin
cambiar el lockfile.

Evidencia:

- `packages/daemon/test/worktree-setup.test.ts`: detección, una vez por
  worktree, reinstalación al cambiar el lockfile, nunca en el checkout del
  humano y un fallo que no deja marca.
- `method-flow.test.ts`: `verify` espera la instalación y se instala una vez.
- `gui/test/chat-model.test.ts`.

## Pendiente

- `preview` (§3) y el navegador del agente (§1, §2, §4).
- Un worktree pesa lo que sus dependencias: unos 1.9 GB en Casa Matte, con
  hardlinks del caché de bun cuando el sistema de archivos los permite.
