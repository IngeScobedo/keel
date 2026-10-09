# Hallazgos del spike (2026-10-08, primera corrida)

Máquina: WSL2 (Linux 6.6), Bun 1.4.2, Node 24.21, Claude Code 2.1.295 instalado en
`~/.local/bin/claude`, `@anthropic-ai/claude-agent-sdk` 0.3.295, `@openai/codex-sdk` 0.162.0,
`codex` CLI 0.162.0. Sin `ANTHROPIC_API_KEY` ni `OPENAI_API_KEY` en el entorno. El usuario tiene
sesión de suscripción en Claude Code y login de ChatGPT en Codex. **Keel no leyó ningún archivo
de credenciales**: el probe sólo apunta el SDK al binario instalado.

## Claude Agent SDK

| Pregunta | Resultado medido |
|---|---|
| ¿Corre bajo Bun? | Sí. `query()` con `pathToClaudeCodeExecutable` al `claude` del usuario, hooks in-process y un subagente, sin adaptación. (ADR-0003 §6: paridad confirmada para este probe.) |
| ¿Con qué se autenticó? | `init.apiKeySource: "none"` y la query tuvo éxito. El binario usó la sesión de `/login` del usuario. Keel no tocó nada. |
| ¿Cómo se ve la suscripción? | Llega un `rate_limit_event` con `rateLimitType`, `utilization` por ventana (`five_hour`, `seven_day`), `resetsAt` y `overageStatus`. Es el dato para la UI de «cuota» en modo `personal`. |
| ¿Qué reporta el costo? | `total_cost_usd: 0.00604` y `modelUsage[...].costUSD` con `costBasis: "list"` y `provider: "firstParty"`, **aunque no hay facturación por API**. Es una estimación a precio de lista. Conclusión para ADR-0002 §3: bajo `personal`, `cost_kind = estimated` (no `unknown`) y la UI lo etiqueta así. |
| ¿Tokens? | `usage` completo: input, output, cache_creation, cache_read, thinking_tokens, iteraciones por mensaje. Confiable. |
| ¿Identidad de subagente en mensajes? | Los mensajes del subagente traen `agent_id` (`acd80ec38e2940285`) y `parent_tool_use_id` = id del bloque `tool_use` `Agent` del mensaje padre. El padre se deriva sin heurística: `parent_derivable: true`. |
| ¿Identidad en hooks? | `SubagentStart` y `SubagentStop` traen `agent_id`, `agent_type` (`lister`) y `prompt_id`. `PreToolUse`/`PostToolUse`/`PostToolBatch` dentro del subagente traen `agent_id`. Los del hilo principal no (es el marcador de «root»). |
| Detalle a vigilar | El `toolUseID` que recibe el callback de `SubagentStart`/`SubagentStop` es un UUID (`ca769be2-…`), **no** el `toolu_…` del bloque `Agent`. Para unir hook ↔ mensaje hay que usar `agent_id`, como dicen los docs, no ese id. |
| `task_*` events | Ninguno en esta corrida (subagente en primer plano). Pendiente probar `background: true`. |
| Duraciones | `duration_ms: 1811` contra `duration_api_ms: 14044` y `wall_ms: 11252` del probe. Confirma la lección de Mirador: `duration_ms` del runtime no es tiempo de pared. |

Canal de padre resultante para ADR-0010 heredado: **canal 0 `sdk`** = `parent_tool_use_id` →
bloque `Agent` del mensaje padre → `agent_id` de ese mensaje (null = root). Certeza, sin
heurística.

## Codex SDK

| Pregunta | Resultado medido |
|---|---|
| ¿Corre bajo Bun? | Sí: `new Codex({ env })`, `startThread`, `runStreamed` emiten `thread.started` y `turn.started`. |
| ¿Con qué se autenticó? | Con el login de ChatGPT del CLI (`codex login status` → «Logged in using ChatGPT»). Keel no tocó nada. |
| ¿Terminó? | **No**: `turn.failed` con «You've hit your usage limit … try again at 10:19 PM». La cuenta del usuario estaba en su límite. No es un error de auth. |
| Pendiente | Repetir cuando se reinicie la cuota: `usage` de `turn.completed`, tipos de item y campos de id. Y verificar los términos de OpenAI para uso de suscripción vía SDK (ADR-0002, decisión abierta). |

## Qué cambia en los ADRs

- ADR-0002 §3: en modo `personal`, `cost_kind = estimated` con base «precio de lista», más la
  cuota de suscripción del `rate_limit_event`. Anotado como evidencia.
- ADR-0003 §6: paridad Bun confirmada para el Claude Agent SDK en este probe. El Codex SDK arrancó
  bien; su corrida completa queda pendiente.
- ADR-0001 §2 / ADR-0002 §4: el canal 0 `sdk` tiene forma concreta (arriba).

## Cómo reproducir

```bash
bun run spike:sdk      # captures/report-claude.json
bun run spike:codex    # captures/report-codex.json
```
