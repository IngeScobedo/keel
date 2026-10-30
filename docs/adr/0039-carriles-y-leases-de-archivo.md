# ADR-0039: Carriles en paralelo sobre las fronteras de archivo

- **Estado:** Propuesto
- **Fecha:** 2026-10-30
- **Criticidad:** Media
- **Relacionados:**
  - ADR-0022 (fronteras de archivos disjuntas por subtarea; una a la vez por
    defecto).
  - ADR-0002, regla 5 (concurrencia con defaults bajos; subirla es acción del
    humano).
  - ADR-0010 (worktrees), ADR-0015 (plan de git), ADR-0035 (lote).

## Contexto

En la sesión de Casa Matte, el agente repartió el trabajo en «tres frentes que
no se pisan». ADR-0022 ya obliga a declarar una frontera de archivos por
subtarea y a que no se crucen, pero corre una subtarea a la vez:
`max_concurrent_runs` es 1.

## Decisión

### 1. Un carril es un grupo de subtareas cuyas fronteras se cruzan

- Keel calcula los carriles con código: las subtareas con fronteras que se
  cruzan van al mismo carril, en orden; las que no, a carriles distintos.
- La tarjeta de plan (ADR-0035) y el lote en vivo los muestran.

### 2. Paralelo sólo hasta el límite que puso el humano

- Corren tantos carriles a la vez como permita `max_concurrent_runs` (ADR-0002,
  regla 5). Con el default, uno.
- La GUI dice qué carril espera lugar y que subir el límite es decisión del
  humano.

### 3. Lease: la frontera es una reserva

- Mientras una subtarea corre, su frontera queda reservada.
- Si el agente necesita tocar algo fuera de ella, el gate lo niega y le ofrece
  pedir **handoff**: una subtarea hija en el carril dueño, con su procedencia.
- Es la regla de ADR-0022 (un diff fuera de frontera no se integra solo),
  aplicada antes de editar.

### 4. Commits por subtarea, merge por lote

Cada subtarea se integra a la rama del lote (ADR-0022). Sólo el lote va a
`main`, con su plan de merge (ADR-0038).

## Criterios de aceptación

- Tres subtareas con fronteras disjuntas y `max_concurrent_runs: 3` corren a la
  vez, cada una en su worktree. Con el límite en 1, corren de a una y la GUI
  dice por qué.
- Editar fuera de la frontera se niega con la opción de handoff.

## Consecuencias

- El paralelo depende de fronteras bien escritas. Una frontera mala se ve en el
  conflicto repetido que ya detecta ADR-0022.
- Más runs a la vez cuestan más presupuesto: el límite diario sigue aplicando.

## Alternativas consideradas

- **Paralelo por defecto.** Contradice ADR-0002, regla 5.
- **Bloqueos por archivo en vez de por frontera.** Se descubren tarde, al
  editar; la frontera se conoce desde el plan.
