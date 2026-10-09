# Fixtures de Fase 1 — redactados

4,633 eventos de hooks de Claude Code 2.1.238, capturados por `@mirador/hook-bridge` entre
2026-08-20 y 2026-08-24: 15 sesiones de trabajo real, 21 kinds, con subagentes en paralelo,
workflows, un teammate, una compactación manual y 30 gates de permiso. Son **el activo de
tests del proyecto**: la correlación de `core` (ADR-008) se escribe y se testea contra estos
ficheros, no contra mocks.

## Redacción

Generados con `bun run fixtures:redact` (`packages/hook-bridge/src/redact.ts`) a partir de los
crudos de `~/.mirador/fixtures/`:

- **Identificadores**: pseudónimos deterministas que conservan la forma (hex→hex de la misma
  longitud, `toolu_`/`wf_` conservan prefijo, `nombre@team` conserva su `@`, UUID→UUID). Dos
  eventos que compartían un id lo siguen compartiendo.
- **Rutas y slugs**: reescritos palabra a palabra; usuario y nombres de proyecto desaparecen,
  la estructura y las extensiones se conservan.
- **Contenido** (prompts, comandos, stdout, resúmenes, `compact_summary`, patches…): relleno
  de la misma longitud con un hash de 8 hex del original al frente — la cardinalidad de cada
  campo sobrevive, el contenido no.
- El mapa original→redactado vive en `~/.mirador/redaction-map.json`, **fuera de git**, y hace
  la redacción estable entre corridas.

Verificado contra el original: mismas líneas por fichero, mismos conteos por kind, pares
`tool_use_id` intactos (1356 pre / 1351 post / 1351 compartidos) y cardinalidades exactas de
los campos clave:

| campo | únicos |
|---|---|
| tool_name | 15 |
| agent_id | 72 |
| agent_type | 5 |
| prompt_id | 69 |
| session_id | 15 |
| transcript_path | 15 |
| background_tasks[].type | 5 |

No se editan a mano. Para incorporar sesiones nuevas: capturar con los hooks registrados y
volver a correr `bun run fixtures:redact` (el mapa mantiene estables los valores ya vistos).
