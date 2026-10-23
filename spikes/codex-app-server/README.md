# Spike: transporte `app_server` de Codex (ADR-0008)

Mide lo que ADR-0008 deja pendiente antes de decidir el transporte `app_server`:
si `codex app-server` por stdio corre con la sesión del usuario, si sus
aprobaciones las puede contestar Keel, cómo cancela, qué pasa si muere el padre
y qué bloquea su sandbox. Compara con `@openai/codex-sdk`.

## Correr

```bash
bun install
export KEEL_SPIKE_DIR=/ruta/temporal     # repos de prueba
export KEEL_SPIKE_MODEL=gpt-5.6-luna     # el más chico que liste `models`
export KEEL_SPIKE_EFFORT=low
bun spikes/codex-app-server/src/probe.ts models    # no gasta turnos
bun spikes/codex-app-server/src/probe.ts nologin   # CODEX_HOME vacío, no gasta
bun spikes/codex-app-server/src/probe.ts turn      # 1 turno
```

Subcomandos que gastan turnos: `turn`, `approval`, `concurrent` (2),
`interrupt`, `orphan`, `sandbox`, `socket-tmp`, `dyntool` y `sdk` (2). Cada uno
escribe en `captures/` (gitignored) el NDJSON crudo, en ambos sentidos, y un
`report-<prueba>.json`. Las capturas contienen rutas de la máquina; se redactan
antes de promoverlas a fixtures.

`schema/0.162.1/methods.json` guarda la lista de métodos y el sha256 del esquema
que genera `codex app-server generate-json-schema` en esa versión. El bundle
completo pesa unos 4.4 MB y no se versiona.

## Reglas

- No implementa login ni lee archivos de credenciales (ADR-0002). Usa la sesión
  que `codex` ya tenga; si no hay, la prueba falla y lo dice.
- Los hilos del app-server se abren con `ephemeral: true` para no ensuciar el
  historial del usuario. `ThreadOptions` del SDK 0.162.0 no expone esa opción.
- Resultados y lectura: `docs/reviews/2026-10-22-spike-codex-app-server.md`.
