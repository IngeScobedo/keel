# ADR-0028: La rama base al día antes de trabajar, y sin tope de turnos ni de tiempo por defecto

- **Estado:** Aceptado (2026-10-26)
- **Fecha:** 2026-10-26
- **Criticidad:** Media
- **Relacionados:**
  - ADR-0019 §4 «Modelo y límite de turnos por run»: supersede «los valores por
    defecto siguen bajos» en lo que toca a turnos y tiempo. El modelo no cambia.
  - ADR-0002 reglas 3 y 5 (presupuesto y concurrencia con defaults bajos):
    siguen en pie; turnos y tiempo no son presupuesto.
  - ADR-0021 (el método), ADR-0010 (worktrees), ADR-0025 §4 (askpass).

## Contexto

El humano (2026-10-26):

> que avise si main está atrás de origin antes de trabajar y permita hacer pull,
> en KEEL-2 falló el run por max turns, eso quitémoslo no se ocupa o que por
> defecto esté en ilimitado

Lo que pasó:

- **KEEL-1** se trabajó sobre un `main` 149 commits atrás de `origin/main`: el
  arreglo hubo que llevarlo a la base nueva a mano, con conflictos.
- **KEEL-2** falló en implementar con `error_max_turns`: el perfil por defecto
  corta en 12 turnos, y una tarea del método usa muchos más.
- `projects.status` ya da `behind`, pero contra el `origin` que el repo conoce:
  sin `fetch` puede estar viejo, y nadie avisa.

## Decisión

### 1. La base al día antes de trabajar

- **Cuándo.** Al pulsar «Trabajar» en una tarea que va a abrir un worktree nuevo
  (su primer run, o una subtarea). Una conversación que sigue en su worktree no
  se interrumpe.
- **Qué hace Keel.** Un `git fetch` de la rama de la que sale el worktree, sin
  terminal (`GIT_TERMINAL_PROMPT=0`), con límite de tiempo. Si la llave SSH del
  humano pide frase, se la pide con `keel askpass` en la GUI, como una conexión
  (ADR-0025 §4): «sólo esta vez», «hasta cerrar Keel» o «guardar en el vault».
- **Si la base está atrás**, la GUI lo dice antes de arrancar («main está 12
  commits atrás de origin/main») con tres salidas:
  - **Actualizar y trabajar:** `git pull --ff-only` en el checkout del proyecto
    y después arranca. Si no se puede avanzar sin merge, o un cambio local
    choca, no toca nada y muestra el error de git.
  - **Trabajar igual:** arranca desde la base que hay.
  - **Cancelar.**
- **Si el fetch falla** (sin red, sin permiso), lo dice y deja trabajar igual.
- **En la cabecera**, la insignia del repo muestra `↓N` y ofrece «Actualizar» en
  cualquier momento.
- **Sólo avanza.** Keel nunca hace merge, rebase ni reset del checkout del
  humano, y nunca hace pull de una rama que no sea la actual.

### 2. Sin tope de turnos ni de tiempo por defecto

- Los perfiles de Claude y Codex arrancan **sin límite de turnos ni de tiempo**.
  El humano puede fijar un límite de turnos por run desde la GUI, como hoy.
- El presupuesto por run y por día y la concurrencia (ADR-0002 reglas 3 y 5)
  siguen igual: son la guarda de costo. Detener el run sigue a un clic.
- La GUI muestra los turnos usados.

El humano eligió también quitar el tope de tiempo (antes, 30 minutos por run) al
aceptar este ADR, el 2026-10-26.

## Criterios de aceptación

- Con `main` atrás de `origin`, «Trabajar» avisa antes de crear el worktree;
  «Actualizar y trabajar» deja `main` igual a `origin/main` y el worktree sale
  de ahí.
- Con un commit local que diverge, «Actualizar» no toca nada y muestra el error.
- Con la llave con frase y el agente SSH vacío, el fetch pide la frase en la
  GUI.
- Un run nuevo arranca sin `maxTurns` y sin tope de tiempo; uno con límite de
  turnos elegido lo respeta.

## Consecuencias

- Menos trabajo hecho sobre una base vieja y menos conflictos al integrar.
- Un run sin tope de turnos ni de tiempo puede durar más; lo acota el
  presupuesto, y el humano lo detiene cuando quiera.

## Alternativas consideradas

- **Hacer fetch y pull siempre, sin preguntar.** Toca el checkout del humano sin
  que lo decida.
- **Subir el tope a 100 turnos y el tiempo a 2 horas.** Sigue cortando tareas
  largas sin aportar una guarda que el presupuesto no dé ya.
