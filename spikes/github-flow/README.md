# Spike: GitHub desde Keel con el `gh` del humano (ADR-0043)

Mide, sólo leyendo, lo que el `gh` autenticado del humano da para ver PRs,
promociones entre ramas y GitHub Actions en vivo. No hace fetch, no escribe en
el repo y no imprime el token.

```bash
bun spikes/github-flow/src/probe.ts /ruta/al/repo
```

## Resultados (2026-10-30, WSL2, gh 2.96.0, `inprodiwebstudio/zero-reports-mono`)

| Medida                                          | Valor                                  |
| ----------------------------------------------- | -------------------------------------- |
| `gh pr list` (20, con checks), mediana de 3     | 1592 ms                                |
| `gh run list` (30), mediana de 3                | 1462 ms                                |
| `gh run view --json jobs` (jobs y pasos)        | 1085 ms                                |
| Métodos de merge que el repo permite            | merge, squash y rebase                 |
| Rama por defecto                                | `main`                                 |
| Protección de ramas por API                     | HTTP 403 (repo privado sin GitHub Pro) |
| CI en PR (rama corta), mediana de 9             | 90 s                                   |
| CI en push a `main`, mediana de 7               | 97 s                                   |
| `Deploy · stage` (push a `stage`), mediana de 7 | 536 s                                  |
| `Deploy · prod` (push a `main`), mediana de 7   | 259 s                                  |

Pasos de `Deploy · prod` con su duración: promover la imagen `:stage → :prod` 26
s y rollout 205 s. El detalle por paso trae `startedAt` y `completedAt`, así que
el avance se puede ver paso a paso.

Disparadores:

- `CI`: `push [main]` y `pull_request`.
- `Deploy · stage`: `push [stage]` y `workflow_dispatch`.
- `Deploy · prod`: `push [main]` y `workflow_dispatch`.

Cómo entra el código a cada rama (últimos 200 merges de cada una):

- `development`: 26 de 28 merges son de PR (`Merge pull request #n`), con merge
  commit.
- `stage`: 15 promociones `development → stage`
  (`chore(release): promueve development a stage`).
- `main`: 8 promociones `stage → main`.

## Lo que se concluye

- `gh` alcanza para todo sin que Keel tenga un token: una lectura cuesta de 1 a
  1.6 s. Seguir un run activo cada 5 s son 720 llamadas por hora, contra 5000
  por hora del límite autenticado de GitHub.
- Los logs de un paso no llegan por la API mientras corre: en vivo se ve el paso
  en curso y su tiempo; el log, al terminar o al fallar.
- La protección de ramas no se puede leer en este repo: el flujo y las ramas
  protegidas los declara el proyecto en Keel, detectados de los workflows y de
  la historia de merges, y confirmados por el humano.
- Las promociones son merges sin PR, con un mensaje fijo. Las PR de trabajo van
  a `development` con merge commit.
