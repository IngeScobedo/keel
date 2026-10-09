# Inventario del canvas de pen.dev (2026-10-08)

Documento:
`C:/Users/amara/.pencil/documents/e7e51bf1-eda9-4e08-ae4f-b01377e7b2ee/untitled.pen`
(Pencil desktop en Windows). **Es la fuente de verdad visual** (ADR-0001 §6).
Los tokens están exportados en `tokens.json`. Este inventario se regenera con el
MCP `pencil` (ver `.mcp.json`).

## Cómo leerlo desde una sesión

El MCP `pencil` está registrado en `.mcp.json` de este repo
(`tools/pencil-mcp-wsl.sh` lanza el servidor que trae la app de Pencil en
Windows). Útiles:

- `get_app_state`: documento abierto, páginas y componentes.
- `execute` con `Get(document, visitor)` para estructura y
  `Export(ids, "png", "C:/…")` para exportar pantallas a PNG (rutas Windows; se
  leen desde `/mnt/c/...`).
- `TakeScreenshot` es caro; `Export` a disco y leer el PNG sale mejor.

## Páginas (id · nombre)

| id       | Página                                      | Contenido                                                                                                                                                                                                                                                                             |
| -------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Y9BNY`  | 00 Foundations                              | Color dark (fuente) y light (remap), tipografía Inter / JetBrains Mono, spacing 4px, radius 3/5/8, elevación, densidad 24/28/32, iconografía lucide 16px 1.5px, tabla de 11 estados de dominio                                                                                        |
| `hQCRP`  | 01 Components                               | ~110 componentes `ds/*` con variantes y estados                                                                                                                                                                                                                                       |
| `fcZG4`  | 02 App Shell                                | default/wide/narrow, command palette, nav tooltip, workspace/repo switcher, runtime target inspector, remote tmux sessions, remote disconnected                                                                                                                                       |
| `kH7jS`  | 03 Board                                    | default/wide/narrow, drag, empty column, virtualized, filtered empty, list view, waiting-contract-blocked, contract-released-reactive                                                                                                                                                 |
| `tbxPo`  | 04 Work Item                                | 19 pantallas: default, fresh, waiting-human, failed-run, completed-evidence, subtasks, diff tab, change formal pipeline, fast path, grilling question, qa gate verdicts, qa waiver, archive/promote canon, shared research reused, cross-finding dispatch, contract-blocked inspector |
| `DU6AK`  | 05 Run                                      | default, completed, rate-limit-killed, orphan tool call, deep nesting, timeline tab, virtualized search, cost tab, hard budget watchdog, budget exceeded emergency                                                                                                                    |
| `Cyqze`  | 06 Workbench                                | default, server starting/crashed, preview mobile, diff conflict, terminal maximized, terminal-first triple, neovim PTY, lazygit PTY, coderef discard confirm, coderef stale                                                                                                           |
| `Mn7BF`  | 07 Design Studio                            | default, before/after, overlay diff, changes requested, approved, integrated                                                                                                                                                                                                          |
| `BI9GB`  | 08 Connections                              | default, healthy config, degraded, audit pending approval, expired grant, provision user, contract hub ready-for-mock, contract breaking v2                                                                                                                                           |
| `n7vBVo` | 09 Project Setup                            | default, agent profiles editing, routing rules, budgets, federated repository matrix, shared-dir permission error                                                                                                                                                                     |
| `PSzFc`  | 10 Inbox                                    | default, duplicate merge, empty, 40+ items, postgres dry-run delta, terraform destructive plan, bash destructive impact, approval expired stale                                                                                                                                       |
| `HKe8k`  | 11 i18n Check                               | board / work-item / run con textos largos                                                                                                                                                                                                                                             |
| `E1Red`  | 12 Light Theme                              | board / work-item / run en tema claro                                                                                                                                                                                                                                                 |
| `aAtFW`  | 13 Agent Control Plane                      | profile library, profile editor, orchestration, routing simulator, quality gates, evals                                                                                                                                                                                               |
| `G95St`  | 14 Engineering Extensions DS                | ChangeStepper, ContractDependency, ResearchReuse, QaVerdict, GrillingQuestion, RuntimeIndicator, BudgetWatchdog, CodeRefActions                                                                                                                                                       |
| `eM9PK`  | 12 Keel TUI (número duplicado en el canvas) | board, inspector-grilling, live-run-tree, inbox-approvals, workbench, approval-confirm; en 80x24 y 160x40                                                                                                                                                                             |
| `mMTft`  | 15 Engineering States & Audit               | atlas de estados (default/hover/active/blocked/waiting human/error) para grilling, shared_dirs, cross finding, contract dependency, runtime remote, coderef/PTY, dry-run approval, budget watchdog; estados de disponibilidad de datos                                                |

## Cifras

| Qué                                                                 | Cuántos |
| ------------------------------------------------------------------- | ------- |
| Páginas                                                             | 17      |
| Pantallas GUI (frames `screen/*` de 1440x900, 1920x1080 y 1280x800) | ~130    |
| Pantallas TUI                                                       | 12      |
| Componentes reutilizables `ds/*`                                    | ~110    |
| Variables de diseño (con tema dark/light)                           | 107     |
| Estados de dominio en `ds/StatusDot` y `ds/StatusBadge`             | 13      |

## Pantallas de referencia (ids para exportar)

`b5QRkv` app-shell/default · `TlOCe` board/default · `ZpaXG` work-item/default ·
`MmoeB` run/default · `mtNzr` workbench/default · `u2ZZBB` design/default ·
`FTYUp` connections/default · `vBiD7` setup/default · `D9gQ61` inbox/default ·
`RfP2Z` agents/profile-library · `T2lgj` agents/orchestration · `nDAHQ`
tui/live-run-tree/160x40 · `zn5fj` work-item/change-formal-pipeline · `xoEj7`
board/waiting-contract-blocked · `IuVrl` run/hard-budget-watchdog · `l8Iq25`
inbox/postgres-dry-run-delta · `WS1Kn` setup/federated-repository-matrix ·
`A0KUDv` connections/contract-hub-ready-for-mock · `ZiiJc`
app-shell/runtime-target-inspector.

## Lo que el canvas muestra y el SDD no especifica (pendiente)

- Ingesta «Incoming» en el Inbox desde CodeRabbit, CI, e2e y Jira, con dedupe y
  «Create task».
- «Detected stack» y «Skill pack» en Project Setup; `.keel/project.yaml` (el SDD
  dice `.toml`).
- Agent Control Plane completo: perfiles versionados con evals, routing
  simulator, quality gates.
- «Approve all safe» y «Approve with scope» en el Inbox (el SDD tiene Approve
  Once / Session / Amend / Deny).
- Barra de estado con «$12.40 today»: debe llevar `cost_kind` (ADR-0002 §3).
- Nav rail de 7 entradas: board, inbox, runs, workbench, design, connections,
  docs, settings.

## Desalineaciones con el SDD que resuelve un ADR

- Vocabulario de estados: ADR-0006 (aceptado 2026-10-09). Aplicado en el canvas
  el 2026-10-09: variantes `needs_review` (ámbar, triángulo hueco) y `paused`
  (neutro, dos barras) en `ds/StatusDot` y `ds/StatusBadge` md/sm, filas nuevas
  en la tabla de Foundations, badges `Needs review` del Board y la lista
  convertidos a `needs_review`, `Needs you` sustituido por el texto real
  `Waiting for you` y añadido como chip de filtro `filter/needs_you` en las 15
  barras de filtros.
- Nombre del archivo de proyecto (`.keel/project.yaml` vs `.toml`): pendiente,
  decisión menor que se anota en el SDD cuando se implemente Project Setup.
