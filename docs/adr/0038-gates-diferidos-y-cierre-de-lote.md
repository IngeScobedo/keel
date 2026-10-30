# ADR-0038: Gates como objetos, diferidos al cierre del lote

- **Estado:** Propuesto
- **Fecha:** 2026-10-30
- **Criticidad:** Alta
- **Relacionados:**
  - ADR-0021 §4 (verificación del perfil, baseline y delta-verde) y ADR-0029 (el
    QA después de volver): son los gates inmediatos de una tarea.
  - ADR-0022 §4 (la revisión del padre al integrar todas): es el cierre del
    lote.
  - ADR-0037 (un waiver es una decisión; un supuesto bloqueante detiene el
    cierre).
  - ADR-0015 (el merge es un plan de git aprobado), ADR-0031 (despliegue).

## Contexto

En la sesión de Casa Matte el agente dijo «lint y tests al cerrar el lote». Fue
una promesa en el chat, no algo con dueño.

Keel ya verifica:

- con `verify` del perfil y el delta contra el baseline (ADR-0021 §4);
- con el QA y su veredicto, que puede ser `WAIVED` con justificación (ADR-0021,
  ADR-0029);
- con la revisión del padre de una feature cuando todas sus subtareas se
  integran (ADR-0022 §4).

Lo que no hay: el gate como algo que se ve, se difiere con dueño y bloquea el
merge.

## Decisión

### 1. Un gate es un objeto

- Tiene su clase:
  - `typecheck`, `lint`, `tests`, `e2e`;
  - `review`, `docs`, `changelog`, `adr`, `i18n`;
  - `deploy-approval`.
- Su momento es `inmediato` o `al cierre del lote`, y su estado `pendiente`,
  `corriendo`, `pasó`, `falló` o `dispensado`.
- Lleva su evidencia (ADR-0012).
- Los comandos del perfil (`verify`) son gates `inmediatos` de cada tarea. El
  perfil declara cuáles se pueden diferir.

### 2. Diferir no es saltar

- Un gate diferido queda registrado contra el lote, con dueño.
- **El plan de merge del lote no existe** mientras haya gates sin pasar.

### 3. Dispensar sólo con decisión

- Un gate `dispensado` exige una decisión del humano con motivo (ADR-0037).
- El veredicto `WAIVED` del QA pasa a ser esa decisión.
- La dispensa queda en el reporte y en el changelog interno.

### 4. El cierre del lote

Es la revisión del padre de ADR-0022, con estos pasos:

1. La rama del lote al día y ningún carril con cambios sin commit.
2. Los gates diferidos.
3. Los supuestos bloqueantes (ADR-0037).
4. Los docs de lo tocado.
5. El changelog, generado desde las tareas, las decisiones y las invariantes (no
   desde los diffs).
6. El reporte del lote.
7. El plan de merge (ADR-0015).
8. Si el lote tiene `release`, el despliegue con aprobación (ADR-0031) y la
   verificación posterior.

La GUI lo muestra con el «no puedes mergear todavía, y por qué» arriba.

## Criterios de aceptación

- Un lote con `tests` diferido no propone el plan de merge hasta que pasa.
- Un gate fallado ofrece «crear fix» (subtarea en el lote) o «dispensar», y lo
  segundo pide una decisión con motivo.
- El changelog del lote cita sus tareas y decisiones.

## Consecuencias

- El cierre de una feature gana pasos; una feature sin gates diferidos cierra
  como hoy.
- El perfil del proyecto declara qué gates existen y cuáles se difieren.

## Alternativas consideradas

- **Dejar los gates en el texto del QA.** Es lo que pasó en la sesión: nadie los
  ve hasta que alguien lee.
- **Correr todo en cada tarea.** Sirve en proyectos chicos; en Casa Matte la
  suite completa por subtarea multiplica el tiempo del lote.
