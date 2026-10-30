# Spike: Claude Design desde una sesión interactiva lanzada por Keel (ADR-0044)

Un run de Keel (Agent SDK) no tiene la tool `Artifact` de Claude Code, que es la
que trabaja en Claude Design. Este spike mide si una sesión interactiva de
`claude`, lanzada en tmux, recibe un encargo pegado en su prompt, trabaja en
Claude Design y deja en su transcript qué hizo y el link.

```bash
bun spikes/design-session/src/probe.ts
```

Crea un diseño privado en la cuenta del humano. Las capturas van a `captures/`
(gitignored).

## Resultados (2026-10-30, WSL2, Claude Code 2.1.314, plan Max, tmux 3.4)

Disponibilidad de la tool `Artifact` (Claude Design), al recibir el `init`:

| Cómo corre Claude                                   | `Artifact` | `DesignSync` | `SendMessage` |
| --------------------------------------------------- | ---------- | ------------ | ------------- |
| Agent SDK con la config de Keel (`strictMcpConfig`) | no         | sí           | sí            |
| Agent SDK sin `settingSources`                      | no         | sí           | sí            |
| Agent SDK con `settingSources: ["user", "project"]` | no         | sí           | sí            |
| `claude -p` (headless)                              | no         | sí           | sí            |
| `claude` interactivo en tmux                        | **sí**     | sí           | sí            |

La sesión interactiva con un encargo pegado (bracketed paste) en su prompt:

| Medida                                | Valor                                                                                         |
| ------------------------------------- | --------------------------------------------------------------------------------------------- |
| Prompt listo desde `tmux new-session` | 1.3 s (con el diálogo de confianza contestado)                                                |
| Primera tool tras pegar el encargo    | 4.1 s                                                                                         |
| Encargo terminado (`end_turn`)        | 24 s                                                                                          |
| Tools                                 | `Artifact` ×3 (quickstart, publish del tipo, publish del canvas), `Write` ×4 en su scratchpad |
| Permisos pedidos en la terminal       | 0 (el humano tiene el modo auto en su Claude Code)                                            |
| Links en el transcript                | 3: el tipo de diseño, el diseño y el mismo diseño actualizado                                 |

El diseño es el `url` de un `publish` (o el «Created … from Artifact type» de su
resultado). El `type_url` es la plantilla de Claude Design, no el diseño.

Otras medidas:

- Una sesión interactiva aparece en `ListAgents` de otra y recibe `SendMessage`;
  respondió con otro `SendMessage`.
- **Confianza en la carpeta:** el primer `claude` en una carpeta nueva pregunta
  si se confía en ella, con «No, exit» por defecto. Confiar en una carpeta cubre
  sus subcarpetas: una hija no volvió a preguntar y una hermana sí.
- Una sesión lanzada desde otra sesión de Claude Code hereda `CLAUDECODE` y
  `CLAUDE_CODE_*`. Hay que quitarlas o la sesión nueva se cree hija.
- El transcript queda en `~/.claude/projects/<cwd>/<session-id>.jsonl`, y
  `--session-id` lo fija desde fuera. Cada línea trae los `tool_use` y los
  `tool_result`, y el `stop_reason: end_turn` marca el fin del turno.
