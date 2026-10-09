# Spike: capacidades reales de los SDKs

Responde con datos a las tres preguntas que bloquean los ADR-0002 y ADR-0003 de
Keel:

1. **Autenticación sin tocar credenciales.** Si Keel apunta el SDK al `claude`
   instalado del usuario y no pasa API key, ¿qué reporta `init.apiKeySource`?
   ¿Funciona con la sesión de `/login` del usuario sin que Keel lea nada de
   `~/.claude.json`?
2. **Costo.** ¿Qué devuelven `total_cost_usd` y `modelUsage` bajo esa
   autenticación? ¿Es estimación, cero o nada? (`cost_kind` del SDD 03 depende
   de esto.)
3. **Identidad de agentes.** Con un subagente real: ¿llegan `agent_id` y
   `parent_tool_use_id` en los mensajes? ¿Traen `agent_id` los hooks
   `SubagentStart`/`SubagentStop`? ¿Se puede derivar el padre sin heurística?
   (Decide si ADR-0010 de Mirador se porta entero o sólo como
   `parent_source: "sdk"`.)

Y lo mismo, en su superficie, para el Codex SDK.

## Correr

```bash
bun install
bun run spike:sdk            # Claude: usa el `claude` del PATH, modelo haiku
bun run spike:sdk -- --bundled   # Claude: binario que trae el SDK
bun run spike:codex          # Codex: usa la sesión que `codex` ya tenga
```

Cada corrida escribe en `captures/` (gitignored) un NDJSON por canal (mensajes,
hooks, eventos) y un `report-<sdk>.json` con el resumen. Las capturas contienen
rutas de la máquina y texto de los agentes: se redactan antes de promoverlas a
`packages/core/__fixtures__`.

## Reglas

- No implementa login ni lee archivos de credenciales. Si no hay sesión, falla y
  lo dice.
- `settingSources: []`: no carga hooks ni settings del usuario. El spike mide el
  SDK, no la máquina.
- Modelo `haiku` y un solo subagente: el consumo tiene que parecer una persona
  usando Claude Code.
- `allowedTools` de solo lectura (`Read`, `Glob`, `Agent`).
