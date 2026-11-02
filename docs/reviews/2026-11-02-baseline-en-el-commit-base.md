# El baseline de verify se mide en el commit base, y por falla

- **Fecha:** 2026-11-02
- **ADR:** 0021 §4 (Aceptado): «al entrar a `implement`, Keel captura el
  baseline» y «verde es delta-verde: no rojo nuevo frente al baseline».
- **Contexto.** El humano pidió arreglarlo («si arreglalo») tras el QA en FAIL
  de KEEL-13. Esto no cambia el ADR: cumple lo que ya pedía en los dos casos en
  que no se cumplía.

## Por qué

La revisión de la feature KEEL-13 en Casa Matte salió en FAIL con tres
bloqueantes. Dos de ellos, `hasChapters` sin uso (T7) y el test de PayPal (T9),
el gate los había dejado pasar como «ya estaba rojo». El agente de QA lo dijo
así: «That label hides failures 2 and 3, so I checked both directly».

Había dos huecos:

1. **El baseline se tomaba con el cambio puesto.**
   - Una subtarea nace ya en `implement`. Su primer `verify_run`, después de
     editar, se volvía el baseline.
   - El padre de una feature no corre nada mientras sus hijas trabajan. Su
     primer verify, al revisar con todas integradas, también se volvía el
     baseline.
   - El baseline de KEEL-13 ya traía el `TS6133 'hasChapters'`.
2. **Se comparaba el comando entero.** En Casa Matte el typecheck falla siempre
   por salidas viejas de `dist/` (620 errores `TS6305`). Un error nuevo dentro de
   un comando que ya estaba rojo no se veía.

## Qué hay

- **Huella por falla** (`failureKeys`, `@keel/core`).
  - Saca una huella de cada error de `tsc` (archivo, código y mensaje) y de cada
    test que falla (vitest, bun test, jest).
  - Las huellas no llevan número de línea ni la ruta del worktree, y las
    repetidas se numeran.
  - Si la salida no tiene un formato conocido, la huella es `null` y se compara
    el comando entero, como antes.
  - `verifyDelta` cuenta como rojo nuevo una huella que no estaba en el baseline,
    aunque el comando ya fallara. Las nuevas van en `newFailures`, que ven el
    agente (en el mensaje de Keel) y la tarjeta de verificación de la GUI.
- **El baseline en el commit base.**
  - Para el padre de una feature, el base es donde nació la rama de la feature
    (`feature.base_sha`). Para las demás tareas, donde nació su worktree.
  - Si el worktree de la tarea sigue en ese commit y limpio, se mide ahí, como al
    entrar a `implement` desde `design`.
  - Si no, se mide en un worktree desacoplado bajo
    `worktrees/.baseline/`. Keel le instala las dependencias (ADR-0030 §3) y lo
    borra al terminar.
  - Las hijas que nacen del mismo commit comparten la medición (caché en
    memoria).
- **Baselines viejos.** Un baseline sin huellas es de antes de este cambio, y por
  tanto pudo tomarse con el cambio puesto. Se vuelve a medir en el base en el
  siguiente verify. Así la nueva revisión de KEEL-13 tendrá un baseline real.
- **`nx affected`.** En el commit base no hay cambios y `nx affected` no corre
  nada. La medición del base lleva `NX_HEAD` con la cabeza de la tarea, así que
  elige los mismos proyectos que la medición actual. Otros comandos ignoran la
  variable.

## Medido

Con las salidas reales de KEEL-24 (artefactos del 2026-11-02):

| Comando   | Fallas en el baseline | Fallas ahora | Huellas nuevas |
|-----------|-----------------------|--------------|----------------|
| typecheck | 620                   | 620          | 0              |
| test      | 1                     | 16           | 15             |

En `test`, 7 de las 15 son suites que vite no pudo cargar y 6 son de
`LabPage.characterization` (264 s), lo que sugiere fallas por carga o del
entorno. Antes pasaban como «ya estaba rojo». Ahora el gate de cierre las cuenta
como rojo nuevo: hay que arreglarlas o dejar el QA en WAIVED con su
justificación.

## Lo que queda

- **Medir el base cuesta otro worktree, el `setup` y una corrida completa de
  verify.** En Casa Matte son de 12 a 41 s de instalación más la suite. La caché
  sólo vive mientras corre el daemon.
- **Tests inestables.** Una falla inestable que no salió en el baseline cuenta
  como nueva. Es lo más estricto, y preferible a esconder fallas reales. Si se
  vuelve ruido, el siguiente paso es repetir sólo las huellas nuevas antes de
  declararlas rojo nuevo.
- **Lint.** Biome y eslint no tienen huella todavía: se compara el comando
  entero.
